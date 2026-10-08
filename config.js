'use strict';
// Settings come from the environment; a .env file next to server.js is read first (real environment wins).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
try {
  const txt = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch (e) { /* no .env file: fine */ }

const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => { const v = parseFloat(env(k, '')); return Number.isFinite(v) ? v : d; };
const list = (k) => env(k, '').split(',').map((s) => s.trim()).filter(Boolean);

const PORT = num('PORT', 8080);
const cfg = {
  port: PORT,
  host: env('HOST', '0.0.0.0'),
  // public address of the site, used in links the bot and the payment page send back
  publicUrl: env('PUBLIC_URL', `http://localhost:${PORT}`).replace(/\/+$/, ''),
  dataDir: path.resolve(root, env('DATA_DIR', './data')),
  publicDir: path.join(root, 'public'),
  trustProxy: env('TRUST_PROXY', '1') === '1',
  corsOrigins: list('CORS_ORIGINS'),

  botToken: env('BOT_TOKEN'),
  tgApi: env('TG_API', 'https://api.telegram.org').replace(/\/+$/, ''),
  adminIds: list('ADMIN_IDS'),
  tgGetLimit: num('TG_GET_LIMIT_MB', 20) * 1048576,   // Bot API lets a bot download files up to 20 MB
  tgSendLimit: num('TG_SEND_LIMIT_MB', 50) * 1048576, // and send files up to 50 MB

  ykShopId: env('YK_SHOP_ID'),
  ykSecret: env('YK_SECRET'),
  ykApi: env('YK_API', 'https://api.yookassa.ru/v3').replace(/\/+$/, ''),
  ykReceipt: env('YK_RECEIPT', '0') === '1',
  ykVatCode: num('YK_VAT_CODE', 1),
  ykTaxSystem: env('YK_TAX_SYSTEM'),

  chromePath: env('CHROME_PATH'),
  ffmpeg: env('FFMPEG_PATH', 'ffmpeg'),
  ffprobe: env('FFPROBE_PATH', 'ffprobe'),
  renderConcurrency: Math.max(1, num('RENDER_CONCURRENCY', 1)),
  renderOrigin: env('RENDER_ORIGIN', `http://127.0.0.1:${PORT}`),
};
cfg.payEnabled = !!(cfg.ykShopId && cfg.ykSecret);
cfg.botEnabled = !!cfg.botToken;
for (const d of ['', 'jobs', 'videos', 'tmp']) fs.mkdirSync(path.join(cfg.dataDir, d), { recursive: true });
module.exports = cfg;
