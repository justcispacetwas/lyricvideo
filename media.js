'use strict';
// Finished videos on disk, plus the ffmpeg steps around a render.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const D = require('./db');
const cfg = require('./config');

const has = (bin) => { try { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0; } catch (e) { return false; } };
const tools = { ffmpeg: has(cfg.ffmpeg), ffprobe: has(cfg.ffprobe) };

function sh(bin, args, timeoutMs = 3600000) {
  return new Promise((res, rej) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    const t = setTimeout(() => { p.kill('SIGKILL'); rej(new Error(path.basename(bin) + ': timeout')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); rej(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? res(out) : rej(new Error(`${path.basename(bin)} exit ${code}: ${err.split('\n').filter(Boolean).slice(-2).join(' | ')}`)); });
  });
}
async function probe(file) {
  if (!tools.ffprobe) return null;
  try {
    const j = JSON.parse(await sh(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60000));
    const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    return { dur: parseFloat(j.format && j.format.duration) || 0, v: v ? { codec: v.codec_name, w: v.width, h: v.height, pix: v.pix_fmt, frames: parseInt(v.nb_frames, 10) || 0 } : null, a: a ? { codec: a.codec_name } : null, tags: (j.format && j.format.tags) || {} };
  } catch (e) { return null; }
}
// any audio a person sends becomes plain WAV, which every browser build can read
async function toWav(src, dest) {
  if (!tools.ffmpeg) return false;
  await sh(cfg.ffmpeg, ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', dest], 600000);
  return true;
}
// what leaves the server plays everywhere: H.264 + AAC, moov atom first
async function finalize(src, dest) {
  const info = await probe(src);
  if (!tools.ffmpeg || !info || !info.v) { fs.renameSync(src, dest); return { transcoded: false, info }; }
  const vOk = info.v.codec === 'h264' && info.v.pix === 'yuv420p';
  const aOk = !info.a || info.a.codec === 'aac';
  if (vOk && aOk) { fs.renameSync(src, dest); return { transcoded: false, info }; }
  const args = ['-y', '-v', 'error', '-i', src, '-map_metadata', '0'];
  if (vOk) args.push('-c:v', 'copy'); else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
  if (info.a) args.push(...(aOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k']));
  args.push('-movflags', '+faststart', '-f', 'mp4', dest);
  await sh(cfg.ffmpeg, args);
  fs.rmSync(src, { force: true });
  return { transcoded: true, info: await probe(dest) };
}
// a lighter copy that fits the size a bot may send; the full file stays behind the link
async function fitCopy(src, dest, limitBytes) {
  const info = await probe(src);
  if (!tools.ffmpeg || !info || !info.dur) return false;
  const total = (limitBytes * 0.94 * 8) / info.dur;
  const vbr = Math.floor(total - 128000);
  if (vbr < 500000) return false;
  const h = info.v && Math.min(info.v.w, info.v.h) > 720 ? 720 : 0;
  const args = ['-y', '-v', 'error', '-i', src];
  if (h) args.push('-vf', info.v.w >= info.v.h ? `scale=-2:${h}` : `scale=${h}:-2`);
  args.push('-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', String(vbr), '-maxrate', String(vbr), '-bufsize', String(vbr * 2), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', dest);
  await sh(cfg.ffmpeg, args);
  return fs.statSync(dest).size <= limitBytes;
}

/* ---- stored videos ---- */
const safeName = (s) => String(s || 'lyric-video').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'lyric-video';
function store(userId, genId, srcPath, name) {
  const id = D.rid(8);
  const file = id + '.mp4';
  const dest = path.join(cfg.dataDir, 'videos', file);
  try { fs.renameSync(srcPath, dest); } catch (e) { fs.copyFileSync(srcPath, dest); fs.rmSync(srcPath, { force: true }); }
  const size = fs.statSync(dest).size;
  const days = D.settings().videoDays;
  D.run('INSERT INTO videos(id, user_id, gen_id, file, name, size, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?)', id, userId, genId || '', file, safeName(name) + '.mp4', size, D.now(), D.now() + days * 86400000);
  if (genId) D.run('UPDATE gens SET video_id = ? WHERE id = ?', id, genId);
  return D.get('SELECT * FROM videos WHERE id = ?', id);
}
const videoPath = (v) => path.join(cfg.dataDir, 'videos', v.file);
const videoUrl = (v) => `${cfg.publicUrl}/v/${v.id}`;
function getVideo(id) {
  const v = D.get('SELECT * FROM videos WHERE id = ?', id);
  if (!v || v.expires_at < D.now() || !fs.existsSync(videoPath(v))) return null;
  return v;
}
function sweep() {
  for (const v of D.all('SELECT * FROM videos WHERE expires_at < ?', D.now())) {
    fs.rmSync(videoPath(v), { force: true });
    D.run('DELETE FROM videos WHERE id = ?', v.id);
    D.run("UPDATE gens SET video_id = '' WHERE video_id = ?", v.id);
  }
  // drafts and job folders nobody came back for
  const jobs = path.join(cfg.dataDir, 'jobs');
  for (const n of fs.readdirSync(jobs)) {
    const p = path.join(jobs, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 2 * 86400000) fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  const tmp = path.join(cfg.dataDir, 'tmp');
  for (const n of fs.readdirSync(tmp)) {
    const p = path.join(tmp, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 6 * 3600000) fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}
const storageBytes = () => D.get('SELECT COALESCE(SUM(size), 0) AS n FROM videos').n;

module.exports = { tools, sh, probe, toWav, finalize, fitCopy, store, videoPath, videoUrl, getVideo, sweep, storageBytes, safeName };
