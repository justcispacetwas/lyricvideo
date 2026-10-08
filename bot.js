'use strict';
// The Telegram bot: the same studio, step by step in a chat.
const fs = require('fs');
const path = require('path');
const D = require('./db');
const B = require('./billing');
const M = require('./media');
const tg = require('./tg');
const pay = require('./pay');
const rq = require('./renderq');
const cfg = require('./config');

const { esc } = tg;
const looks = require('./looks');
// the lyric styles, in the order of the sheet the bot shows
const LOOKS = () => looks.styles('lyric');
const ASPECTS = [['16:9', '16:9 · горизонтальное'], ['9:16', '9:16 · вертикальное'], ['1:1', '1:1 · квадрат'], ['4:5', '4:5 · лента']];
const BTN = { make: '🎬 Новое видео', bal: '💳 Баланс и пакеты', help: '📖 Инструкция', site: '🌐 Сайт' };
const MENU = { keyboard: [[{ text: BTN.make }], [{ text: BTN.bal }, { text: BTN.help }], [{ text: BTN.site }]], resize_keyboard: true };
const kb = (rows) => ({ inline_keyboard: rows.map((r) => r.map(([text, data]) => (/^https?:\/\//.test(data) ? { text, url: data } : { text, callback_data: data }))) });
const rub = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtMB = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' МБ';
const fmtDate = (ms) => new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

let me = { username: '' };
let sheetCache = { ver: '', id: '' };
function looksPath() { const sh = looks.sheet('lyric'); return sh ? sh.jpg : null; }
const info = () => me;
const upTokens = new Map(); // token -> { tg, exp }
const progressMsg = new Map(); // genId -> { chat, id, at, text }

/* ---- per-chat state ---- */
function getState(tgId) {
  const r = D.get('SELECT data FROM bot_state WHERE tg_id = ?', String(tgId));
  if (!r) return {};
  try { return JSON.parse(r.data); } catch (e) { return {}; }
}
const setState = (tgId, st) => D.run('INSERT INTO bot_state(tg_id, data, updated_at) VALUES(?,?,?) ON CONFLICT(tg_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', String(tgId), JSON.stringify(st), D.now());
function dropDraft(st) {
  if (st.draft && st.draft.dir) fs.rmSync(path.join(cfg.dataDir, 'jobs', st.draft.dir), { recursive: true, force: true });
  delete st.draft; delete st.wait;
}
function newDraft(st) {
  dropDraft(st);
  const dir = 'd_' + D.rid(8);
  fs.mkdirSync(path.join(cfg.dataDir, 'jobs', dir), { recursive: true });
  st.draft = { dir, step: 'cover', files: {}, title: '', artist: '', prod: '', url: '', preset: 'air', aspect: '16:9', res: 1080, fps: 30, dur: 0, settings: null };
  return st.draft;
}
const draftPath = (d, f) => path.join(cfg.dataDir, 'jobs', d.dir, f);

/* ---- texts ---- */
const HELP = () => {
  const s = D.settings();
  return [
    '<b>Как собрать лирик-видео</b>',
    '',
    '1. Нажмите «Новое видео».',
    '2. Пришлите обложку — картинкой или файлом.',
    `3. Пришлите трек: MP3, M4A, FLAC, OGG или WAV до ${Math.round(cfg.tgGetLimit / 1048576)} МБ. Файл больше загружается по ссылке, которую я дам.`,
    `4. Пришлите текст с таймингом: файл .ttml или .lrc. Нет файла — сделайте его на сайте: ${cfg.publicUrl}/studio#ttml. Без текста получится видео с обложкой и визуализацией.`,
    '5. Проверьте название и исполнителя, при желании добавьте «prod. by» и ссылку на релиз — из неё получится QR-код в финале.',
    '6. Выберите стиль, формат кадра и качество.',
    '7. Нажмите «Собрать». Я пришлю видео и ссылку на файл в полном качестве.',
    '',
    '<b>Где взять TTML</b>',
    'TTML — текст, размеченный по времени: по строкам или по словам. Его отдаёт редактор синхронизации текста вашего дистрибьютора, подойдут и сторонние редакторы субтитров. LRC — тот же смысл в простом виде: <code>[00:12.50] строка</code>.',
    '',
    '<b>Оплата</b>',
    'Одно собранное видео списывает одну генерацию с баланса. Пакеты — в разделе «Баланс и пакеты», оплата картой или через СБП. Если сборка не удалась по нашей вине, генерация возвращается сама.',
    '',
    '<b>Лимиты</b>',
    `В боте — до ${B.resName(s.botMaxRes)} и ${s.botMaxFps} кадров в секунду, трек до ${Math.round(s.maxDuration / 60)} минут, ${B.videos(s.dailyLimit)} в сутки. 4K, 120 кадров и тонкая настройка каждой детали — на сайте, баланс общий.`,
    `Ссылка на готовое видео живёт ${B.plural(s.videoDays, ['день', 'дня', 'дней'])}.`,
    '',
    '<b>Команды</b>',
    '/new — новое видео · /balance — баланс · /buy — пакеты · /status — что с моим видео · /site — открыть сайт · /cancel — отменить текущий шаг',
    s.support ? `\nПоддержка: ${esc(s.support)}` : '',
  ].join('\n');
};
const lotLine = (l) => `• «${esc(l.name)}»: ${B.videos(l.left)} · до ${B.resName(l.max_res)}, ${l.max_fps} кадр/с${l.mark ? ' · со знаком talk with a star' : ''}${l.expires_at ? ` · до ${fmtDate(l.expires_at)}` : ''}`;
function balanceText(u) {
  if (u.role === 'admin') return '<b>Баланс</b>\nВы администратор: видео без ограничений.';
  const lots = B.liveLots(u.id);
  const total = lots.reduce((a, l) => a + l.left, 0);
  return [`<b>Баланс: ${B.videos(total)}</b>`, ...lots.map(lotLine), total ? '' : 'Пакеты ниже: одно видео списывает одну генерацию.'].filter((x) => x !== '').join('\n');
}
function packButtons() {
  return B.packs(true).map((p) => [[`${p.name} · ${B.videos(p.credits)} · ${rub(p.price)}`, 'buy:' + p.id]]);
}
function packsText() {
  const ps = B.packs(true);
  if (!ps.length) return 'Пакеты пока не настроены.';
  return ['<b>Пакеты</b>', ...ps.map((p) => `• <b>${esc(p.name)}</b> — ${B.videos(p.credits)} за ${rub(p.price)} (${rub(Math.round(p.price / p.credits))} за видео), до ${B.resName(p.max_res)} и ${p.max_fps} кадр/с${p.days ? `, действует ${B.plural(p.days, ['день', 'дня', 'дней'])}` : ''}`)].join('\n');
}

/* ---- wizard screens ---- */
function qualityOptions(u) {
  const s = D.settings(), c = B.caps(u);
  const maxRes = Math.min(s.botMaxRes, c.maxRes || 720), maxFps = Math.min(s.botMaxFps, c.maxFps || 30);
  const all = [[720, 30], [1080, 30], [1080, 60], [1440, 60], [2160, 60]];
  const ok = all.filter(([r, f]) => r <= maxRes && f <= maxFps);
  return ok.length ? ok : [[720, 30]];
}
function clampQuality(d, u) {
  const q = qualityOptions(u);
  if (!q.some(([r, f]) => r === d.res && f === d.fps)) { const best = q[q.length - 1]; d.res = best[0]; d.fps = best[1]; }
}
async function ask(chat, st, u) {
  const d = st.draft;
  if (!d) return;
  if (d.step === 'format' || d.step === 'confirm') clampQuality(d, u);
  if (d.step === 'cover') return tg.send(chat, '<b>Шаг 1 из 6 · Обложка</b>\nПришлите обложку трека — картинкой или файлом. Лучше квадратную, от 1000×1000.');
  if (d.step === 'audio') {
    const token = D.rid(12);
    upTokens.set(token, { tg: String(chat), exp: Date.now() + 3600000 });
    return tg.send(chat, `<b>Шаг 2 из 6 · Трек</b>\nПришлите трек файлом: MP3, M4A, FLAC, OGG или WAV до ${Math.round(cfg.tgGetLimit / 1048576)} МБ.\nWAV обычно тяжелее — загрузите его по кнопке ниже, страница откроется в браузере.`, { reply_markup: kb([[['Загрузить большой файл', `${cfg.publicUrl}/u/${token}`]]]) });
  }
  if (d.step === 'lyrics') return tg.send(chat, '<b>Шаг 3 из 6 · Текст</b>\nПришлите файл .ttml или .lrc с таймингом. Текст LRC можно просто вставить сообщением.\nНет такого файла? Его можно сделать на сайте за пару прослушиваний трека: вставить слова и отстучать строки в такт.', { reply_markup: kb([[['Сделать TTML на сайте', `${cfg.publicUrl}/studio#ttml`]], [['Без текста', 'w:nolyrics']]]) });
  if (d.step === 'meta') {
    const have = d.title || d.artist;
    st.wait = 'meta';
    const soc = (u.socials || '').split('\n').filter(Boolean);
    return tg.send(chat, `<b>Шаг 4 из 6 · Подписи</b>\n${have ? `Сейчас: <b>${esc([d.artist, d.title].filter(Boolean).join(' — '))}</b>\nЧтобы поменять, отправьте строку вида <code>Исполнитель — Название</code>.` : 'Отправьте строку вида <code>Исполнитель — Название</code>.'}${d.prod ? `\nProd. by: ${esc(d.prod)}` : ''}${d.url ? `\nСсылка на релиз: ${esc(d.url)}` : ''}${soc.length ? `\nСоцсети в финале: ${esc(soc.join(' · '))}` : ''}`,
      { reply_markup: kb([[['Prod. by', 'w:prod'], ['Ссылка на релиз', 'w:url']], [['Соцсети', 'w:soc']], have ? [['Дальше →', 'w:metaok']] : []].filter((r) => r.length)) });
  }
  if (d.step === 'look') {
    const rows = [];
    const L = LOOKS();
    for (let i = 0; i < L.length; i += 3) rows.push(L.slice(i, i + 3).map(([id, n], j) => [`${d.preset === id && !d.settings && d.lookDone ? '• ' : ''}${i + j + 1}. ${n}`, 'look:' + id]));
    const text = '<b>Шаг 5 из 6 · Стиль</b>\nВыберите, как будет выглядеть видео. Свой стиль с сайта тоже подойдёт: «Трек → Скопировать настройки» и вставьте текст сюда.';
    const sheet = looksPath();
    const cap = { caption: 'Все стили. Номера на картинке совпадают с номерами на кнопках.' };
    try {
      if (sheet) {
        const ver = String(Math.round(fs.statSync(sheet).mtimeMs));
        // Telegram keeps an uploaded photo: after the first time only its id is sent
        if (sheetCache.ver === ver && sheetCache.id) await tg.call('sendPhoto', Object.assign({ chat_id: chat, photo: sheetCache.id }, cap));
        else { const m = await tg.sendPhoto(chat, sheet, cap); sheetCache = { ver, id: m.photo && m.photo.length ? m.photo[m.photo.length - 1].file_id : '' }; }
      }
    } catch (e) { sheetCache = { ver: '', id: '' }; /* the sheet is a nicety, the buttons work without it */ }
    return tg.send(chat, text, { reply_markup: kb(rows) });
  }
  if (d.step === 'format') {
    const q = qualityOptions(u);
    return tg.send(chat, '<b>Шаг 6 из 6 · Формат и качество</b>\nСначала форма кадра, затем качество.', {
      reply_markup: kb([...ASPECTS.map(([id, n]) => [[(d.aspect === id ? '• ' : '') + n, 'asp:' + id]]), q.map(([r, f]) => [`${d.res === r && d.fps === f ? '• ' : ''}${B.resName(r)} · ${f}`, `q:${r}:${f}`]), [['Готово →', 'w:formatok']]]),
    });
  }
  if (d.step === 'confirm') {
    const c = B.caps(u);
    const lot = c.unlimited ? null : B.pickLot(u, d.res, d.fps);
    const lookName = d.settings ? 'свой, с сайта' : (LOOKS().find((l) => l[0] === d.preset) || LOOKS()[0] || ['', 'Эфир'])[1];
    const lines = [
      '<b>Проверьте и запускайте</b>',
      `Трек: <b>${esc([d.artist, d.title].filter(Boolean).join(' — ') || 'без названия')}</b>${d.dur ? ` · ${fmtDur(d.dur)}` : ''}`,
      `Текст: ${d.files.lyrics ? 'есть' : 'без текста'}`,
      d.prod ? `Prod. by: ${esc(d.prod)}` : '', d.url ? `Ссылка в финале: ${esc(d.url)}` : '',
      `Стиль: ${lookName} · ${d.aspect} · ${B.resName(d.res)}, ${d.fps} кадр/с`,
      '',
      c.unlimited ? 'Вы администратор: без списания.' : lot ? `Спишется 1 видео из пакета «${esc(lot.name)}» (осталось ${lot.left}).${lot.mark ? ' В углу кадра будет знак talk with a star.' : ''}` : c.balance > 0 ? 'В ваших пакетах нет такого качества — выберите формат ниже или пакет выше.' : 'На балансе нет видео — выберите пакет.',
    ].filter((x, i) => x !== '' || i === 6);
    const rows = [];
    if (c.unlimited || lot) rows.push([['▶️ Собрать видео', 'w:go']]); else rows.push([['💳 Выбрать пакет', 'w:buy']]);
    rows.push([['Стиль', 'w:look'], ['Формат', 'w:format'], ['Подписи', 'w:meta']], [['Отменить', 'w:cancel']]);
    return tg.send(chat, lines.join('\n'), { reply_markup: kb(rows) });
  }
}
const next = (d) => {
  if (!d.files.cover) return 'cover';
  if (!d.files.audio) return 'audio';
  if (!d.lyricsDone) return 'lyrics';
  if (!d.metaDone) return 'meta';
  if (!d.lookDone) return 'look';
  if (!d.formatDone) return 'format';
  return 'confirm';
};
async function advance(chat, st, u) {
  st.draft.step = next(st.draft);
  st.wait = null;
  setState(chat, st);
  await ask(chat, st, u);
  setState(chat, st);
}

/* ---- incoming files ---- */
const AUDIO_EXT = /\.(wav|wave|flac|mp3|m4a|aac|ogg|oga|opus|aiff?)$/i;
const IMG_EXT = /\.(png|jpe?g|webp|bmp)$/i;
const LYR_EXT = /\.(ttml|xml|lrc|txt)$/i;
const looksLikeLyrics = (t) => /<tt[\s>]|<p\s[^>]*begin=|^\s*\[\d+:\d+/m.test(t);
function metaFromName(d, name) {
  const m = /^(.+?)\s+[-–—]\s+(.+?)\.[a-z0-9]+$/i.exec(name || '');
  if (m) { if (!d.artist) d.artist = m[1].trim(); if (!d.title) d.title = m[2].trim(); }
  else if (!d.title && name) d.title = name.replace(/\.[a-z0-9]+$/i, '').slice(0, 120);
}
// a file that reached the server (from the chat or from the upload page) lands in the draft here
async function acceptFile(st, kind, srcPath, name) {
  const d = st.draft;
  const ext = (path.extname(name || '') || { cover: '.jpg', audio: '.mp3', lyrics: '.ttml' }[kind]).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const file = kind + ext;
  if (d.files[kind]) fs.rmSync(draftPath(d, d.files[kind]), { force: true });
  fs.renameSync(srcPath, draftPath(d, file));
  d.files[kind] = file;
  if (kind === 'audio') {
    const p = await M.probe(draftPath(d, file));
    if (p) {
      d.dur = p.dur || d.dur;
      const tags = Object.fromEntries(Object.entries(p.tags).map(([k, v]) => [k.toLowerCase(), v]));
      if (!d.title && tags.title) d.title = String(tags.title).slice(0, 120);
      if (!d.artist && tags.artist) d.artist = String(tags.artist).slice(0, 120);
    }
    metaFromName(d, name);
  }
  if (kind === 'lyrics') d.lyricsDone = true;
}
function kindOf(name, mime) {
  if (/^image\//.test(mime || '') || IMG_EXT.test(name || '')) return 'cover';
  if (/^audio\//.test(mime || '') || AUDIO_EXT.test(name || '')) return 'audio';
  if (LYR_EXT.test(name || '') || /xml|text/.test(mime || '')) return 'lyrics';
  return '';
}
async function onFile(chat, st, u, f) {
  // f: { id, name, mime, size, kind?, dur?, performer?, title? }
  if (!st.draft) { newDraft(st); }
  const d = st.draft;
  const kind = f.kind || kindOf(f.name, f.mime);
  if (!kind) return tg.send(chat, 'Не знаю, что делать с этим файлом. Нужны обложка (картинка), трек (аудио) и текст (.ttml или .lrc).');
  const limit = kind === 'lyrics' ? 3 * 1048576 : cfg.tgGetLimit;
  if (f.size > limit) {
    if (kind !== 'audio' && kind !== 'cover') return tg.send(chat, 'Файл текста слишком большой. Нужен .ttml или .lrc до 3 МБ.');
    const token = D.rid(12);
    upTokens.set(token, { tg: String(chat), exp: Date.now() + 3600000 });
    return tg.send(chat, `Этот файл весит ${fmtMB(f.size)}, а через чат я могу принять до ${Math.round(cfg.tgGetLimit / 1048576)} МБ. Загрузите его по кнопке — страница откроется в браузере, я подхвачу файл сам.`, { reply_markup: kb([[['Загрузить большой файл', `${cfg.publicUrl}/u/${token}`]]]) });
  }
  const tmp = path.join(cfg.dataDir, 'tmp', 'in_' + D.rid(8));
  try { await tg.download(f.id, tmp, limit); }
  catch (e) { fs.rmSync(tmp, { force: true }); return tg.send(chat, 'Не получилось скачать файл из Telegram. Отправьте его ещё раз.'); }
  if (kind === 'lyrics' && !looksLikeLyrics(fs.readFileSync(tmp, 'utf8').slice(0, 200000))) {
    fs.rmSync(tmp, { force: true });
    return tg.send(chat, 'В этом файле не нашлось строк с таймингом. Нужен TTML с атрибутами begin и end или LRC вида <code>[00:12.50] строка</code>.');
  }
  if (kind === 'audio') { if (f.performer && !d.artist) d.artist = String(f.performer).slice(0, 120); if (f.title && !d.title) d.title = String(f.title).slice(0, 120); if (f.dur) d.dur = f.dur; }
  await acceptFile(st, kind, tmp, f.name || '');
  const got = { cover: 'Обложка на месте.', audio: `Трек принят${d.dur ? `: ${fmtDur(d.dur)}` : ''}.`, lyrics: 'Текст принят.' }[kind];
  await tg.send(chat, got);
  await advance(chat, st, u);
}
// called by the upload page handler
async function uploadedViaWeb(token, tmpPath, name, mime) {
  const t = upTokens.get(token);
  if (!t || t.exp < Date.now()) { fs.rmSync(tmpPath, { force: true }); return { ok: false, error: 'Ссылка устарела. Попросите у бота новую: нажмите «Новое видео».' }; }
  const u = B.userByTg(t.tg);
  const st = getState(t.tg);
  if (!u || !st.draft) { fs.rmSync(tmpPath, { force: true }); return { ok: false, error: 'В боте нет начатого видео. Нажмите «Новое видео» и попробуйте снова.' }; }
  const kind = kindOf(name, mime);
  if (!kind) { fs.rmSync(tmpPath, { force: true }); return { ok: false, error: 'Нужна картинка, аудио или файл .ttml / .lrc.' }; }
  if (kind === 'lyrics' && !looksLikeLyrics(fs.readFileSync(tmpPath, 'utf8').slice(0, 200000))) { fs.rmSync(tmpPath, { force: true }); return { ok: false, error: 'В файле не нашлось строк с таймингом.' }; }
  await acceptFile(st, kind, tmpPath, name);
  setState(t.tg, st);
  const label = { cover: 'Обложка', audio: 'Трек', lyrics: 'Текст' }[kind];
  await tg.quiet(tg.send(t.tg, `${label}: файл получен с сайта${kind === 'audio' && st.draft.dur ? `, ${fmtDur(st.draft.dur)}` : ''}.`));
  await advance(t.tg, st, u).catch((e) => console.error('[bot]', e));
  return { ok: true, kind };
}
const uploadToken = (token) => { const t = upTokens.get(token); return t && t.exp > Date.now() ? t : null; };

/* ---- starting the render ---- */
async function go(chat, st, u) {
  const d = st.draft;
  if (!d || !d.files.cover || !d.files.audio) return tg.send(chat, 'Сначала нужны обложка и трек. Нажмите «Новое видео».');
  clampQuality(d, u);
  if (!rq.available()) return tg.send(chat, 'Сборка на сервере сейчас недоступна. Мы уже разбираемся; пока видео можно собрать на сайте.');
  let gen;
  try {
    gen = B.reserve(u, { source: 'bot', res: d.res, fps: d.fps, dur: d.dur, aspect: d.aspect, title: d.title, artist: d.artist, meta: { preset: d.preset, chat: String(chat) } });
  } catch (e) {
    if (!(e instanceof B.Fail)) throw e;
    const buy = ['no_credits', 'quality'].includes(e.code);
    return tg.send(chat, esc(e.message) + (buy ? '\n\n' + packsText() : ''), buy ? { reply_markup: kb(packButtons()) } : undefined);
  }
  const s = D.settings();
  const job = { id: gen.id, title: d.title, artist: d.artist, prod: d.prod, url: d.url, preset: d.preset, settings: d.settings, aspect: d.aspect, res: d.res, fps: d.fps, quality: s.botQuality, mark: !!gen.mark, maxDuration: s.maxDuration, files: d.files,
    socials: { artist: u.socials || '', label: s.labelSocials || '', labelTitle: s.labelTitle || '' } };
  fs.renameSync(path.join(cfg.dataDir, 'jobs', d.dir), rq.jobDir(gen.id));
  fs.writeFileSync(path.join(rq.jobDir(gen.id), 'job.json'), JSON.stringify(job));
  delete st.draft; st.wait = null;
  setState(chat, st);
  rq.enqueue(gen.id);
  const pos = rq.position(gen.id);
  const m = await tg.send(chat, pos > 0 ? `Принято. В очереди: ${pos}-е. Напишу, как только начну.` : 'Принято, начинаю собирать. Обычно это занимает несколько минут.');
  progressMsg.set(gen.id, { chat, id: m.message_id, at: 0, text: '' });
}
const barText = (p) => { const n = Math.round(p * 12); return '▰'.repeat(n) + '▱'.repeat(12 - n) + ` ${Math.round(p * 100)}%`; };
async function showProgress(gen, text, force) {
  let pm = progressMsg.get(gen.id);
  if (!pm) {
    let chat = '';
    try { chat = JSON.parse(gen.meta || '{}').chat || ''; } catch (e) { chat = ''; }
    if (!chat) return;
    pm = { chat, id: 0, at: 0, text: '' };
    progressMsg.set(gen.id, pm);
  }
  if (pm.text === text || (!force && Date.now() - pm.at < 5000)) return;
  pm.at = Date.now(); pm.text = text;
  try {
    if (pm.id) await tg.edit(pm.chat, pm.id, text);
    else pm.id = (await tg.send(pm.chat, text)).message_id;
  } catch (e) { /* an edit that changes nothing or a deleted message: not worth stopping for */ }
}
rq.events.on('queue', (id, pos) => { const g = D.get('SELECT * FROM gens WHERE id = ?', id); if (g) showProgress(g, `В очереди: ${pos}-е. Напишу, как только начну.`, true); });
rq.events.on('progress', (gen, p, stage) => {
  if (!gen) return;
  const name = [gen.artist, gen.title].filter(Boolean).join(' — ') || 'видео';
  if (stage === 'prep') showProgress(gen, `Собираю «${esc(name)}»: готовлю звук и шрифты…`, true);
  else if (stage === 'encode') showProgress(gen, `Собираю «${esc(name)}»: упаковываю файл…`, true);
  else showProgress(gen, `Собираю «${esc(name)}»\n${barText(p)}`);
});
rq.events.on('failed', async (gen, msg) => {
  if (!gen) return;
  await showProgress(gen, 'Сборка не удалась.', true);
  const pm = progressMsg.get(gen.id);
  progressMsg.delete(gen.id);
  if (!pm) return;
  const human = /тайминг|аудио|обложк|длиннее/i.test(msg) ? msg : 'что-то пошло не так на нашей стороне';
  await tg.quiet(tg.send(pm.chat, `Не получилось собрать видео: ${esc(human)}.\n${gen.lot_id ? 'Генерация вернулась на баланс.' : ''} Попробуйте ещё раз: «Новое видео».`, { reply_markup: MENU }));
});
rq.events.on('done', async (gen, v, fin) => {
  const pm = progressMsg.get(gen.id);
  progressMsg.delete(gen.id);
  let chat = pm && pm.chat;
  if (!chat) { try { chat = JSON.parse(gen.meta || '{}').chat; } catch (e) { chat = ''; } }
  if (!chat) return;
  if (pm && pm.id) await tg.quiet(tg.edit(chat, pm.id, 'Готово. Отправляю…'));
  await deliver(chat, gen, v, fin);
});
async function deliver(chat, gen, v, fin) {
  const s = D.settings();
  const url = M.videoUrl(v);
  const name = [gen.artist, gen.title].filter(Boolean).join(' — ') || 'Лирик-видео';
  const caption = `<b>${esc(name)}</b>\n${B.resName(gen.res)} · ${gen.fps} кадр/с · ${fmtMB(v.size)}\n\nПолное качество: ${url}\nСсылка работает ${B.plural(s.videoDays, ['день', 'дня', 'дней'])}.`;
  const file = M.videoPath(v);
  const dims = fin && fin.v ? { width: fin.v.w, height: fin.v.h, duration: Math.round(fin.dur || 0) } : {};
  try {
    if (v.size <= cfg.tgSendLimit) {
      await tg.sendVideo(chat, file, v.name, Object.assign({ caption }, dims));
    } else {
      // too heavy for a bot to send: a lighter copy goes to the chat, the full file stays behind the link
      const light = path.join(cfg.dataDir, 'tmp', 'tg_' + v.id + '.mp4');
      let sent = false;
      try {
        if (await M.fitCopy(file, light, cfg.tgSendLimit)) {
          const li = await M.probe(light);
          await tg.sendVideo(chat, light, v.name, Object.assign({ caption: caption.replace('Полное качество:', 'Это облегчённая копия для Telegram. Полное качество:') }, li && li.v ? { width: li.v.w, height: li.v.h, duration: Math.round(li.dur) } : {}));
          sent = true;
        }
      } catch (e) { console.error('[bot] light copy:', e.message); }
      fs.rmSync(light, { force: true });
      if (!sent) await tg.send(chat, caption.replace('Полное качество:', `Файл больше ${Math.round(cfg.tgSendLimit / 1048576)} МБ, в чат не помещается. Скачать:`), { reply_markup: kb([[['Скачать видео', url]]]) });
    }
  } catch (e) {
    console.error('[bot] deliver:', e.message);
    await tg.quiet(tg.send(chat, `Видео готово, но отправить файл в чат не получилось.\n${caption}`, { reply_markup: kb([[['Скачать видео', url]]]) }));
  }
  const u = B.userById(gen.user_id);
  if (u && u.role !== 'admin') {
    const c = B.caps(u);
    await tg.quiet(tg.send(chat, c.balance > 0 ? `На балансе осталось ${B.videos(c.balance)}.` : 'Это было последнее видео на балансе. Пакеты — в разделе «Баланс и пакеты».', { reply_markup: MENU }));
  }
}

/* ---- payments ---- */
async function buy(chat, st, u, packId) {
  let r;
  try { r = await pay.start(u, packId, 'bot'); }
  catch (e) {
    if (e instanceof B.Fail && e.code === 'need_email') { st.wait = 'email'; st.payPack = packId; setState(chat, st); return tg.send(chat, 'Пришлите e-mail: на него придёт кассовый чек.'); }
    return tg.send(chat, esc(e instanceof B.Fail ? e.message : 'Не получилось открыть оплату. Попробуйте позже.'));
  }
  return tg.send(chat, `Пакет «${esc(r.pack.name)}»: ${B.videos(r.pack.credits)} за ${rub(r.pack.price)}.\nОплата откроется на странице ЮKassa: карта, СБП и другие способы. После оплаты баланс пополнится сам, я напишу.`,
    { reply_markup: kb([[[`Оплатить ${rub(r.pack.price)}`, r.url]], [['Я оплатил — проверить', 'chk:' + r.order.id]]]) });
}
pay.events.on('paid', async (order, pack) => {
  const u = B.userById(order.user_id);
  if (!u) return;
  const c = B.caps(u);
  await tg.quiet(tg.send(u.tg_id, `Оплата прошла: пакет «${esc(order.pack_name)}».\nНа балансе ${c.unlimited ? 'без ограничений' : B.videos(c.balance)}.`, { reply_markup: MENU }));
  const st = getState(u.tg_id);
  if (st.draft && st.draft.step === 'confirm') await ask(u.tg_id, st, u).catch(() => {});
  if (D.settings().notifyAdmins) {
    for (const a of D.all("SELECT tg_id FROM users WHERE role = 'admin' AND id != ?", u.id)) {
      await tg.quiet(tg.send(a.tg_id, `Оплата: ${rub(order.amount)} · «${esc(order.pack_name)}» · ${esc(u.name)}${u.username ? ' @' + esc(u.username) : ''} · ${order.via === 'bot' ? 'бот' : 'сайт'}`));
    }
  }
});

/* ---- admin in the chat ---- */
function statsText() {
  const day = D.now() - 86400000, month = D.now() - 30 * 86400000;
  const n = (sql, ...a) => D.get(sql, ...a).n;
  return [
    '<b>Сводка</b>',
    `Пользователей: ${n('SELECT COUNT(*) AS n FROM users')} (за сутки +${n('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', day)})`,
    `Видео за сутки: ${n("SELECT COUNT(*) AS n FROM gens WHERE status = 'done' AND created_at > ?", day)} · всего ${n("SELECT COUNT(*) AS n FROM gens WHERE status = 'done'")}`,
    `Выручка за 30 дней: ${rub(n("SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE status = 'paid' AND paid_at > ?", month))} · всего ${rub(n("SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE status = 'paid'"))}`,
    `Очередь рендера: ${rq.stats().queued} ждут, ${rq.stats().running} в работе`,
    `Хранилище видео: ${fmtMB(M.storageBytes())}`,
    '',
    'Начислить видео: <code>/grant @ник 5</code> или <code>/grant 123456 5 2160 60</code> (число, затем разрешение и кадры).',
    'Остальное — в панели на сайте: «Аккаунт → Админ».',
  ].join('\n');
}
function grantCmd(admin, args) {
  const [who, cnt, res, fps] = args;
  const n = parseInt(cnt, 10);
  if (!who || !(n > 0) || n > 1000) return 'Формат: <code>/grant @ник 5</code> или <code>/grant 123456 5 2160 60</code>.';
  const t = who.startsWith('@') ? D.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', who.slice(1)) : B.userByTg(who);
  if (!t) return 'Такого пользователя нет. Он должен хотя бы раз открыть бота.';
  const maxRes = [720, 1080, 1440, 2160].includes(parseInt(res, 10)) ? parseInt(res, 10) : 2160;
  const maxFps = [30, 60, 120].includes(parseInt(fps, 10)) ? parseInt(fps, 10) : 60;
  B.addLot(t.id, { name: 'Подарок', total: n, maxRes, maxFps, mark: 0, days: 365, source: 'grant' });
  D.audit(admin.id, 'grant', { to: t.id, credits: n, maxRes, maxFps });
  tg.quiet(tg.send(t.tg_id, `Вам начислено ${B.videos(n)}: до ${B.resName(maxRes)} и ${maxFps} кадр/с.`));
  return `Начислено ${B.videos(n)} для ${esc(t.name)}.`;
}

/* ---- updates ---- */
async function siteLink(chat, u) {
  const code = D.rid(18);
  D.run("INSERT INTO logins(code, short, status, user_id, token, created_at) VALUES(?, '', 'magic', ?, '', ?)", code, u.id, D.now());
  return tg.send(chat, 'Сайт: тонкая настройка каждой детали, 4K и 120 кадров. Баланс общий с ботом.\nКнопка откроет сайт и сразу войдёт в ваш аккаунт; ссылка одноразовая, работает 10 минут.', { reply_markup: kb([[['Открыть сайт', `${cfg.publicUrl}/studio?auth=${code}`]]]) });
}
async function onMessage(m) {
  if (!m.from || m.from.is_bot || !m.chat || m.chat.type !== 'private') return;
  const chat = m.chat.id;
  const u = B.upsertTgUser(m.from);
  const st = getState(chat);
  const text = (m.text || '').trim();
  if (u.blocked) return tg.send(chat, 'Аккаунт заблокирован. Напишите в поддержку.');

  /* files first: whatever the step, a file goes where it belongs */
  if (m.photo && m.photo.length) { const p = m.photo[m.photo.length - 1]; return onFile(chat, st, u, { id: p.file_id, name: 'cover.jpg', mime: 'image/jpeg', size: p.file_size || 0, kind: 'cover' }); }
  if (m.audio) return onFile(chat, st, u, { id: m.audio.file_id, name: m.audio.file_name || 'track.mp3', mime: m.audio.mime_type, size: m.audio.file_size || 0, kind: 'audio', dur: m.audio.duration, performer: m.audio.performer, title: m.audio.title });
  if (m.document) return onFile(chat, st, u, { id: m.document.file_id, name: m.document.file_name || '', mime: m.document.mime_type, size: m.document.file_size || 0 });
  if (m.voice || m.video || m.video_note) return tg.send(chat, 'Нужен сам трек аудиофайлом: MP3, M4A, FLAC, OGG или WAV.');
  if (!text) return;

  const cmd = text.startsWith('/') ? text.split(/\s+/)[0].split('@')[0].toLowerCase() : '';
  const args = text.split(/\s+/).slice(1);
  if (cmd === '/start') {
    if (args[0] && args[0].startsWith('login_')) return loginPrompt(chat, u, args[0].slice(6));
    return tg.send(chat, `<b>talk with a star // tools</b>\nСобираю лирик-видео из обложки, трека и текста с таймингом: анимация под бит, ${B.plural(LOOKS().length, ['стиль', 'стиля', 'стилей'])} на выбор, QR-код релиза и ваши соцсети в финале.\n\n${u.isNew && D.settings().signupCredits > 0 ? `В подарок — ${B.videos(D.settings().signupCredits)}, чтобы попробовать.\n\n` : ''}Нажмите «Новое видео», и я проведу по шагам. Подробности — в «Инструкции».`, { reply_markup: MENU });
  }
  if (cmd === '/help' || text === BTN.help) return tg.send(chat, HELP(), { reply_markup: MENU });
  if (cmd === '/cancel') { dropDraft(st); setState(chat, st); return tg.send(chat, 'Отменено. Когда будете готовы — «Новое видео».', { reply_markup: MENU }); }
  if (cmd === '/new' || text === BTN.make) { newDraft(st); setState(chat, st); await tg.send(chat, 'Начинаем. Файлы можно присылать в любом порядке, я разберусь.', { reply_markup: MENU }); return advance(chat, st, u); }
  if (cmd === '/balance' || cmd === '/buy' || text === BTN.bal) return tg.send(chat, balanceText(u) + '\n\n' + packsText(), { reply_markup: kb(packButtons()) });
  if (cmd === '/site' || text === BTN.site) return siteLink(chat, u);
  if (cmd === '/status') {
    const g = D.get("SELECT * FROM gens WHERE user_id = ? AND source = 'bot' ORDER BY created_at DESC LIMIT 1", u.id);
    if (!g) return tg.send(chat, 'Пока ни одного видео. Нажмите «Новое видео».');
    const name = esc([g.artist, g.title].filter(Boolean).join(' — ') || 'видео');
    if (g.status === 'queued') return tg.send(chat, `«${name}»: в очереди, ${rq.position(g.id) || 1}-е.`);
    if (g.status === 'rendering') return tg.send(chat, `«${name}»: собирается, ${Math.round(g.progress * 100)}%.`);
    if (g.status === 'done') { const v = g.video_id && M.getVideo(g.video_id); return tg.send(chat, `«${name}»: готово.${v ? `\n${M.videoUrl(v)}` : '\nСрок хранения ссылки истёк.'}`); }
    return tg.send(chat, `«${name}»: не собралось, генерация возвращена.`);
  }
  if (u.role === 'admin' && cmd === '/admin') return tg.send(chat, statsText());
  if (u.role === 'admin' && cmd === '/grant') return tg.send(chat, grantCmd(u, args));
  if (cmd) return tg.send(chat, 'Не знаю такой команды. Список — в «Инструкции».', { reply_markup: MENU });

  /* plain text answers a question the wizard asked */
  if (st.wait === 'email') {
    if (!pay.EMAIL.test(text)) return tg.send(chat, 'Не похоже на e-mail. Пример: name@example.com');
    D.run('UPDATE users SET email = ? WHERE id = ?', text, u.id);
    u.email = text;
    const packId = st.payPack; st.wait = null; delete st.payPack; setState(chat, st);
    return buy(chat, st, u, packId);
  }
  const d = st.draft;
  if (!d) return tg.send(chat, 'Чтобы собрать видео, нажмите «Новое видео».', { reply_markup: MENU });
  if (st.wait === 'prod') { d.prod = text.replace(/^prod\.?\s*by\s*/i, '').slice(0, 80); st.wait = 'meta'; setState(chat, st); return ask(chat, st, u); }
  if (st.wait === 'soc') {
    const v = text.trim() === '-' ? '' : B.cleanSocials(text);
    D.run('UPDATE users SET socials = ? WHERE id = ?', v, u.id);
    u.socials = v;
    st.wait = 'meta'; setState(chat, st);
    await tg.send(chat, v ? 'Соцсети сохранены в профиле: они будут в финале этого и следующих видео, и на сайте тоже.' : 'Соцсети убраны.');
    return ask(chat, st, u);
  }
  if (st.wait === 'url') {
    if (/\s/.test(text) || !/\./.test(text) || text.length > 200) return tg.send(chat, 'Нужна одна ссылка без пробелов, например band.link/release.');
    d.url = text; st.wait = 'meta'; setState(chat, st); return ask(chat, st, u);
  }
  if (d.step === 'lyrics' && looksLikeLyrics(text)) {
    const tmp = path.join(cfg.dataDir, 'tmp', 'in_' + D.rid(8));
    fs.writeFileSync(tmp, text);
    await acceptFile(st, 'lyrics', tmp, 'lyrics.lrc');
    await tg.send(chat, 'Текст принят.');
    return advance(chat, st, u);
  }
  if (d.step === 'look' && text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object' || !obj.text || !obj.bg) throw new Error('shape');
      d.settings = obj; d.lookDone = true;
      if (obj.frame && ASPECTS.some((a) => a[0] === obj.frame.aspect)) d.aspect = obj.frame.aspect;
      await tg.send(chat, 'Свой стиль принят.');
      return advance(chat, st, u);
    } catch (e) { return tg.send(chat, 'Это не похоже на настройки с сайта. Нужен текст целиком, как его копирует кнопка «Скопировать настройки» (длинные настройки Telegram режет на части — тогда выберите стиль кнопкой).'); }
  }
  if (d.step === 'meta' || st.wait === 'meta') {
    const m2 = /^(.+?)\s+[-–—]\s+(.+)$/.exec(text);
    if (m2) { d.artist = m2[1].trim().slice(0, 120); d.title = m2[2].trim().slice(0, 120); }
    else d.title = text.slice(0, 120);
    setState(chat, st);
    return ask(chat, st, u);
  }
  return tg.send(chat, 'Сейчас я жду другое. Посмотрите последний шаг выше или начните заново: «Новое видео».');
}

async function loginPrompt(chat, u, code) {
  const l = D.get('SELECT * FROM logins WHERE code = ?', code);
  if (!l || l.status !== 'new' || D.now() - l.created_at > 600000) return tg.send(chat, 'Эта ссылка для входа устарела. Вернитесь на сайт и нажмите «Войти» ещё раз.', { reply_markup: MENU });
  return tg.send(chat, `<b>Вход на сайт</b>\nНа сайте сейчас показан код <b>${esc(l.short)}</b>.\nЕсли код совпадает и входите вы — подтвердите. Если ссылку прислал кто-то другой, нажмите «Это не я».`, { reply_markup: kb([[['Подтвердить вход', 'login:' + code]], [['Это не я', 'nologin:' + code]]]) });
}

async function onCallback(q) {
  const chat = q.message && q.message.chat ? q.message.chat.id : q.from.id;
  const u = B.upsertTgUser(q.from);
  const st = getState(chat);
  const [k, a, b] = String(q.data || '').split(':');
  const arg = String(q.data || '').slice(k.length + 1);
  if (u.blocked) return tg.answer(q.id, 'Аккаунт заблокирован.', true);
  if (k === 'login' || k === 'nologin') {
    const l = D.get('SELECT * FROM logins WHERE code = ?', a);
    if (!l || l.status !== 'new' || D.now() - l.created_at > 600000) { await tg.answer(q.id, 'Ссылка устарела.', true); return; }
    if (k === 'nologin') { D.run("UPDATE logins SET status = 'denied' WHERE code = ?", a); await tg.answer(q.id); return tg.quiet(tg.edit(chat, q.message.message_id, 'Вход отклонён. Никто не получил доступ к аккаунту.')); }
    D.run("UPDATE logins SET status = 'ok', user_id = ?, token = ? WHERE code = ?", u.id, B.newSession(u.id), a);
    await tg.answer(q.id, 'Готово');
    return tg.quiet(tg.edit(chat, q.message.message_id, 'Вход подтверждён. Вернитесь на вкладку с сайтом — она откроется сама.'));
  }
  if (k === 'buy') { await tg.answer(q.id); return buy(chat, st, u, a); }
  if (k === 'chk') {
    const o = await pay.check(a, true);
    if (!o || o.user_id !== u.id) return tg.answer(q.id, 'Заказ не найден.', true);
    return tg.answer(q.id, o.status === 'paid' ? 'Оплата получена, баланс пополнен.' : o.status === 'canceled' ? 'Платёж отменён. Можно выбрать пакет заново.' : 'Оплата пока не пришла. Обычно это занимает до минуты.', true);
  }
  const d = st.draft;
  if (!d) { await tg.answer(q.id, 'Этот шаг уже неактуален.'); return; }
  await tg.answer(q.id);
  if (k === 'look') { if (LOOKS().some((l) => l[0] === a)) { d.preset = a; d.settings = null; d.lookDone = true; } return advance(chat, st, u); }
  if (k === 'asp') { if (ASPECTS.some((x) => x[0] === arg)) d.aspect = arg; setState(chat, st); return tg.quiet(tg.call('editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, reply_markup: formatKb(d, u) })); }
  if (k === 'q') { const r = parseInt(a, 10), f = parseInt(b, 10); if (qualityOptions(u).some(([x, y]) => x === r && y === f)) { d.res = r; d.fps = f; } setState(chat, st); return tg.quiet(tg.call('editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, reply_markup: formatKb(d, u) })); }
  if (k === 'w') {
    if (a === 'nolyrics') { d.lyricsDone = true; if (d.files.lyrics) { fs.rmSync(draftPath(d, d.files.lyrics), { force: true }); delete d.files.lyrics; } return advance(chat, st, u); }
    if (a === 'prod') { st.wait = 'prod'; setState(chat, st); return tg.send(chat, 'Кто сделал бит? Отправьте имя — в видео появится строка «prod. by …».'); }
    if (a === 'url') { st.wait = 'url'; setState(chat, st); return tg.send(chat, 'Отправьте ссылку на релиз. В финале видео появится QR-код и сама ссылка.'); }
    if (a === 'soc') { st.wait = 'soc'; setState(chat, st); return tg.send(chat, 'Пришлите соцсети одним сообщением, по одной в строке, до шести:\n<code>tg: @artist\nvk: vk.com/artist\nyoutube: youtube.com/@artist</code>\nОни сохранятся в профиле и появятся в финале видео. Чтобы убрать, отправьте «-».'); }
    if (a === 'metaok') { d.metaDone = true; return advance(chat, st, u); }
    if (a === 'formatok') { d.formatDone = true; return advance(chat, st, u); }
    if (a === 'look') { d.lookDone = false; return advance(chat, st, u); }
    if (a === 'format') { d.formatDone = false; return advance(chat, st, u); }
    if (a === 'meta') { d.metaDone = false; return advance(chat, st, u); }
    if (a === 'cancel') { dropDraft(st); setState(chat, st); return tg.send(chat, 'Отменено. Файлы удалены.', { reply_markup: MENU }); }
    if (a === 'buy') return tg.send(chat, packsText(), { reply_markup: kb(packButtons()) });
    if (a === 'go') return go(chat, st, u);
  }
}
function formatKb(d, u) {
  const q = qualityOptions(u);
  return kb([...ASPECTS.map(([id, n]) => [[(d.aspect === id ? '• ' : '') + n, 'asp:' + id]]), q.map(([r, f]) => [`${d.res === r && d.fps === f ? '• ' : ''}${B.resName(r)} · ${f}`, `q:${r}:${f}`]), [['Готово →', 'w:formatok']]]);
}

const state = { stop: false };
async function start() {
  if (!cfg.botEnabled) { console.log('[bot] BOT_TOKEN is not set: the bot is off'); return; }
  try {
    me = await tg.call('getMe');
    await tg.quiet(tg.call('setMyCommands', { commands: [{ command: 'new', description: 'Новое видео' }, { command: 'balance', description: 'Баланс и пакеты' }, { command: 'status', description: 'Что с моим видео' }, { command: 'site', description: 'Открыть сайт' }, { command: 'help', description: 'Инструкция' }, { command: 'cancel', description: 'Отменить текущий шаг' }] }));
    console.log(`[bot] @${me.username} is listening`);
  } catch (e) { console.error('[bot] cannot reach Telegram:', e.message); }
  tg.poll(async (u) => {
    try {
      if (u.message) await onMessage(u.message);
      else if (u.callback_query) await onCallback(u.callback_query);
    } catch (e) {
      console.error('[bot]', e);
      const chat = u.message ? u.message.chat.id : u.callback_query ? u.callback_query.from.id : 0;
      if (chat) await tg.quiet(tg.send(chat, 'Что-то пошло не так. Попробуйте ещё раз или начните заново: «Новое видео».'));
    }
  }, state);
  setInterval(() => { for (const [k, v] of upTokens) if (v.exp < Date.now()) upTokens.delete(k); }, 600000).unref();
}
const stop = () => { state.stop = true; };

module.exports = { start, stop, info, uploadedViaWeb, uploadToken, deliver, looksPath, LOOKS };
