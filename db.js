'use strict';
// One SQLite file holds everything: people, credit lots, orders, generations, stored videos, settings.
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

const db = new DatabaseSync(path.join(cfg.dataDir, 'studio.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 4000;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id TEXT UNIQUE NOT NULL,
  username TEXT DEFAULT '', name TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'artist',
  blocked INTEGER NOT NULL DEFAULT 0,
  email TEXT DEFAULT '',
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS logins (
  code TEXT PRIMARY KEY, short TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
  user_id INTEGER, token TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS packs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, descr TEXT DEFAULT '',
  price INTEGER NOT NULL, credits INTEGER NOT NULL,
  max_res INTEGER NOT NULL, max_fps INTEGER NOT NULL,
  days INTEGER NOT NULL DEFAULT 365, mark INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  pack_id TEXT DEFAULT '', name TEXT NOT NULL,
  total INTEGER NOT NULL, left INTEGER NOT NULL,
  max_res INTEGER NOT NULL, max_fps INTEGER NOT NULL, mark INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, order_id TEXT DEFAULT '',
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lots_user ON lots(user_id);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, pack_id TEXT NOT NULL, pack_name TEXT NOT NULL,
  amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  yk_id TEXT DEFAULT '', url TEXT DEFAULT '', via TEXT NOT NULL DEFAULT 'site',
  created_at INTEGER NOT NULL, paid_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS orders_yk ON orders(yk_id);
CREATE TABLE IF NOT EXISTS gens (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, lot_id INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, status TEXT NOT NULL,
  res INTEGER NOT NULL, fps INTEGER NOT NULL, aspect TEXT DEFAULT '16:9', dur REAL NOT NULL DEFAULT 0,
  title TEXT DEFAULT '', artist TEXT DEFAULT '', mark INTEGER NOT NULL DEFAULT 0,
  video_id TEXT DEFAULT '', error TEXT DEFAULT '', progress REAL NOT NULL DEFAULT 0, meta TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL, finished_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS gens_user ON gens(user_id, created_at);
CREATE INDEX IF NOT EXISTS gens_status ON gens(status);
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, gen_id TEXT DEFAULT '',
  file TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, views INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bot_state (tg_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id INTEGER, type TEXT NOT NULL, data TEXT DEFAULT '');
`);

// columns added after the first release
{
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
  if (!has('users', 'socials')) db.exec("ALTER TABLE users ADD COLUMN socials TEXT DEFAULT ''");
}

const stmts = new Map();
const prep = (sql) => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };
const get = (sql, ...a) => prep(sql).get(...a);
const all = (sql, ...a) => prep(sql).all(...a);
const run = (sql, ...a) => prep(sql).run(...a);
let depth = 0;
function tx(fn) {
  if (depth) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth--; }
}
const now = () => Date.now();
const rid = (n = 16) => crypto.randomBytes(n).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---- settings: what an admin can change without touching the server ---- */
const SETTING_DEFAULTS = {
  signupCredits: 1,      // free videos for a new account
  trialRes: 720, trialFps: 30, trialDays: 30, trialMark: 1,
  dailyLimit: 20,        // generations per person per 24 hours
  maxDuration: 600,      // longest track, seconds
  refundsPerDay: 5,      // how many cancelled or failed site exports give the credit back per day
  videoDays: 7,          // how long a link to a finished video lives
  botMaxRes: 1080, botMaxFps: 60, botQuality: 'std',
  queueMax: 20,
  offerUrl: '', support: '',
  notifyAdmins: 1,
  labelSocials: '',      // the label's socials, one per line: «tg: @label»
  labelTitle: '',        // the heading over them in the finale
};
function settings() {
  const out = Object.assign({}, SETTING_DEFAULTS);
  for (const r of all('SELECT key, value FROM settings')) {
    if (!(r.key in SETTING_DEFAULTS)) continue;
    try { out[r.key] = JSON.parse(r.value); } catch (e) { /* keep default */ }
  }
  return out;
}
function setSettings(patch) {
  for (const k in patch) {
    if (!(k in SETTING_DEFAULTS)) continue;
    let v = patch[k];
    if (typeof SETTING_DEFAULTS[k] === 'number') { v = Number(v); if (!Number.isFinite(v) || v < 0) continue; }
    else v = String(v).slice(0, k === 'labelSocials' ? 600 : 300);
    run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
  }
}

/* ---- starting price list (an admin edits it later in the panel) ---- */
const DEFAULT_PACKS = [
  ['single', 'Сингл', 'Одно видео к одному релизу', 249, 1, 1080, 60, 365, 0, 1],
  ['ep', 'EP', 'Пять видео: мини-альбом или сингл с несколькими версиями', 990, 5, 2160, 60, 365, 0, 2],
  ['album', 'Альбом', 'Пятнадцать видео и 120 кадров в секунду', 2490, 15, 2160, 120, 365, 0, 3],
  ['label', 'Лейбл', 'Пятьдесят видео для каталога артистов', 6900, 50, 2160, 120, 365, 0, 4],
];
if (!get('SELECT 1 AS x FROM packs LIMIT 1')) {
  for (const p of DEFAULT_PACKS) run('INSERT INTO packs(id, name, descr, price, credits, max_res, max_fps, days, mark, sort) VALUES(?,?,?,?,?,?,?,?,?,?)', ...p);
}

const audit = (userId, type, data) => run('INSERT INTO audit(at, user_id, type, data) VALUES(?,?,?,?)', now(), userId || null, type, typeof data === 'string' ? data : JSON.stringify(data || {}));

module.exports = { db, get, all, run, tx, now, rid, sha, settings, setSettings, SETTING_DEFAULTS, audit };
