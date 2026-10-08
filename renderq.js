'use strict';
// Server-side rendering for the bot: the same studio page runs in headless Chrome, takes the job files,
// renders with the same engine as on the site and uploads the result back to this server.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const EventEmitter = require('events');
const D = require('./db');
const B = require('./billing');
const M = require('./media');
const cfg = require('./config');

const events = new EventEmitter();
const queue = [];
const live = new Map(); // genId -> { key, proc, beat, done(result) }
let running = 0;

function findChrome() {
  const cands = [cfg.chromePath, 'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const c of cands) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    const r = spawnSync('which', [c], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  try {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (/^chromium-\d/.test(d) && fs.existsSync(p)) return p;
    }
  } catch (e) { /* not there */ }
  return '';
}
const chrome = findChrome();
const available = () => !!chrome;
const jobDir = (id) => path.join(cfg.dataDir, 'jobs', id);
const position = (id) => { const i = queue.indexOf(id); return i < 0 ? 0 : i + 1; };
const stats = () => ({ queued: queue.length, running, chrome: !!chrome, ffmpeg: M.tools.ffmpeg });

function enqueue(genId) {
  if (!queue.includes(genId) && !live.has(genId)) queue.push(genId);
  setImmediate(pump);
}
function pump() {
  while (running < cfg.renderConcurrency && queue.length) {
    const id = queue.shift();
    running++;
    runJob(id).catch((e) => console.error('[render] job crashed:', e)).finally(() => { running--; pump(); });
    queue.forEach((q, i) => events.emit('queue', q, i + 1));
  }
}

async function runJob(id) {
  const dir = jobDir(id);
  let gen = D.get('SELECT * FROM gens WHERE id = ?', id);
  if (!gen || gen.status !== 'queued') return;
  const fail = (msg) => {
    console.error(`[render] ${id} failed: ${msg}`);
    gen = B.settle(id, false, msg);
    events.emit('failed', gen, msg);
  };
  let job;
  try { job = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')); } catch (e) { return fail('файлы задания не найдены'); }
  if (!chrome) return fail('на сервере не найден Chrome');
  D.run("UPDATE gens SET status = 'rendering' WHERE id = ?", id);
  events.emit('progress', gen, 0, 'prep');
  const profile = path.join(cfg.dataDir, 'tmp', 'chrome-' + id);
  let proc = null;
  try {
    // 1. audio to WAV so the headless browser reads it whatever was sent
    if (job.files.audio && !/\.wav$/i.test(job.files.audio)) {
      try { if (await M.toWav(path.join(dir, job.files.audio), path.join(dir, 'audio.wav'))) { job.files.audio = 'audio.wav'; fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job)); } }
      catch (e) { console.error(`[render] ${id}: audio convert skipped: ${e.message}`); }
    }
    // 2. the studio page does the rendering and reports here
    const key = D.rid(18);
    const result = new Promise((resolve) => { live.set(id, { key, beat: Date.now(), done: resolve, job, dir }); });
    const url = `${cfg.renderOrigin}/studio?render=${encodeURIComponent(id)}&k=${key}`;
    proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio', '--no-first-run',
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--disable-features=Translate,MediaRouter', '--window-size=1280,800', `--user-data-dir=${profile}`, url], { stdio: 'ignore' });
    live.get(id).proc = proc;
    proc.on('exit', () => { const l = live.get(id); if (l && !l.finished) setTimeout(() => { const l2 = live.get(id); if (l2 && !l2.finished) l2.done({ error: 'браузер рендера закрылся раньше времени' }); }, 1500); });
    proc.on('error', (e) => { const l = live.get(id); if (l) l.done({ error: 'не удалось запустить Chrome: ' + e.message }); });
    // nothing heard for five minutes means the page is stuck
    const dog = setInterval(() => { const l = live.get(id); if (l && Date.now() - l.beat > 300000) l.done({ error: 'рендер перестал отвечать' }); }, 15000);
    const hard = setTimeout(() => { const l = live.get(id); if (l) l.done({ error: 'рендер занял слишком много времени' }); }, 3 * 3600000);
    const r = await result;
    clearInterval(dog); clearTimeout(hard);
    live.get(id).finished = true;
    try { proc.kill('SIGKILL'); } catch (e) { /* gone */ }
    if (r.error) return fail(r.error);
    // 3. make it play everywhere and keep it behind a link
    events.emit('progress', gen, 1, 'encode');
    const out = path.join(dir, 'final.mp4');
    const fin = await M.finalize(r.file, out);
    const v = M.store(gen.user_id, id, out, [job.artist, job.title].filter(Boolean).join(' - '));
    gen = B.settle(id, true);
    D.run('UPDATE gens SET dur = ? WHERE id = ? AND dur = 0', (fin.info && fin.info.dur) || 0, id);
    events.emit('done', D.get('SELECT * FROM gens WHERE id = ?', id), v, fin.info);
  } catch (e) {
    fail(e.message || String(e));
  } finally {
    try { if (proc) proc.kill('SIGKILL'); } catch (e) { /* gone */ }
    live.delete(id);
    setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }, 1000);
  }
}

/* ---- what the render page calls ---- */
const check = (id, key) => { const l = live.get(id); return l && key && l.key === key ? l : null; };
function progress(id, p, stage) {
  const l = live.get(id);
  if (!l) return;
  l.beat = Date.now();
  const v = Math.max(0, Math.min(1, Number(p) || 0));
  D.run('UPDATE gens SET progress = ? WHERE id = ?', v, id);
  events.emit('progress', D.get('SELECT * FROM gens WHERE id = ?', id), v, stage || 'render');
}
const beat = (id) => { const l = live.get(id); if (l) l.beat = Date.now(); };
const finish = (id, r) => { const l = live.get(id); if (l) l.done(r); };

// after a restart: finish what was queued, give back what was cut off mid-render
function recover() {
  for (const g of D.all("SELECT * FROM gens WHERE source = 'bot' AND status IN ('queued', 'rendering')")) {
    if (g.status === 'queued' && fs.existsSync(path.join(jobDir(g.id), 'job.json'))) enqueue(g.id);
    else if (fs.existsSync(path.join(jobDir(g.id), 'job.json'))) { D.run("UPDATE gens SET status = 'queued', progress = 0 WHERE id = ?", g.id); enqueue(g.id); }
    else { const s = B.settle(g.id, false, 'сервер перезапускался'); events.emit('failed', s, 'сервер перезапускался'); }
  }
}
function shutdown() { for (const l of live.values()) { try { if (l.proc) l.proc.kill('SIGKILL'); } catch (e) { /* gone */ } } }

module.exports = { events, enqueue, position, stats, available, jobDir, check, progress, beat, finish, recover, shutdown };
