'use strict';
// Thin Telegram Bot API client on plain fetch.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const cfg = require('./config');

const base = () => `${cfg.tgApi}/bot${cfg.botToken}`;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function call(method, params, timeoutMs = 30000) {
  const r = await fetch(`${base()}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) {
    const e = new Error(`telegram ${method}: ${j ? j.description : r.status}`);
    e.tg = j; e.retryAfter = j && j.parameters && j.parameters.retry_after;
    throw e;
  }
  return j.result;
}
// never let a failed notification break the flow that triggered it
const quiet = (p) => p.catch((e) => { console.error('[tg]', e.message); return null; });

const send = (chat, text, extra) => call('sendMessage', Object.assign({ chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, extra || {}));
const edit = (chat, id, text, extra) => call('editMessageText', Object.assign({ chat_id: chat, message_id: id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, extra || {}));
const answer = (id, text, alert) => quiet(call('answerCallbackQuery', { callback_query_id: id, text: text || undefined, show_alert: !!alert }));

async function sendFile(method, field, chat, file, name, params) {
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  for (const k in params || {}) if (params[k] != null) fd.append(k, typeof params[k] === 'object' ? JSON.stringify(params[k]) : String(params[k]));
  const blob = await fs.openAsBlob(file);
  fd.append(field, blob, name || path.basename(file));
  const r = await fetch(`${base()}/${method}`, { method: 'POST', body: fd, signal: AbortSignal.timeout(600000) });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw new Error(`telegram ${method}: ${j ? j.description : r.status}`);
  return j.result;
}
const sendVideo = (chat, file, name, params) => sendFile('sendVideo', 'video', chat, file, name, Object.assign({ supports_streaming: true, parse_mode: 'HTML' }, params));

const sendPhoto = (chat, file, params) => sendFile('sendPhoto', 'photo', chat, file, 'photo.jpg', params);

async function download(fileId, dest, maxBytes) {
  const f = await call('getFile', { file_id: fileId });
  if (maxBytes && f.file_size > maxBytes) { const e = new Error('too big'); e.code = 'too_big'; throw e; }
  const r = await fetch(`${cfg.tgApi}/file/bot${cfg.botToken}/${f.file_path}`, { signal: AbortSignal.timeout(300000) });
  if (!r.ok || !r.body) throw new Error('telegram file ' + r.status);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  return { size: fs.statSync(dest).size, path: f.file_path };
}

// long polling keeps the bot working behind any firewall: no public webhook address is needed
async function poll(onUpdate, state) {
  let offset = 0, backoff = 1000;
  await quiet(call('deleteWebhook', { drop_pending_updates: false }));
  while (!state.stop) {
    try {
      const ups = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40000);
      backoff = 1000;
      for (const u of ups) {
        offset = u.update_id + 1;
        try { await onUpdate(u); } catch (e) { console.error('[bot] update failed:', e); }
      }
    } catch (e) {
      if (state.stop) break;
      if (e.name !== 'TimeoutError') console.error('[tg] poll:', e.message);
      await new Promise((r) => setTimeout(r, e.retryAfter ? e.retryAfter * 1000 : backoff));
      backoff = Math.min(30000, backoff * 2);
    }
  }
}
module.exports = { call, quiet, send, edit, answer, sendVideo, sendPhoto, download, poll, esc };
