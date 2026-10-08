'use strict';
// YooKassa: create a payment with a redirect to their page, then trust only what their API says about it.
const cfg = require('./config');

const auth = () => 'Basic ' + Buffer.from(`${cfg.ykShopId}:${cfg.ykSecret}`).toString('base64');
const rub = (n) => `${Number(n).toFixed(2)}`;

async function req(method, path, body, idem) {
  const headers = { authorization: auth(), 'content-type': 'application/json' };
  if (idem) headers['idempotence-key'] = idem;
  const r = await fetch(cfg.ykApi + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) {
    const e = new Error(`yookassa ${r.status}: ${j && j.description ? j.description : 'нет ответа'}`);
    e.yk = j;
    throw e;
  }
  return j;
}

function createPayment({ orderId, amount, description, returnUrl, email, userId }) {
  const body = {
    amount: { value: rub(amount), currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: returnUrl },
    description: description.slice(0, 128),
    metadata: { order_id: orderId, user_id: String(userId) },
  };
  if (cfg.ykReceipt) {
    // a fiscal receipt (54-FZ) needs where to send it and what was sold
    body.receipt = {
      customer: { email },
      items: [{ description: description.slice(0, 128), quantity: '1.00', amount: { value: rub(amount), currency: 'RUB' }, vat_code: cfg.ykVatCode, payment_mode: 'full_payment', payment_subject: 'service' }],
    };
    if (cfg.ykTaxSystem) body.receipt.tax_system_code = Number(cfg.ykTaxSystem);
  }
  return req('POST', '/payments', body, orderId);
}
const getPayment = (id) => req('GET', '/payments/' + encodeURIComponent(id));

module.exports = { createPayment, getPayment, rub };
