'use strict';
// One payment path for the site and the bot.
const EventEmitter = require('events');
const D = require('./db');
const B = require('./billing');
const yk = require('./yk');
const cfg = require('./config');

const events = new EventEmitter();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function start(u, packId, via, email) {
  if (!cfg.payEnabled) throw new B.Fail('pay_off', 'Оплата ещё не подключена. Напишите администратору.');
  email = String(email || u.email || '').trim();
  if (cfg.ykReceipt) {
    if (!EMAIL.test(email)) throw new B.Fail('need_email', 'Укажите e-mail: на него придёт чек.');
    if (email !== u.email) D.run('UPDATE users SET email = ? WHERE id = ?', email, u.id);
  }
  const recent = D.get('SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND created_at > ?', u.id, D.now() - 3600000).n;
  if (recent >= 20) throw new B.Fail('rate', 'Слишком много попыток оплаты за час. Попробуйте позже.');
  const { order, pack } = B.newOrder(u, packId, via);
  try {
    const p = await yk.createPayment({
      orderId: order.id, amount: pack.price, userId: u.id, email,
      description: `talk with a star // tools: пакет «${pack.name}», ${B.videos(pack.credits)}`,
      returnUrl: `${cfg.publicUrl}/paid?order=${order.id}`,
    });
    const url = p.confirmation && p.confirmation.confirmation_url;
    if (!url) throw new Error('нет ссылки на оплату');
    D.run('UPDATE orders SET yk_id = ?, url = ? WHERE id = ?', p.id, url, order.id);
    return { order: Object.assign(order, { yk_id: p.id, url }), pack, url };
  } catch (e) {
    B.markCanceled(order.id);
    console.error('[pay] create failed:', e.message);
    throw new B.Fail('pay_error', 'Не получилось открыть оплату. Попробуйте ещё раз через минуту.');
  }
}

// asks YooKassa itself: neither the browser nor an incoming notification is taken at its word
const asked = new Map(); // order -> when YooKassa was last asked, so open tabs polling together make one request
async function check(orderId, force) {
  const o = D.get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) return null;
  if (o.status !== 'pending' || !o.yk_id) return o;
  if (!force && Date.now() - (asked.get(o.id) || 0) < 2500) return o;
  asked.set(o.id, Date.now());
  if (asked.size > 5000) asked.clear();
  let p;
  try { p = await yk.getPayment(o.yk_id); } catch (e) { console.error('[pay] check failed:', e.message); return o; }
  const sameOrder = p.metadata && p.metadata.order_id === o.id;
  const sameSum = p.amount && Math.round(parseFloat(p.amount.value) * 100) === o.amount * 100 && p.amount.currency === 'RUB';
  if (p.status === 'succeeded' && p.paid && sameOrder && sameSum) {
    const r = B.markPaid(o.id);
    if (r.fresh) events.emit('paid', r.order, r.pack);
    return r.order;
  }
  if (p.status === 'canceled') { B.markCanceled(o.id); return D.get('SELECT * FROM orders WHERE id = ?', o.id); }
  return o;
}

async function webhook(body) {
  const obj = body && body.object;
  if (!obj || !obj.id || !/^payment\./.test(String(body.event || ''))) return false;
  const o = D.get('SELECT * FROM orders WHERE yk_id = ?', String(obj.id));
  if (!o) return false;
  await check(o.id, true);
  return true;
}

// orders whose notification got lost are picked up by a slow background sweep
async function sweep() {
  const open = D.all("SELECT id FROM orders WHERE status = 'pending' AND yk_id != '' AND created_at > ? AND created_at < ?", D.now() - 2 * 86400000, D.now() - 60000);
  for (const o of open.slice(0, 30)) await check(o.id);
  D.run("UPDATE orders SET status = 'canceled' WHERE status = 'pending' AND created_at < ?", D.now() - 2 * 86400000);
}

module.exports = { start, check, webhook, sweep, events, EMAIL };
