'use strict';
// talk with a star // tools — the server: accounts, credits, YooKassa, the Telegram bot and server-side renders.
// No dependencies: Node 22+, plus Chrome and ffmpeg on the machine for the bot's renders.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const cfg = require('./lib/config');
const D = require('./lib/db');
const B = require('./lib/billing');
const M = require('./lib/media');
const pay = require('./lib/pay');
const rq = require('./lib/renderq');
const bot = require('./lib/bot');
const pages = require('./lib/pages');
const landing = require('./lib/landing');
const looks = require('./lib/looks');

const MAX_UPLOAD = (parseFloat(process.env.MAX_UPLOAD_MB) || 1024) * 1048576;
const routes = [];
const route = (method, pattern, handler, opts) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts: opts || {} });
};

/* ---- helpers ---- */
const send = (res, code, body, type, extra) => { res.writeHead(code, Object.assign({ 'content-type': type || 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, extra || {})); res.end(body); };
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
const html = (res, code, body) => send(res, code, body, 'text/html; charset=utf-8', { 'referrer-policy': 'no-referrer' });
function readJson(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new B.Fail('too_large', 'Слишком большой запрос.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!n) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new B.Fail('bad_json', 'Запрос не разобран.')); } });
    req.on('error', reject);
  });
}
async function saveBody(req, dest, limit) {
  let n = 0;
  const out = fs.createWriteStream(dest);
  try {
    await pipeline(req, async function* (src) { for await (const c of src) { n += c.length; if (n > limit) throw new B.Fail('too_large', `Файл больше ${Math.round(limit / 1048576)} МБ.`); yield c; } }, out);
  } catch (e) { fs.rmSync(dest, { force: true }); throw e; }
  return n;
}
const ipOf = (req) => (cfg.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress || '');
const hits = new Map();
function limit(key, max, windowMs) {
  const t = Date.now();
  const h = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (h.length >= max) { hits.set(key, h); throw new B.Fail('rate', 'Слишком часто. Подождите минуту и попробуйте снова.'); }
  h.push(t); hits.set(key, h);
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 3600000)) hits.delete(k); }, 600000).unref();
const tokenOf = (req) => { const a = req.headers.authorization || ''; return a.startsWith('Bearer ') ? a.slice(7).trim() : ''; };
const need = (req) => { const u = B.userByToken(tokenOf(req)); if (!u) throw new B.Fail('auth', 'Войдите в аккаунт.'); return u; };
const needAdmin = (req) => { const u = need(req); if (u.role !== 'admin') throw new B.Fail('forbidden', 'Только для администратора.'); return u; };

/* ---- the studio page: one file, the server only tells it where the API is ---- */
let indexCache = { mtime: 0, body: '' };
function indexHtml() {
  const f = path.join(cfg.publicDir, 'index.html');
  const st = fs.statSync(f);
  if (st.mtimeMs !== indexCache.mtime) indexCache = { mtime: st.mtimeMs, body: fs.readFileSync(f, 'utf8').replace('/*TWAS_CONFIG*/null', JSON.stringify({ api: '' })) };
  return indexCache.body;
}
// the front page describes the product; the studio itself lives at /studio
route('GET', '/', (req, res, q) => {
  // links made before the front page existed pointed at the root: keep them working
  if (q.query.get('auth') || q.query.get('render')) { res.writeHead(302, { location: '/studio?' + q.query.toString() }); return res.end(); }
  const c = publicConfig();
  const sheets = looks.metas();
  const ver = Object.fromEntries(looks.KINDS.map((k) => { const sh = looks.sheet(k); return [k, sh ? sh.ver : '0']; }));
  html(res, 200, landing.render({ packs: c.packs, settings: D.settings(), bot: c.bot, publicUrl: cfg.publicUrl, sheets, assetUrl: (n) => { const m = /^looks-(\w+)\.jpg$/.exec(n); return '/assets/' + n + (m ? '?v=' + ver[m[1]] : ''); } }));
});
route('GET', '/studio', (req, res) => { try { html(res, 200, indexHtml()); } catch (e) { send(res, 500, 'public/index.html не найден: соберите сайт или скопируйте файл из архива.'); } });
const ASSET_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };
route('GET', '/assets/:name', (req, res, q) => {
  const name = path.basename(q.params.name), type = ASSET_TYPES[path.extname(name).toLowerCase()];
  const sk = /^looks(?:-(lyric|edit|promo))?\.jpg$/.exec(name);
  const sh = sk ? looks.sheet(sk[1] || 'lyric') : null;
  const f = sk ? sh && sh.jpg : path.join(cfg.publicDir, 'assets', name);
  if (!type || !f || !fs.existsSync(f)) return send(res, 404, 'not found');
  res.writeHead(200, { 'content-type': type, 'cache-control': sk ? 'public, max-age=600' : 'public, max-age=86400' });
  fs.createReadStream(f).pipe(res);
});
route('GET', '/looks.jpg', (req, res) => {
  const f = bot.looksPath();
  if (!f) return send(res, 404, 'not found');
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=600' });
  fs.createReadStream(f).pipe(res);
});
// the label's official service badges, used by the studio and the bot's render
route('GET', '/badges/:name', (req, res, q) => {
  const m = /^([a-z]+)\.png$/.exec(q.params.name);
  const f = m ? looks.badgeFile(m[1]) : null;
  if (!f || !fs.existsSync(f)) return send(res, 404, 'not found');
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(f).pipe(res);
});
route('GET', '/healthz', (req, res) => json(res, 200, { ok: true, bot: !!bot.info().username, pay: cfg.payEnabled, render: rq.stats() }));

/* ---- public config ---- */
function publicConfig() {
  const s = D.settings();
  return {
    bot: bot.info().username || '', pay: cfg.payEnabled, receipt: cfg.ykReceipt, render: rq.available(),
    packs: B.packs(true).map(B.packView),
    settings: { offerUrl: s.offerUrl, support: s.support, labelSocials: s.labelSocials, labelTitle: s.labelTitle, badgeArt: looks.badges(), videoDays: s.videoDays, maxDuration: s.maxDuration, dailyLimit: s.dailyLimit, signupCredits: s.signupCredits, trialRes: s.trialRes, trialFps: s.trialFps, botMaxRes: s.botMaxRes, botMaxFps: s.botMaxFps },
  };
}
route('GET', '/api/config', (req, res) => json(res, 200, publicConfig()));

/* ---- sign-in through the bot ---- */
route('POST', '/api/auth/start', (req, res) => {
  limit('auth:' + ipOf(req), 12, 600000);
  if (!bot.info().username) throw new B.Fail('bot_off', 'Бот сейчас недоступен, вход временно не работает.');
  const code = D.rid(18);
  const short = String(1000 + Math.floor(Math.random() * 9000));
  D.run('INSERT INTO logins(code, short, created_at) VALUES(?,?,?)', code, short, D.now());
  json(res, 200, { code, short, url: `https://t.me/${bot.info().username}?start=login_${code}`, ttl: 600 });
});
route('GET', '/api/auth/poll', (req, res, q) => {
  const l = D.get('SELECT * FROM logins WHERE code = ?', q.query.get('code') || '');
  if (!l || D.now() - l.created_at > 660000) return json(res, 200, { status: 'expired' });
  if (l.status === 'ok' && l.token) {
    D.run("UPDATE logins SET status = 'used', token = '' WHERE code = ?", l.code);
    return json(res, 200, { status: 'ok', token: l.token });
  }
  json(res, 200, { status: l.status === 'denied' ? 'denied' : 'wait' });
});
// the one-time link the bot gives: «Открыть сайт»
route('POST', '/api/auth/exchange', async (req, res) => {
  limit('auth:' + ipOf(req), 12, 600000);
  const b = await readJson(req);
  const l = D.get('SELECT * FROM logins WHERE code = ?', String(b.code || ''));
  if (!l || l.status !== 'magic' || D.now() - l.created_at > 600000) throw new B.Fail('expired', 'Ссылка для входа устарела. Попросите у бота новую: кнопка «Сайт».');
  D.run("UPDATE logins SET status = 'used' WHERE code = ?", l.code);
  json(res, 200, { token: B.newSession(l.user_id) });
});
route('POST', '/api/auth/logout', (req, res) => { B.dropSession(tokenOf(req)); json(res, 200, { ok: true }); });

const genView = (g) => {
  const v = g.video_id ? M.getVideo(g.video_id) : null;
  return { id: g.id, source: g.source, status: g.status, res: g.res, fps: g.fps, aspect: g.aspect, dur: g.dur, title: g.title, artist: g.artist, at: g.created_at, progress: g.progress, error: g.error, video: v ? { id: v.id, url: M.videoUrl(v), size: v.size, expires: v.expires_at } : null };
};
const orderView = (o) => ({ id: o.id, pack: o.pack_name, amount: o.amount, status: o.status, at: o.created_at, via: o.via, url: o.status === 'pending' ? o.url : '' });
route('GET', '/api/me', (req, res) => {
  const u = need(req);
  json(res, 200, Object.assign(B.profile(u), {
    gens: D.all('SELECT * FROM gens WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', u.id).map(genView),
    orders: D.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', u.id).map(orderView),
  }));
});
route('POST', '/api/me/email', async (req, res) => {
  const u = need(req);
  const b = await readJson(req);
  const email = String(b.email || '').trim().slice(0, 120);
  if (email && !pay.EMAIL.test(email)) throw new B.Fail('email', 'Не похоже на e-mail.');
  D.run('UPDATE users SET email = ? WHERE id = ?', email, u.id);
  json(res, 200, { ok: true });
});

// the artist's socials: shown in the finale of every video, on the site and from the bot
route('POST', '/api/me/socials', async (req, res) => {
  const u = need(req);
  limit('soc:' + u.id, 60, 600000);
  const b = await readJson(req);
  D.run('UPDATE users SET socials = ? WHERE id = ?', B.cleanSocials(b.socials), u.id);
  json(res, 200, { ok: true });
});

/* ---- payments ---- */
route('POST', '/api/pay/create', async (req, res) => {
  const u = need(req);
  limit('pay:' + u.id, 10, 600000);
  const b = await readJson(req);
  const r = await pay.start(u, String(b.pack || ''), 'site', b.email);
  json(res, 200, { order: r.order.id, url: r.url });
});
route('GET', '/api/pay/status', async (req, res, q) => {
  limit('pays:' + ipOf(req), 900, 600000);
  const o = await pay.check(q.query.get('order') || '');
  if (!o) return json(res, 404, { error: 'Заказ не найден.' });
  json(res, 200, { status: o.status, pack: o.pack_name });
});
route('POST', '/api/yk/webhook', async (req, res) => {
  let body = {};
  try { body = await readJson(req); } catch (e) { body = {}; }
  try { await pay.webhook(body); } catch (e) { console.error('[pay] webhook:', e.message); }
  json(res, 200, { ok: true });
});

/* ---- a generation on the site: reserve, render in the browser, settle ---- */
route('POST', '/api/gen/start', async (req, res) => {
  const u = need(req);
  limit('gen:' + u.id, 30, 600000);
  const b = await readJson(req);
  const g = B.reserve(u, { source: 'site', res: Number(b.res), fps: Number(b.fps), dur: Number(b.dur), aspect: b.aspect, title: b.title, artist: b.artist, customMark: !!b.customMark, meta: { mode: String(b.mode || 'lyric').slice(0, 10) } });
  json(res, 200, { id: g.id, mark: !!g.mark });
});
route('POST', '/api/gen/finish', async (req, res) => {
  const u = need(req);
  const b = await readJson(req);
  const g = D.get('SELECT * FROM gens WHERE id = ? AND user_id = ?', String(b.id || ''), u.id);
  if (!g) throw new B.Fail('not_found', 'Генерация не найдена.');
  const s = B.settle(g.id, !!b.ok, b.ok ? '' : String(b.reason || 'error'));
  json(res, 200, { status: s.status, refunded: s.status === 'failed' || s.status === 'canceled' });
});
// «Получить ссылку»: the finished file goes to the server and gets a page of its own
route('PUT', '/api/gen/:id/video', async (req, res, q) => {
  const u = need(req);
  limit('up:' + u.id, 20, 3600000);
  const g = D.get('SELECT * FROM gens WHERE id = ? AND user_id = ?', q.params.id, u.id);
  if (!g || g.status !== 'done') throw new B.Fail('not_found', 'Сначала соберите видео.');
  if (g.video_id && M.getVideo(g.video_id)) return json(res, 200, { url: M.videoUrl(M.getVideo(g.video_id)), id: g.video_id });
  const tmp = path.join(cfg.dataDir, 'tmp', 'site_' + D.rid(8) + '.mp4');
  const n = await saveBody(req, tmp, MAX_UPLOAD);
  if (n < 1024) { fs.rmSync(tmp, { force: true }); throw new B.Fail('empty', 'Файл пуст.'); }
  const head = Buffer.alloc(12);
  const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd);
  if (head.toString('latin1', 4, 8) !== 'ftyp') { fs.rmSync(tmp, { force: true }); throw new B.Fail('not_mp4', 'Это не MP4-файл.'); }
  const v = M.store(u.id, g.id, tmp, q.query.get('name') ? String(q.query.get('name')).replace(/\.mp4$/i, '') : [g.artist, g.title].filter(Boolean).join(' - '));
  json(res, 200, { url: M.videoUrl(v), id: v.id });
});
route('POST', '/api/video/:id/send', async (req, res, q) => {
  const u = need(req);
  limit('tgsend:' + u.id, 10, 3600000);
  const v = M.getVideo(q.params.id);
  if (!v || v.user_id !== u.id) throw new B.Fail('not_found', 'Видео не найдено.');
  if (!bot.info().username) throw new B.Fail('bot_off', 'Бот сейчас недоступен.');
  const g = D.get('SELECT * FROM gens WHERE id = ?', v.gen_id) || { artist: '', title: v.name, res: 0, fps: 0, user_id: u.id };
  const info = await M.probe(M.videoPath(v));
  bot.deliver(u.tg_id, Object.assign({}, g, { user_id: 0 }), v, info).catch((e) => console.error('[bot] send:', e.message));
  json(res, 200, { ok: true });
});

/* ---- finished videos ---- */
route('GET', '/v/:id', (req, res, q) => {
  const v = M.getVideo(q.params.id);
  if (!v) return html(res, 404, pages.gone());
  D.run('UPDATE videos SET views = views + 1 WHERE id = ?', v.id);
  html(res, 200, pages.video(v, M.videoUrl(v), `${cfg.publicUrl}/v/${v.id}/file`, D.settings().videoDays));
});
route('GET', '/v/:id/file', (req, res, q) => {
  const v = M.getVideo(q.params.id);
  if (!v) return send(res, 404, 'not found');
  const file = M.videoPath(v), size = fs.statSync(file).size;
  const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
  if (q.query.get('dl')) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(v.name)}`;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let a = m[1] ? parseInt(m[1], 10) : size - parseInt(m[2], 10), b = m[1] && m[2] ? parseInt(m[2], 10) : size - 1;
    a = Math.max(0, a); b = Math.min(size - 1, b);
    if (a > b) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, Object.assign(headers, { 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1 }));
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, Object.assign(headers, { 'content-length': size }));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});

/* ---- the upload page the bot links to ---- */
route('GET', '/u/:token', (req, res, q) => html(res, bot.uploadToken(q.params.token) ? 200 : 410, bot.uploadToken(q.params.token) ? pages.upload(q.params.token, Math.round(MAX_UPLOAD / 1048576)) : pages.uploadGone()));
route('PUT', '/api/up/:token', async (req, res, q) => {
  if (!bot.uploadToken(q.params.token)) return json(res, 410, { ok: false, error: 'Ссылка устарела.' });
  limit('upb:' + q.params.token, 30, 3600000);
  const tmp = path.join(cfg.dataDir, 'tmp', 'up_' + D.rid(8));
  await saveBody(req, tmp, MAX_UPLOAD);
  json(res, 200, await bot.uploadedViaWeb(q.params.token, tmp, String(q.query.get('name') || '').slice(0, 200), req.headers['content-type'] || ''));
});
route('GET', '/paid', (req, res, q) => html(res, 200, pages.paid(String(q.query.get('order') || '').replace(/[^\w-]/g, ''), bot.info().username)));

/* ---- what the render page asks for ---- */
const job = (q) => { const l = rq.check(q.params.id, q.query.get('k')); if (!l) throw new B.Fail('forbidden', 'нет доступа'); return l; };
route('GET', '/api/render/:id/job', (req, res, q) => { const l = job(q); json(res, 200, l.job); });
route('GET', '/api/render/:id/file/:kind', (req, res, q) => {
  const l = job(q);
  const name = l.job.files[q.params.kind];
  if (!name) return send(res, 404, 'not found');
  const f = path.join(l.dir, path.basename(name));
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(f).size, 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
route('POST', '/api/render/:id/progress', async (req, res, q) => { job(q); const b = await readJson(req); rq.progress(q.params.id, b.p, b.stage); json(res, 200, { ok: true }); });
route('POST', '/api/render/:id/fail', async (req, res, q) => { job(q); const b = await readJson(req); rq.finish(q.params.id, { error: String(b.error || 'ошибка рендера').slice(0, 300) }); json(res, 200, { ok: true }); });
route('PUT', '/api/render/:id/result', async (req, res, q) => {
  const l = job(q);
  const out = path.join(l.dir, 'raw.mp4');
  const beat = setInterval(() => rq.beat(q.params.id), 10000);
  try { await saveBody(req, out, 8 * 1073741824); } finally { clearInterval(beat); }
  rq.finish(q.params.id, { file: out });
  json(res, 200, { ok: true });
});

/* ---- admin ---- */
route('GET', '/api/admin/stats', (req, res) => {
  needAdmin(req);
  const day = 86400000, t = D.now();
  const n = (sql, ...a) => D.get(sql, ...a).n;
  const days = [];
  const start = new Date(); start.setHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    const a = start.getTime() - i * day, b = a + day;
    days.push({ day: a, gens: n("SELECT COUNT(*) AS n FROM gens WHERE status = 'done' AND created_at >= ? AND created_at < ?", a, b), revenue: n("SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?", a, b), users: n('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', a, b) });
  }
  json(res, 200, {
    users: n('SELECT COUNT(*) AS n FROM users'), usersDay: n('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', t - day),
    gens: n("SELECT COUNT(*) AS n FROM gens WHERE status = 'done'"), gensDay: n("SELECT COUNT(*) AS n FROM gens WHERE status = 'done' AND created_at > ?", t - day),
    gensBot: n("SELECT COUNT(*) AS n FROM gens WHERE status = 'done' AND source = 'bot'"),
    revenue: n("SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE status = 'paid'"), revenueMonth: n("SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE status = 'paid' AND paid_at > ?", t - 30 * day),
    payers: n("SELECT COUNT(DISTINCT user_id) AS n FROM orders WHERE status = 'paid'"),
    creditsLeft: n('SELECT COALESCE(SUM(left), 0) AS n FROM lots WHERE left > 0 AND (expires_at = 0 OR expires_at > ?)', t),
    storage: M.storageBytes(), videos: n('SELECT COUNT(*) AS n FROM videos'),
    queue: rq.stats(), bot: bot.info().username || '', pay: cfg.payEnabled, days,
  });
});
const userRow = (u) => ({
  id: u.id, tg: u.tg_id, name: u.name, username: u.username, role: u.role, blocked: !!u.blocked, at: u.created_at, seen: u.last_seen, locked: cfg.adminIds.includes(u.tg_id),
  balance: D.get('SELECT COALESCE(SUM(left), 0) AS n FROM lots WHERE user_id = ? AND left > 0 AND (expires_at = 0 OR expires_at > ?)', u.id, D.now()).n,
  gens: D.get("SELECT COUNT(*) AS n FROM gens WHERE user_id = ? AND status = 'done'", u.id).n,
  paid: D.get("SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE user_id = ? AND status = 'paid'", u.id).n,
});
route('GET', '/api/admin/users', (req, res, q) => {
  needAdmin(req);
  const s = String(q.query.get('q') || '').trim().replace(/^@/, '');
  const off = Math.max(0, parseInt(q.query.get('offset'), 10) || 0);
  const like = `%${s.replace(/[%_]/g, '')}%`;
  const rows = s ? D.all('SELECT * FROM users WHERE name LIKE ? OR username LIKE ? OR tg_id = ? ORDER BY last_seen DESC LIMIT 50 OFFSET ?', like, like, s, off) : D.all('SELECT * FROM users ORDER BY last_seen DESC LIMIT 50 OFFSET ?', off);
  json(res, 200, { users: rows.map(userRow), total: D.get('SELECT COUNT(*) AS n FROM users').n });
});
route('POST', '/api/admin/user', async (req, res) => {
  const a = needAdmin(req);
  const b = await readJson(req);
  const u = B.userById(Number(b.id));
  if (!u) throw new B.Fail('not_found', 'Пользователь не найден.');
  if (b.role === 'admin' || b.role === 'artist') {
    if (u.id === a.id && b.role !== 'admin') throw new B.Fail('self', 'Нельзя снять роль администратора с самого себя.');
    if (cfg.adminIds.includes(u.tg_id) && b.role !== 'admin') throw new B.Fail('locked', 'Этот администратор задан в настройках сервера (ADMIN_IDS).');
    D.run('UPDATE users SET role = ? WHERE id = ?', b.role, u.id);
    D.audit(a.id, 'role', { user: u.id, role: b.role });
  }
  if (typeof b.blocked === 'boolean') {
    if (u.id === a.id) throw new B.Fail('self', 'Нельзя заблокировать самого себя.');
    D.run('UPDATE users SET blocked = ? WHERE id = ?', b.blocked ? 1 : 0, u.id);
    if (b.blocked) D.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    D.audit(a.id, 'block', { user: u.id, blocked: b.blocked });
  }
  if (b.grant) {
    const n = Math.floor(Number(b.grant.credits));
    if (!(n > 0) || n > 1000) throw new B.Fail('bad', 'Количество видео: от 1 до 1000.');
    const maxRes = [720, 1080, 1440, 2160].includes(Number(b.grant.maxRes)) ? Number(b.grant.maxRes) : 2160;
    const maxFps = [30, 60, 120].includes(Number(b.grant.maxFps)) ? Number(b.grant.maxFps) : 60;
    const days = Math.max(0, Math.min(3650, Math.floor(Number(b.grant.days)) || 0));
    B.addLot(u.id, { name: String(b.grant.name || 'Подарок').slice(0, 40), total: n, maxRes, maxFps, mark: 0, days, source: 'grant' });
    D.audit(a.id, 'grant', { user: u.id, credits: n, maxRes, maxFps, days });
    if (cfg.botEnabled) require('./lib/tg').quiet(require('./lib/tg').send(u.tg_id, `Вам начислено ${B.videos(n)}: до ${B.resName(maxRes)} и ${maxFps} кадр/с.`));
  }
  if (b.revokeLot) {
    D.run('UPDATE lots SET left = 0 WHERE id = ? AND user_id = ?', Number(b.revokeLot), u.id);
    D.audit(a.id, 'revoke', { user: u.id, lot: Number(b.revokeLot) });
  }
  json(res, 200, { user: userRow(B.userById(u.id)), lots: B.profile(B.userById(u.id)).lots });
});
route('GET', '/api/admin/userinfo', (req, res, q) => {
  needAdmin(req);
  const u = B.userById(Number(q.query.get('id')));
  if (!u) throw new B.Fail('not_found', 'Пользователь не найден.');
  json(res, 200, { user: userRow(u), lots: B.profile(u).lots, gens: D.all('SELECT * FROM gens WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', u.id).map(genView), orders: D.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', u.id).map(orderView) });
});
route('GET', '/api/admin/packs', (req, res) => { needAdmin(req); json(res, 200, { packs: B.packs(false).map(B.packView) }); });
route('POST', '/api/admin/pack', async (req, res) => {
  const a = needAdmin(req);
  const b = await readJson(req);
  const id = String(b.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'p' + D.rid(4).toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = String(b.name || '').trim().slice(0, 40);
  const price = Math.floor(Number(b.price)), credits = Math.floor(Number(b.credits));
  if (!name) throw new B.Fail('bad', 'У пакета должно быть название.');
  if (!(price >= 1 && price <= 1000000)) throw new B.Fail('bad', 'Цена: от 1 до 1 000 000 ₽.');
  if (!(credits >= 1 && credits <= 10000)) throw new B.Fail('bad', 'Количество видео: от 1 до 10 000.');
  const maxRes = [720, 1080, 1440, 2160].includes(Number(b.maxRes)) ? Number(b.maxRes) : 1080;
  const maxFps = [30, 60, 120].includes(Number(b.maxFps)) ? Number(b.maxFps) : 60;
  const days = Math.max(0, Math.min(3650, Math.floor(Number(b.days)) || 0));
  D.run(`INSERT INTO packs(id, name, descr, price, credits, max_res, max_fps, days, mark, active, sort) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, descr = excluded.descr, price = excluded.price, credits = excluded.credits, max_res = excluded.max_res, max_fps = excluded.max_fps, days = excluded.days, mark = excluded.mark, active = excluded.active, sort = excluded.sort`,
  id, name, String(b.descr || '').slice(0, 160), price, credits, maxRes, maxFps, days, b.mark ? 1 : 0, b.active === false ? 0 : 1, Math.floor(Number(b.sort)) || 0);
  D.audit(a.id, 'pack', { id, price, credits });
  json(res, 200, { packs: B.packs(false).map(B.packView) });
});
route('GET', '/api/admin/settings', (req, res) => { needAdmin(req); json(res, 200, { settings: D.settings() }); });
route('POST', '/api/admin/settings', async (req, res) => {
  const a = needAdmin(req);
  const b = await readJson(req);
  D.setSettings(b.settings || {});
  D.audit(a.id, 'settings', b.settings || {});
  json(res, 200, { settings: D.settings() });
});
// a sheet with every style of a mode, drawn in the admin's browser: the bot shows it, the main page cuts it into tiles
route('PUT', '/api/admin/looks', async (req, res, q) => {
  const a = needAdmin(req);
  const kind = q.query.get('kind') || 'lyric';
  if (!looks.KINDS.includes(kind)) throw new B.Fail('bad', 'Неизвестный режим.');
  let meta = null;
  try { meta = JSON.parse(Buffer.from(String(req.headers['x-looks-meta'] || ''), 'base64').toString('utf8')); } catch (e) { meta = null; }
  if (!looks.valid(meta)) throw new B.Fail('bad', 'К листу нужно описание: размеры и список стилей.');
  const tmp = path.join(cfg.dataDir, 'tmp', 'looks_' + D.rid(6));
  await saveBody(req, tmp, 8 * 1048576);
  const head = Buffer.alloc(3);
  const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 3, 0); fs.closeSync(fd);
  if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) { fs.rmSync(tmp, { force: true }); throw new B.Fail('bad', 'Нужна картинка JPEG.'); }
  looks.save(kind, tmp, meta);
  D.audit(a.id, 'looks', { kind, n: meta.styles.length });
  json(res, 200, { ok: true });
});
route('PUT', '/api/admin/badge', async (req, res, q) => {
  const a = needAdmin(req);
  const id = q.query.get('id') || '';
  const f = looks.badgeFile(id);
  if (!f) throw new B.Fail('bad', 'Неизвестная площадка.');
  const tmp = path.join(cfg.dataDir, 'tmp', 'badge_' + D.rid(6));
  await saveBody(req, tmp, 2 * 1048576);
  const head = Buffer.alloc(8);
  const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
  if (head.toString('hex') !== '89504e470d0a1a0a') { fs.rmSync(tmp, { force: true }); throw new B.Fail('bad', 'Нужна картинка PNG.'); }
  fs.renameSync(tmp, f);
  D.audit(a.id, 'badge', { id });
  json(res, 200, { badges: looks.badges() });
});
route('DELETE', '/api/admin/badge', (req, res, q) => {
  const a = needAdmin(req);
  const f = looks.badgeFile(q.query.get('id') || '');
  if (!f) throw new B.Fail('bad', 'Неизвестная площадка.');
  fs.rmSync(f, { force: true });
  D.audit(a.id, 'badge_drop', { id: q.query.get('id') });
  json(res, 200, { badges: looks.badges() });
});
route('GET', '/api/admin/orders', (req, res) => {
  needAdmin(req);
  json(res, 200, { orders: D.all('SELECT o.*, u.name AS uname, u.username AS uuser FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 100').map((o) => Object.assign(orderView(o), { user: o.uname, username: o.uuser, url: '' })) });
});
route('GET', '/api/admin/gens', (req, res) => {
  needAdmin(req);
  json(res, 200, { gens: D.all('SELECT g.*, u.name AS uname, u.username AS uuser FROM gens g JOIN users u ON u.id = g.user_id ORDER BY g.created_at DESC LIMIT 100').map((g) => Object.assign(genView(g), { user: g.uname, username: g.uuser })) });
});

/* ---- the server ---- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  if (origin && cfg.corsOrigins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('access-control-max-age', '86400');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try { await r.handler(req, res, { params, query: url.searchParams }); }
    catch (e) {
      if (e instanceof B.Fail) { if (!res.headersSent) json(res, { auth: 401, forbidden: 403, not_found: 404, rate: 429, too_large: 413 }[e.code] || 400, Object.assign({ error: e.message, code: e.code }, e.extra)); }
      else { console.error('[http]', req.method, url.pathname, e); if (!res.headersSent) json(res, 500, { error: 'Ошибка сервера. Попробуйте ещё раз.', code: 'server' }); }
      if (!res.writableEnded) res.end();
    }
    return;
  }
  send(res, 404, 'not found');
});
server.requestTimeout = 0; // long uploads of finished videos
server.headersTimeout = 60000;

function sweep() {
  try { B.sweepStale(); M.sweep(); } catch (e) { console.error('[sweep]', e); }
  if (cfg.payEnabled) pay.sweep().catch((e) => console.error('[pay] sweep:', e.message));
}
server.listen(cfg.port, cfg.host, () => {
  console.log(`[http] ${cfg.publicUrl} (port ${cfg.port})`);
  console.log(`[cfg] оплата: ${cfg.payEnabled ? 'ЮKassa' : 'выключена (нет YK_SHOP_ID / YK_SECRET)'} · рендер: ${rq.available() ? 'Chrome найден' : 'Chrome не найден'} · ffmpeg: ${M.tools.ffmpeg ? 'есть' : 'нет'} · админы: ${cfg.adminIds.join(', ') || 'не заданы (ADMIN_IDS)'}`);
  bot.start().then(() => rq.recover());
  sweep();
  setInterval(sweep, 600000).unref();
});
function bye() { bot.stop(); rq.shutdown(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
