'use strict';
// Accounts, credit lots, limits and the life of one generation.
const D = require('./db');
const cfg = require('./config');

const DAY = 86400000;
class Fail extends Error {
  constructor(code, message, extra) { super(message); this.code = code; this.extra = extra || {}; }
}
const resName = (r) => (r >= 2160 ? '4K' : r + 'p');
const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return `${n} ${a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b >= 2 && b <= 4 ? f[1] : f[2]}`; };
const videos = (n) => plural(n, ['видео', 'видео', 'видео']);

/* ---- people ---- */
function upsertTgUser(from) {
  const tg = String(from.id);
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 80) || from.username || 'Артист';
  const username = (from.username || '').slice(0, 64);
  return D.tx(() => {
    let u = D.get('SELECT * FROM users WHERE tg_id = ?', tg);
    if (!u) {
      const role = cfg.adminIds.includes(tg) ? 'admin' : 'artist';
      const r = D.run('INSERT INTO users(tg_id, username, name, role, created_at, last_seen) VALUES(?,?,?,?,?,?)', tg, username, name, role, D.now(), D.now());
      u = D.get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
      const s = D.settings();
      if (s.signupCredits > 0) {
        addLot(u.id, { name: 'Пробный', total: s.signupCredits, maxRes: s.trialRes, maxFps: s.trialFps, mark: s.trialMark ? 1 : 0, days: s.trialDays, source: 'signup' });
      }
      u.isNew = true;
    } else {
      // the list in ADMIN_IDS always wins: it is the way back in if roles get mixed up
      const role = cfg.adminIds.includes(tg) ? 'admin' : u.role;
      D.run('UPDATE users SET username = ?, name = ?, role = ?, last_seen = ? WHERE id = ?', username, name, role, D.now(), u.id);
      u = Object.assign(u, { username, name, role });
    }
    return u;
  });
}
const userById = (id) => D.get('SELECT * FROM users WHERE id = ?', id);
const userByTg = (tg) => D.get('SELECT * FROM users WHERE tg_id = ?', String(tg));

/* ---- sessions ---- */
function newSession(userId) {
  const token = D.rid(32);
  D.run('INSERT INTO sessions(hash, user_id, created_at, expires_at) VALUES(?,?,?,?)', D.sha(token), userId, D.now(), D.now() + 60 * DAY);
  return token;
}
function userByToken(token) {
  if (!token) return null;
  const s = D.get('SELECT * FROM sessions WHERE hash = ?', D.sha(token));
  if (!s || s.expires_at < D.now()) return null;
  const u = userById(s.user_id);
  if (u && D.now() - u.last_seen > 600000) D.run('UPDATE users SET last_seen = ? WHERE id = ?', D.now(), u.id);
  return u;
}
const dropSession = (token) => D.run('DELETE FROM sessions WHERE hash = ?', D.sha(token || ''));

/* ---- lots ---- */
function addLot(userId, o) {
  const exp = o.days > 0 ? D.now() + o.days * DAY : 0;
  const r = D.run('INSERT INTO lots(user_id, pack_id, name, total, left, max_res, max_fps, mark, source, order_id, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    userId, o.packId || '', o.name, o.total, o.total, o.maxRes, o.maxFps, o.mark ? 1 : 0, o.source, o.orderId || '', D.now(), exp);
  return Number(r.lastInsertRowid);
}
const liveLots = (userId) => D.all('SELECT * FROM lots WHERE user_id = ? AND left > 0 AND (expires_at = 0 OR expires_at > ?) ORDER BY max_res, max_fps, CASE WHEN expires_at = 0 THEN 1 ELSE 0 END, expires_at, id', userId, D.now());
function caps(u) {
  if (u.role === 'admin') return { unlimited: true, balance: null, maxRes: 2160, maxFps: 120, mark: false, pro: true };
  const lots = liveLots(u.id);
  return {
    unlimited: false,
    balance: lots.reduce((a, l) => a + l.left, 0),
    maxRes: lots.reduce((a, l) => Math.max(a, l.max_res), 0),
    maxFps: lots.reduce((a, l) => Math.max(a, l.max_fps), 0),
    mark: lots.length > 0 && lots.every((l) => l.mark),
    pro: lots.some((l) => !l.mark),
  };
}
const pickLot = (u, res, fps) => liveLots(u.id).find((l) => l.max_res >= res && l.max_fps >= fps) || null;
const usedToday = (userId) => D.get("SELECT COUNT(*) AS n FROM gens WHERE user_id = ? AND created_at > ? AND status NOT IN ('failed', 'canceled')", userId, D.now() - DAY).n;
const refundsToday = (userId) => D.get("SELECT COUNT(*) AS n FROM gens WHERE user_id = ? AND source = 'site' AND created_at > ? AND status IN ('failed', 'canceled')", userId, D.now() - DAY).n;

function profile(u) {
  const s = D.settings();
  return {
    user: { id: u.id, name: u.name, username: u.username, role: u.role, email: u.email || '', blocked: !!u.blocked, socials: u.socials || '' },
    caps: caps(u),
    lots: liveLots(u.id).map((l) => ({ id: l.id, name: l.name, left: l.left, total: l.total, maxRes: l.max_res, maxFps: l.max_fps, mark: !!l.mark, expires: l.expires_at })),
    limits: { usedToday: usedToday(u.id), dailyLimit: s.dailyLimit, maxDuration: s.maxDuration, videoDays: s.videoDays, botMaxRes: s.botMaxRes, botMaxFps: s.botMaxFps },
  };
}

/* ---- generation: reserve one credit, then settle ---- */
function reserve(u, o) {
  const s = D.settings();
  const res = [720, 1080, 1440, 2160].includes(o.res) ? o.res : 1080;
  const fps = [30, 60, 120].includes(o.fps) ? o.fps : 30;
  const dur = Math.max(0, Number(o.dur) || 0);
  if (u.blocked) throw new Fail('blocked', 'Аккаунт заблокирован. Напишите в поддержку.');
  if (dur > s.maxDuration + 1) throw new Fail('too_long', `Трек длиннее лимита: до ${Math.round(s.maxDuration / 60)} минут на одно видео.`);
  return D.tx(() => {
    const admin = u.role === 'admin';
    if (!admin && usedToday(u.id) >= s.dailyLimit) throw new Fail('daily', `Дневной лимит исчерпан: ${videos(s.dailyLimit)} за 24 часа. Попробуйте позже.`);
    if (o.source === 'bot') {
      const busy = D.get("SELECT COUNT(*) AS n FROM gens WHERE user_id = ? AND source = 'bot' AND status IN ('queued', 'rendering')", u.id).n;
      if (busy >= (admin ? 3 : 1)) throw new Fail('busy', 'Предыдущее видео ещё собирается. Дождитесь его, и можно запускать следующее.');
      const q = D.get("SELECT COUNT(*) AS n FROM gens WHERE source = 'bot' AND status IN ('queued', 'rendering')").n;
      if (q >= s.queueMax) throw new Fail('queue', 'Очередь сейчас переполнена. Попробуйте через несколько минут.');
      if (res > s.botMaxRes || fps > s.botMaxFps) throw new Fail('bot_quality', `В боте доступно до ${resName(s.botMaxRes)} и ${s.botMaxFps} кадров. Выше — на сайте.`);
    }
    let lot = null;
    if (!admin) {
      const lots = liveLots(u.id);
      if (!lots.length) throw new Fail('no_credits', 'На балансе нет видео. Выберите пакет, чтобы продолжить.');
      // a video with a custom corner mark is paid from a pack that allows it
      const fits = lots.filter((l) => l.max_res >= res && l.max_fps >= fps);
      lot = (o.customMark && fits.find((l) => !l.mark)) || fits[0] || null;
      if (lot && o.customMark && lot.mark) throw new Fail('mark', 'Свой знак в углу доступен в платных пакетах. Верните штатный знак или выберите пакет.');
      if (!lot) {
        const best = lots.reduce((a, l) => (l.max_res * 1000 + l.max_fps > a.max_res * 1000 + a.max_fps ? l : a));
        throw new Fail('quality', `Ваш пакет «${best.name}» даёт до ${resName(best.max_res)} и ${best.max_fps} кадров. Для ${resName(res)} и ${fps} кадров нужен пакет выше.`, { maxRes: best.max_res, maxFps: best.max_fps });
      }
      D.run('UPDATE lots SET left = left - 1 WHERE id = ?', lot.id);
    }
    const id = D.rid(9);
    D.run('INSERT INTO gens(id, user_id, lot_id, source, status, res, fps, aspect, dur, title, artist, mark, meta, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, u.id, lot ? lot.id : 0, o.source, o.source === 'bot' ? 'queued' : 'reserved', res, fps, String(o.aspect || '16:9').slice(0, 8), dur,
      String(o.title || '').slice(0, 200), String(o.artist || '').slice(0, 200), lot && lot.mark ? 1 : 0, JSON.stringify(o.meta || {}), D.now());
    return D.get('SELECT * FROM gens WHERE id = ?', id);
  });
}
function settle(genId, ok, error, opts) {
  return D.tx(() => {
    const g = D.get('SELECT * FROM gens WHERE id = ?', genId);
    if (!g || ['done', 'failed', 'canceled'].includes(g.status)) return g;
    if (ok) {
      D.run("UPDATE gens SET status = 'done', progress = 1, finished_at = ? WHERE id = ?", D.now(), genId);
    } else {
      const canceled = error === 'cancel';
      // the bot renders on our side, so a failure there is always ours to refund; site refunds are capped per day
      const refund = g.lot_id && (g.source === 'bot' || (opts && opts.force) || refundsToday(g.user_id) < D.settings().refundsPerDay);
      if (refund) D.run('UPDATE lots SET left = MIN(total, left + 1) WHERE id = ?', g.lot_id);
      D.run('UPDATE gens SET status = ?, error = ?, finished_at = ? WHERE id = ?', refund || !g.lot_id ? (canceled ? 'canceled' : 'failed') : 'done', String(error || '').slice(0, 300), D.now(), genId);
    }
    return D.get('SELECT * FROM gens WHERE id = ?', genId);
  });
}
// a site export that never reported back (closed tab, crash) gives its credit back after two hours
function sweepStale() {
  const old = D.all("SELECT id FROM gens WHERE source = 'site' AND status = 'reserved' AND created_at < ?", D.now() - 2 * 3600000);
  for (const g of old) settle(g.id, false, 'не завершено');
  D.run('DELETE FROM logins WHERE created_at < ?', D.now() - 3600000);
  D.run('DELETE FROM sessions WHERE expires_at < ?', D.now());
  return old.length;
}

/* ---- orders ---- */
const packs = (onlyActive) => D.all(`SELECT * FROM packs ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY sort, price`);
const packView = (p) => ({ id: p.id, name: p.name, descr: p.descr, price: p.price, credits: p.credits, maxRes: p.max_res, maxFps: p.max_fps, days: p.days, mark: !!p.mark, active: !!p.active, sort: p.sort });
function newOrder(u, packId, via) {
  const p = D.get('SELECT * FROM packs WHERE id = ? AND active = 1', packId);
  if (!p) throw new Fail('no_pack', 'Такого пакета нет. Обновите страницу.');
  if (u.blocked) throw new Fail('blocked', 'Аккаунт заблокирован. Напишите в поддержку.');
  const id = D.rid(12);
  D.run('INSERT INTO orders(id, user_id, pack_id, pack_name, amount, via, created_at) VALUES(?,?,?,?,?,?,?)', id, u.id, p.id, p.name, p.price, via, D.now());
  return { order: D.get('SELECT * FROM orders WHERE id = ?', id), pack: p };
}
// idempotent: a webhook and a status poll may both report the same payment
function markPaid(orderId) {
  return D.tx(() => {
    const o = D.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o || o.status !== 'pending') return { order: o, fresh: false };
    const p = D.get('SELECT * FROM packs WHERE id = ?', o.pack_id);
    D.run("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?", D.now(), o.id);
    if (p) addLot(o.user_id, { packId: p.id, name: p.name, total: p.credits, maxRes: p.max_res, maxFps: p.max_fps, mark: p.mark, days: p.days, source: 'purchase', orderId: o.id });
    D.audit(o.user_id, 'paid', { order: o.id, pack: o.pack_id, amount: o.amount });
    return { order: D.get('SELECT * FROM orders WHERE id = ?', o.id), pack: p, fresh: true };
  });
}
const markCanceled = (orderId) => D.run("UPDATE orders SET status = 'canceled' WHERE id = ? AND status = 'pending'", orderId);

// up to six lines «label: handle», each short; anything else is dropped
const cleanSocials = (txt) => String(txt || '').split(/\r?\n/).map((l) => l.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 96)).filter(Boolean).slice(0, 6).join('\n');
module.exports = { cleanSocials, Fail, resName, plural, videos, upsertTgUser, userById, userByTg, newSession, userByToken, dropSession, addLot, liveLots, pickLot, caps, profile, usedToday, reserve, settle, sweepStale, packs, packView, newOrder, markPaid, markCanceled, DAY };
