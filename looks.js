'use strict';
// Sheets with every style of each mode: drawn in the admin's browser (a copy ships with the server),
// shown by the bot on the style step and cut into tiles on the main page.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const KINDS = ['lyric', 'edit', 'promo'];
// used only when no sheet is found at all: the first twelve lyric styles
const FALLBACK = {
  lyric: [['air', 'Эфир'], ['karaoke', 'Караоке'], ['kinetic', 'Кинетика'], ['neon', 'Неон'], ['vinyl', 'Винил'], ['minimal', 'Минимал'], ['aurora', 'Аврора'], ['tunnel', 'Тоннель'], ['kaleido', 'Калейдоскоп'], ['wall', 'Световая стена'], ['waves', 'Волны'], ['word', 'Слово']],
  edit: [], promo: [],
};
const num = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
function valid(m) {
  return !!m && typeof m === 'object' && num(m.w, 64, 8192) && num(m.h, 64, 16384) && num(m.cols, 1, 20) && num(m.cw, 16, 2000) && num(m.ch, 16, 2000) && num(m.lab, 0, 200) && num(m.pad, 0, 100)
    && Array.isArray(m.styles) && m.styles.length > 0 && m.styles.length <= 120
    && m.styles.every((s) => Array.isArray(s) && s.length === 2 && typeof s[0] === 'string' && typeof s[1] === 'string' && s[0].length <= 40 && s[1].length <= 60 && /^[\w-]+$/.test(s[0]));
}
const cache = {};
// the newest pair of picture and description: the admin's upload first, then the bundled one
function sheet(kind) {
  if (!KINDS.includes(kind)) return null;
  for (const dir of [cfg.dataDir, cfg.publicDir]) {
    const jpg = path.join(dir, `looks-${kind}.jpg`), js = path.join(dir, `looks-${kind}.json`);
    if (!fs.existsSync(jpg) || !fs.existsSync(js)) continue;
    const m = fs.statSync(jpg).mtimeMs + fs.statSync(js).mtimeMs;
    const c = cache[kind];
    if (c && c.m === m && c.jpg === jpg) return c;
    try {
      const meta = JSON.parse(fs.readFileSync(js, 'utf8'));
      if (!valid(meta)) continue;
      return (cache[kind] = { m, jpg, meta, ver: String(Math.round(m)) });
    } catch (e) { /* a broken description: try the next place */ }
  }
  return null;
}
const styles = (kind) => { const s = sheet(kind); return s ? s.meta.styles : FALLBACK[kind] || []; };
function save(kind, tmpJpg, meta) {
  if (!KINDS.includes(kind)) throw new Error('kind');
  if (!valid(meta)) throw new Error('meta');
  const clean = { mode: kind, w: meta.w, h: meta.h, cols: meta.cols, cw: meta.cw, ch: meta.ch, lab: meta.lab, pad: meta.pad, styles: meta.styles };
  fs.writeFileSync(path.join(cfg.dataDir, `looks-${kind}.json`), JSON.stringify(clean));
  fs.renameSync(tmpJpg, path.join(cfg.dataDir, `looks-${kind}.jpg`));
  delete cache[kind];
}
const metas = () => Object.fromEntries(KINDS.map((k) => { const s = sheet(k); return [k, s ? s.meta : null]; }));

/* ---- the label's official «listen on» badges: one PNG per service in data/badges ---- */
const BADGE_IDS = ['yandex', 'vk', 'zvuk', 'mts', 'apple', 'spotify', 'youtube', 'deezer', 'soundcloud'];
const badgeDir = () => { const d = path.join(cfg.dataDir, 'badges'); fs.mkdirSync(d, { recursive: true }); return d; };
const badgeFile = (id) => (BADGE_IDS.includes(id) ? path.join(badgeDir(), id + '.png') : null);
// id -> version (file time), what the studio needs to fetch and cache them
function badges() {
  const out = {};
  for (const id of BADGE_IDS) { const f = badgeFile(id); if (f && fs.existsSync(f)) out[id] = String(Math.round(fs.statSync(f).mtimeMs)); }
  return out;
}
module.exports = { KINDS, sheet, styles, save, metas, valid, BADGE_IDS, badgeFile, badges };
