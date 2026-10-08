'use strict';
// The front page: what the studio is, what it costs, where to start. Prices and limits come from the live settings.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rub = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
const resName = (r) => (r >= 2160 ? '4K' : r + 'p');
const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return `${n} ${a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b >= 2 && b <= 4 ? f[1] : f[2]}`; };
const KIND_NAMES = { lyric: 'Лирик-видео', edit: 'Эдиты', promo: 'Истории к релизу' };
// a tile cut from a sheet the studio draws: background-size and position from the sheet's geometry
function tileStyle(m, i, kind) {
  const x = m.pad + (i % m.cols) * (m.cw + m.pad), y = m.pad + Math.floor(i / m.cols) * (m.ch + m.lab + m.pad);
  const px = m.w > m.cw ? (x / (m.w - m.cw)) * 100 : 0, py = m.h > m.ch ? (y / (m.h - m.ch)) * 100 : 0;
  return `background-image:var(--sheet-${kind});background-size:${((m.w / m.cw) * 100).toFixed(3)}% ${((m.h / m.ch) * 100).toFixed(3)}%;background-position:${px.toFixed(3)}% ${py.toFixed(3)}%;aspect-ratio:${m.cw}/${m.ch}`;
}

const CSS = `
/* Layout: one column of wide bands; the hero is a working lyric screen, everything below is quiet glass. */
:root {
  --bg: #e8e4f1; --fg: #17141f; --muted: #5d566f; --accent: #c2255c; --accent-fg: #ffffff; --accent-soft: rgba(194, 37, 92, 0.13);
  --signal: #0b7f76;
  --glass: rgba(255, 255, 255, 0.5); --glass-hi: rgba(255, 255, 255, 0.55); --glass-rim: rgba(255, 255, 255, 0.8); --glass-low: rgba(23, 20, 31, 0.08);
  --field: rgba(255, 255, 255, 0.5); --field-line: rgba(23, 20, 31, 0.12);
  --shadow: 0 16px 44px rgba(40, 25, 70, 0.16); --bar: rgba(255, 255, 255, 0.82); --amb-a: 0.5;
  --stage: #100d18; --stage-fg: #efeaf6; --stage-muted: #a59db7; --stage-rim: rgba(255, 255, 255, 0.14);
  --sun-a: #ffb36b; --sun-b: #e2557a; --sky: #2a1a6e;
  --f-display: "Unbounded", "Golos Text", system-ui, sans-serif;
  --f-body: "Golos Text", system-ui, -apple-system, "Segoe UI", sans-serif;
  --f-mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  --f-lyric: "Montserrat", "Golos Text", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0e0c14; --fg: #f3eff9; --muted: #aaa2bd; --accent: #ff6b93; --accent-fg: #26101a; --accent-soft: rgba(255, 107, 147, 0.17);
    --signal: #55d6c8;
    --glass: rgba(38, 32, 54, 0.46); --glass-hi: rgba(255, 255, 255, 0.1); --glass-rim: rgba(255, 255, 255, 0.17); --glass-low: rgba(0, 0, 0, 0.35);
    --field: rgba(255, 255, 255, 0.07); --field-line: rgba(255, 255, 255, 0.13);
    --shadow: 0 20px 56px rgba(0, 0, 0, 0.45); --bar: rgba(26, 22, 38, 0.84); --amb-a: 0.42;
    --stage: #0a080f; --stage-fg: #efeaf6; --stage-muted: #a59db7; --stage-rim: rgba(255, 255, 255, 0.14);
    --sun-a: #ffb36b; --sun-b: #e2557a; --sky: #2a1a6e;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0e0c14; --fg: #f3eff9; --muted: #aaa2bd; --accent: #ff6b93; --accent-fg: #26101a; --accent-soft: rgba(255, 107, 147, 0.17);
  --signal: #55d6c8;
  --glass: rgba(38, 32, 54, 0.46); --glass-hi: rgba(255, 255, 255, 0.1); --glass-rim: rgba(255, 255, 255, 0.17); --glass-low: rgba(0, 0, 0, 0.35);
  --field: rgba(255, 255, 255, 0.07); --field-line: rgba(255, 255, 255, 0.13);
  --shadow: 0 20px 56px rgba(0, 0, 0, 0.45); --bar: rgba(26, 22, 38, 0.84); --amb-a: 0.42;
  --stage: #0a080f; --stage-fg: #efeaf6; --stage-muted: #a59db7; --stage-rim: rgba(255, 255, 255, 0.14);
  --sun-a: #ffb36b; --sun-b: #e2557a; --sky: #2a1a6e;
  color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 84px; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--f-body); font-size: 16px; line-height: 1.5; padding-inline: 20px; padding-block: 0 48px; }
body::before { content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none; opacity: var(--amb-a);
  background: radial-gradient(58vmax 52vmax at 8% 4%, #6a4fd0, transparent 66%), radial-gradient(54vmax 50vmax at 96% 22%, #e2557a, transparent 64%), radial-gradient(70vmax 56vmax at 46% 108%, #ffb36b, transparent 66%); }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px; }
.wrap { max-width: 1180px; margin-inline: auto; display: flex; flex-direction: column; gap: 84px; }
.glass { background-color: var(--glass); background-image: linear-gradient(140deg, var(--glass-hi), transparent 42%); -webkit-backdrop-filter: blur(26px) saturate(1.7); backdrop-filter: blur(26px) saturate(1.7); border: 1px solid var(--glass-rim); box-shadow: var(--shadow), inset 0 1px 0 var(--glass-hi), inset 0 -1px 0 var(--glass-low); }

/* header */
.top { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 10px); z-index: 20; margin-top: 12px; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 8px 8px 8px 16px; border-radius: 999px; background-color: var(--bar); }
.brand { display: flex; align-items: center; gap: 10px; text-decoration: none; min-width: 0; }
.brand .logo { width: 30px; height: 34px; flex: none; background: var(--fg); -webkit-mask: var(--logo) center / contain no-repeat; mask: var(--logo) center / contain no-repeat; }
.brand b { font-family: var(--f-display); font-weight: 700; font-size: 15px; white-space: nowrap; }
.brand i { font-family: var(--f-mono); font-style: normal; font-weight: 500; font-size: 12px; color: var(--accent); white-space: nowrap; }
.top nav { display: flex; gap: 4px; }
.top nav a { text-decoration: none; font-size: 14px; color: var(--muted); padding: 8px 12px; border-radius: 999px; }
.top nav a:hover { color: var(--fg); background: var(--field); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 46px; padding: 11px 22px; border-radius: 14px; border: 1px solid var(--field-line); background: var(--field); color: var(--fg); text-decoration: none; font-weight: 600; white-space: nowrap; box-shadow: inset 0 1px 0 var(--glass-hi); }
.btn:hover { border-color: var(--muted); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); box-shadow: 0 8px 22px var(--accent-soft), inset 0 1px 0 rgba(255, 255, 255, 0.35); }
.btn.primary:hover { filter: brightness(1.07); }
.top .btn { min-height: 40px; padding: 8px 18px; border-radius: 999px; font-size: 14px; }

/* hero */
.hero { display: grid; grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr); gap: 44px; align-items: center; padding-top: 34px; }
.eyebrow { font-family: var(--f-mono); font-size: 12px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--accent); margin: 0; }
h1 { font-family: var(--f-display); font-weight: 700; font-size: clamp(30px, 4.4vw, 52px); line-height: 1.1; letter-spacing: -0.015em; margin: 0; text-wrap: balance; }
.herotext { display: flex; flex-direction: column; gap: 20px; }
.lead { font-size: 18px; color: var(--muted); margin: 0; max-width: 34em; }
.cta { display: flex; gap: 10px; flex-wrap: wrap; }
.under { font-size: 14px; color: var(--muted); margin: 0; }
.facts { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 0; padding: 0; }
.facts li { font-family: var(--f-mono); font-size: 12px; padding: 6px 11px; border-radius: 999px; border: 1px solid var(--field-line); background: var(--field); white-space: nowrap; }

/* the lyric screen: the product's own picture, drawn in CSS */
.screen { container-type: inline-size; position: relative; aspect-ratio: 16 / 10; max-width: 100%; border-radius: 26px; overflow: hidden; background: var(--stage); border: 1px solid var(--stage-rim); box-shadow: var(--shadow); color: var(--stage-fg); isolation: isolate; }
.screen::before { content: ""; position: absolute; inset: -20%; z-index: -1; background: radial-gradient(42% 46% at 22% 38%, var(--sun-a), transparent 70%), radial-gradient(50% 55% at 78% 20%, var(--sky), transparent 72%), radial-gradient(60% 50% at 60% 100%, var(--sun-b), transparent 70%); opacity: 0.62; filter: blur(30px); animation: drift 14s ease-in-out infinite alternate; }
.screen .mark { position: absolute; top: 5%; right: 4.5%; display: flex; align-items: center; gap: 7px; font-family: var(--f-display); font-weight: 500; font-size: 10px; font-size: 1.9cqw; opacity: 0.85; }
.screen .mark span { width: 1.9em; height: 2.1em; background: var(--stage-fg); -webkit-mask: var(--logo) center / contain no-repeat; mask: var(--logo) center / contain no-repeat; }
.scene { position: absolute; inset: 0; display: grid; grid-template-columns: 31% minmax(0, 1fr); gap: 5.5%; align-items: center; padding: 8% 5% 16% 6%; }
.cover { display: grid; gap: 10%; justify-items: center; animation: pulse 0.545s ease-out infinite; }
.cover .art { width: 100%; aspect-ratio: 1; border-radius: 9%; background: linear-gradient(180deg, var(--sky) 0 46%, var(--sun-b) 62%, var(--sun-a) 78%, #1a1030 78% 100%); position: relative; overflow: hidden; box-shadow: 0 18px 44px rgba(0, 0, 0, 0.5); }
.cover .art::before { content: ""; position: absolute; left: 50%; top: 58%; width: 44%; aspect-ratio: 1; border-radius: 50%; transform: translate(-50%, -50%); background: radial-gradient(circle, #fff3d0, var(--sun-a) 55%, transparent 72%); }
.cover .art::after { content: ""; position: absolute; inset: auto 0 0 0; height: 40%; background: linear-gradient(90deg, #14102a 0 9%, transparent 9% 13%, #14102a 13% 24%, transparent 24% 27%, #14102a 27% 34%, transparent 34% 40%, #14102a 40% 55%, transparent 55% 59%, #14102a 59% 70%, transparent 70% 74%, #14102a 74% 88%, transparent 88% 91%, #14102a 91% 100%); -webkit-mask: linear-gradient(90deg, #000 0 9%, transparent 0) 0 100% / 100% 70% no-repeat, linear-gradient(#000, #000) 13% 100% / 11% 100% no-repeat, linear-gradient(#000, #000) 31% 100% / 7% 78% no-repeat, linear-gradient(#000, #000) 52% 100% / 15% 92% no-repeat, linear-gradient(#000, #000) 73% 100% / 11% 66% no-repeat, linear-gradient(#000, #000) 100% 100% / 14% 84% no-repeat; mask: linear-gradient(90deg, #000 0 9%, transparent 0) 0 100% / 100% 70% no-repeat, linear-gradient(#000, #000) 13% 100% / 11% 100% no-repeat, linear-gradient(#000, #000) 31% 100% / 7% 78% no-repeat, linear-gradient(#000, #000) 52% 100% / 15% 92% no-repeat, linear-gradient(#000, #000) 73% 100% / 11% 66% no-repeat, linear-gradient(#000, #000) 100% 100% / 14% 84% no-repeat; }
.cover figcaption { text-align: center; font-family: var(--f-lyric); line-height: 1.2; }
.cover figcaption b { display: block; font-weight: 800; font-size: 14px; font-size: 3cqw; }
.cover figcaption span { font-size: 10px; font-size: 1.9cqw; color: var(--stage-muted); }
.lyrics { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.42em; font-family: var(--f-lyric); font-weight: 800; font-size: 16px; font-size: 3.5cqw; line-height: 1.18; white-space: nowrap; }
.lyrics li { color: transparent; -webkit-background-clip: text; background-clip: text; background-image: linear-gradient(90deg, var(--stage-fg) 0 50%, rgba(239, 234, 246, 0.42) 50% 100%); background-size: 200% 100%; background-position: 100% 0; opacity: 0.36; transform-origin: 0 50%; animation: line 8.8s linear infinite; }
.lyrics li:nth-child(2) { animation-delay: 2.2s; }
.lyrics li:nth-child(3) { animation-delay: 4.4s; }
.lyrics li:nth-child(4) { animation-delay: 6.6s; }
.viz { position: absolute; inset: auto 0 0 0; height: 15%; display: flex; align-items: flex-end; gap: 0.7%; padding-inline: 2%; opacity: 0.55; }
.viz i { flex: 1 1 0; height: 100%; border-radius: 99px 99px 0 0; background: var(--sun-a); transform-origin: 50% 100%; transform: scaleY(var(--h, 0.4)); animation: bar 0.545s ease-out infinite; animation-delay: var(--d, 0s); }
@keyframes line { 0% { opacity: 0.36; background-position: 100% 0; transform: scale(0.96); } 1.5% { opacity: 1; transform: scale(1); } 23% { opacity: 1; background-position: 0 0; transform: scale(1); } 26%, 100% { opacity: 0.36; background-position: 0 0; transform: scale(0.96); } }
@keyframes pulse { 0% { transform: scale(1.022); } 100% { transform: scale(1); } }
@keyframes bar { 0% { transform: scaleY(calc(var(--h, 0.4) * 1.9)); } 100% { transform: scaleY(var(--h, 0.4)); } }
@keyframes drift { to { transform: translate(4%, -3%) scale(1.08); } }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .screen::before, .cover, .viz i, .lyrics li { animation: none; }
  .lyrics li:nth-child(2) { opacity: 1; background-position: 45% 0; }
}

/* sections */
section { display: flex; flex-direction: column; gap: 26px; }
h2 { font-family: var(--f-display); font-weight: 700; font-size: clamp(22px, 2.8vw, 32px); line-height: 1.15; letter-spacing: -0.01em; margin: 0; text-wrap: balance; }
.sub { color: var(--muted); margin: -12px 0 0; max-width: 46em; }
h3 { font-size: 17px; font-weight: 600; margin: 0; }
.feats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 30px 34px; }
.feats div { display: grid; gap: 6px; align-content: start; border-top: 2px solid var(--fg); padding-top: 14px; }
.feats p, .steps p, .ways p { margin: 0; color: var(--muted); font-size: 15px; }
.steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; counter-reset: s; }
.steps li { counter-increment: s; border-radius: 22px; padding: 20px; display: grid; gap: 8px; align-content: start; }
.steps li::before { content: counter(s); font-family: var(--f-display); font-weight: 700; font-size: 30px; line-height: 1; color: var(--accent); }
.gal { display: flex; flex-direction: column; gap: 18px; }
.gal > input { position: absolute; opacity: 0; pointer-events: none; width: 1px; height: 1px; }
.galtabs { display: inline-flex; flex-wrap: nowrap; gap: 2px; padding: 4px; border-radius: 999px; align-self: flex-start; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.galtabs::-webkit-scrollbar { display: none; }
.galtabs label { cursor: pointer; padding: 9px 16px; border-radius: 999px; font-weight: 600; font-size: 15px; color: var(--muted); white-space: nowrap; }
.galtabs label b { font-family: var(--f-mono); font-weight: 500; font-size: 12px; margin-left: 6px; opacity: 0.8; }
.galtabs label:hover { color: var(--fg); }
.galpane { display: none; }
#lk-lyric:checked ~ .galtabs label[for="lk-lyric"], #lk-edit:checked ~ .galtabs label[for="lk-edit"], #lk-promo:checked ~ .galtabs label[for="lk-promo"] { background: var(--fg); color: var(--bg); }
#lk-lyric:focus-visible ~ .galtabs label[for="lk-lyric"], #lk-edit:focus-visible ~ .galtabs label[for="lk-edit"], #lk-promo:focus-visible ~ .galtabs label[for="lk-promo"] { outline: 2px solid var(--accent); outline-offset: 2px; }
#lk-lyric:checked ~ .gp-lyric, #lk-edit:checked ~ .gp-edit, #lk-promo:checked ~ .gp-promo { display: block; }
.looks { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; list-style: none; margin: 0; padding: 0; }
.looks.tall { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.looks li { display: grid; gap: 7px; align-content: start; }
.looks .shot { border-radius: 12px; background-color: var(--stage); background-repeat: no-repeat; border: 1px solid var(--field-line); }
.looks span { font-size: 14px; font-weight: 600; }
.galnote { margin: 4px 0 0; }
.ways { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.ways article { border-radius: 24px; padding: 24px; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.ways ul, .pack ul { margin: 0; padding-left: 18px; display: grid; gap: 5px; font-size: 15px; }
.ways .btn { margin-top: auto; }
.tagline { font-family: var(--f-mono); font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--muted); }
.packs { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.pack { border-radius: 22px; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.pack.free { background-color: var(--accent-soft); }
.pack h3 { font-family: var(--f-display); font-weight: 700; font-size: 18px; }
.price { display: grid; gap: 2px; }
.price b { font-family: var(--f-display); font-weight: 700; font-size: 28px; line-height: 1.1; font-variant-numeric: tabular-nums; }
.price span { font-size: 13.5px; color: var(--muted); }
.pack ul { flex: 1 1 auto; align-content: start; }
.pack .btn { width: 100%; }
.note { font-size: 14px; color: var(--muted); margin: 0; max-width: 60em; }
.faq { display: grid; gap: 10px; max-width: 820px; }
.faq details { border-radius: 18px; padding: 4px 18px; }
.faq summary { cursor: pointer; font-weight: 600; padding-block: 12px; }
.faq p { margin: 0 0 14px; color: var(--muted); font-size: 15px; }
.closing { border-radius: 30px; padding: 40px 28px; align-items: center; text-align: center; gap: 18px; }
.closing .cta { justify-content: center; }
footer { display: flex; flex-wrap: wrap; gap: 10px 24px; justify-content: space-between; font-size: 14px; color: var(--muted); border-top: 1px solid var(--field-line); padding-top: 22px; }
footer nav { display: flex; flex-wrap: wrap; gap: 6px 18px; }
footer a { text-underline-offset: 3px; }

@media (max-width: 900px) {
  body { padding-inline: 16px; }
  .wrap { gap: 60px; }
  .top nav { display: none; }
  .hero { grid-template-columns: minmax(0, 1fr); gap: 26px; padding-top: 18px; }
  .feats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 20px; }
  .steps, .ways { grid-template-columns: minmax(0, 1fr); }
  .looks { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .looks.tall { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
}
@media (max-width: 480px) {
  .feats { grid-template-columns: minmax(0, 1fr); }
  .brand i { display: none; }
  .cta .btn { flex: 1 1 100%; }
  .lead { font-size: 16.5px; }
  .galtabs label { padding: 8px 11px; font-size: 14px; }
  .galtabs label b { margin-left: 4px; }
}
`;

function render(o) {
  const s = o.settings, studio = esc(o.studioUrl || '/studio');
  const bot = o.bot ? `https://t.me/${esc(o.bot)}` : '';
  const asset = o.assetUrl || ((n) => '/assets/' + n);
  const ext = /^https?:/.test(o.studioUrl || '') ? ' target="_blank" rel="noopener"' : '';
  const botBtn = (cls, text) => (bot ? `<a class="btn${cls}" href="${bot}" target="_blank" rel="noopener">${text}</a>` : '');
  const bars = Array.from({ length: 44 }, (_, i) => { const h = 0.18 + 0.5 * Math.abs(Math.sin(i * 0.47) * Math.cos(i * 0.13)) * Math.exp(-i / 34) + 0.1 * ((i * 7) % 5) / 5; return `<i style="--h:${h.toFixed(2)};--d:${(-(i % 6) * 0.03).toFixed(2)}s"></i>`; }).join('');
  const trial = s.signupCredits > 0 ? `<article class="pack glass free"><h3>Пробный</h3><div class="price"><b>0&nbsp;₽</b><span>${plural(s.signupCredits, ['видео', 'видео', 'видео'])} при регистрации</span></div><ul><li>${resName(s.trialRes)} и ${s.trialFps} кадров в секунду</li><li>${s.trialMark ? 'со знаком talk with a star в углу' : 'без обязательного знака'}</li><li>все стили и настройки</li></ul><a class="btn" href="${studio}"${ext}>Попробовать</a></article>` : '';
  const packs = o.packs.map((p) => `<article class="pack glass"><h3>${esc(p.name)}</h3><div class="price"><b>${rub(p.price)}</b><span>${plural(p.credits, ['видео', 'видео', 'видео'])} · ${rub(p.price / p.credits)} за видео</span></div><ul><li>до ${resName(p.maxRes)} и ${p.maxFps} кадров в секунду</li><li>${p.mark ? 'со знаком talk with a star' : 'свой логотип и надпись или без них'}</li><li>${p.days ? 'действует ' + plural(p.days, ['день', 'дня', 'дней']) : 'без срока действия'}</li></ul><a class="btn primary" href="${studio}#packs"${ext}>Выбрать</a></article>`).join('');
  // the galleries: one tab per mode, tiles cut from the sheets
  const sheets = o.sheets || {};
  const kinds = ['lyric', 'edit', 'promo'].filter((k) => sheets[k] && sheets[k].styles && sheets[k].styles.length);
  const count = (k) => (sheets[k] ? sheets[k].styles.length : 0);
  const total = kinds.reduce((n, k) => n + count(k), 0);
  const gallery = kinds.length ? `<div class="gal">${kinds.map((k, i) => `<input type="radio" name="lk" id="lk-${k}"${i ? '' : ' checked'}>`).join('')}
    <div class="galtabs glass" role="group" aria-label="Режим">${kinds.map((k) => `<label for="lk-${k}">${KIND_NAMES[k]}<b>${count(k)}</b></label>`).join('')}</div>
    ${kinds.map((k) => { const m = sheets[k]; return `<div class="galpane gp-${k}"><ul class="looks${m.ch > m.cw ? ' tall' : ''}">${m.styles.map(([, n], i) => `<li><div class="shot" role="img" aria-label="${esc(KIND_NAMES[k])}, стиль «${esc(n)}»: кадр из демо-трека" style="${tileStyle(m, i, k)}"></div><span>${esc(n)}</span></li>`).join('')}</ul></div>`; }).join('')}
  </div>` : '';
  const nLyric = count('lyric') || 12, nPromo = count('promo') || 5, nEdit = count('edit') || 6;
  const faq = [
    ['Что такое TTML и где его взять', 'TTML — текст песни, размеченный по времени: по строкам или по словам. Его выгружает редактор синхронизации текста у дистрибьютора; подойдут и сторонние редакторы субтитров и караоке. Подходит и LRC — простой формат вида «[00:12.50] строка».'],
    ['Какие файлы нужны', 'Обложка (JPG, PNG, WebP), трек (WAV, FLAC, MP3, M4A) и текст с таймингом (TTML или LRC). Для эдита — ещё ваши видео и фото. Без текста получится видео с обложкой и визуализацией.'],
    ['Как сделать TTML, если его нет', 'В студии: «Трек» → «Сделать TTML». Вставьте слова, включите трек и нажимайте пробел в начале каждой строки или слова. Потом проверьте в видео, подвиньте строки и скачайте файл.'],
    ['Что считается одним видео', 'Один собранный файл MP4. Предпросмотр, любые настройки и кадр PNG бесплатны и не ограничены. Если сборка остановлена или сорвалась, видео возвращается на баланс.'],
    ['Сколько времени занимает сборка', 'На сайте видео рисует ваш компьютер: на современном компьютере трек в три минуты в 1080p собирается за несколько минут, 4K и 120 кадров — заметно дольше. В боте видео собирает сервер и присылает, когда оно готово.'],
    ['Куда попадают мои файлы', 'На сайте обложка, трек и текст остаются в браузере. На сервер уходит только готовое видео — и только если вы сами нажали «Получить ссылку». Боту файлы нужны для сборки; после неё они удаляются, а ссылка на видео живёт ' + plural(s.videoDays, ['день', 'дня', 'дней']) + '.'],
    ['Как добавить соцсети', 'В студии: «Трек» → «Соцсети». Выберите сеть и впишите ник или ссылку — для артиста и для лейбла отдельно. Они встанут в финал лирик-видео и эдита, а в историю к релизу — если включить. В боте — кнопка «Соцсети» на шаге подписей; соцсети сохраняются в профиле и подставляются в следующие видео.'],
    ['Как оплатить', 'В студии или в боте: карта, СБП и другие способы на странице ЮKassa. Пакет зачисляется сразу после оплаты, баланс общий для сайта и бота.'],
  ].map(([q, a]) => `<details class="glass"><summary>${q}</summary><p>${a}</p></details>`).join('');
  const foot = [`<a href="${studio}"${ext}>Студия</a>`, bot ? `<a href="${bot}" target="_blank" rel="noopener">Бот в Telegram</a>` : '', s.offerUrl ? `<a href="${esc(s.offerUrl)}" target="_blank" rel="noopener">Оферта</a>` : '', '<a href="https://twaslabel.ru" target="_blank" rel="noopener">Лейбл talk with a star</a>'].filter(Boolean).join('');

  const head = `<title>${esc(o.title || 'talk with a star // tools')}</title>
<meta name="description" content="Студия лирик-видео: обложка, трек и текст с таймингом превращаются в MP4 до 4K с анимацией под бит. В браузере и в Telegram.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700&family=Golos+Text:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Montserrat:wght@600;800&display=swap">
<style>:root{--logo:url(${asset('logo.png')});${kinds.map((k) => `--sheet-${k}:url(${asset(`looks-${k}.jpg`)})`).join(';')}}${CSS}</style>`;
  const body = `<div class="wrap">
<header class="top glass">
  <a class="brand" href="#top" aria-label="talk with a star tools"><span class="logo" aria-hidden="true"></span><b>talk with a star</b><i>// tools</i></a>
  <nav aria-label="Разделы"><a href="#features">Возможности</a><a href="#looks">Стили</a><a href="#prices">Цены</a><a href="#faq">Вопросы</a></nav>
  <a class="btn primary" href="${studio}"${ext}>Открыть студию</a>
</header>

<main class="wrap" id="top">
<section class="hero">
  <div class="herotext">
    <p class="eyebrow">Студия лирик-видео</p>
    <h1>Лирик-видео из обложки, трека и текста</h1>
    <p class="lead">Загрузите три файла и выберите стиль. Студия найдёт бит, расставит строки по времени и соберёт MP4 до 4K. А ещё — эдиты до минуты на ваших клипах и истории к релизу для сторис.</p>
    <div class="cta"><a class="btn primary" href="${studio}"${ext}>Открыть студию</a>${botBtn('', 'Собрать в Telegram')}</div>
    <p class="under">${s.signupCredits > 0 ? 'Первое видео бесплатно. ' : ''}Предпросмотр и все настройки открыты без регистрации.</p>
    <ul class="facts" aria-label="Коротко"><li>лирик-видео · эдиты · истории к релизу</li><li>${plural(total || nLyric, ['готовый стиль', 'готовых стиля', 'готовых стилей'])}</li><li>16:9 · 9:16 · 1:1 · 4:5</li><li>до 4K и 120 кадр/с</li><li>TTML и LRC</li></ul>
  </div>
  <div class="screen" role="img" aria-label="Пример кадра: обложка трека «Фонари», четыре строки текста, активная строка закрашивается по словам, внизу столбики визуализатора">
    <div class="mark" aria-hidden="true">talk with a star<span></span></div>
    <div class="scene" aria-hidden="true">
      <figure class="cover" style="margin:0"><div class="art"></div><figcaption><b>Фонари</b><span>talk with a star</span></figcaption></figure>
      <ol class="lyrics"><li>Город гасит фонари</li><li>Мы считаем до зари</li><li>Бит стучит в моей груди</li><li>Не молчи, договори</li></ol>
    </div>
    <div class="viz" aria-hidden="true">${bars}</div>
  </div>
</section>

<section id="features">
  <h2>Что умеет студия</h2>
  <div class="feats">
    <div><h3>Анимация под бит</h3><p>Студия сама находит удары, бас и темп трека. На них откликаются фон, обложка, текст и частицы; двенадцать эквалайзеров, одиннадцать видов частиц, наклон камеры, глитч и стробоскоп.</p></div>
    <div><h3>Эдиты до минуты</h3><p>Вертикальный ролик на ваших видео и фото: кадры меняются на долях бита. Одиннадцать переходов, цвет кадров от ч/б и дуотона до VHS, ${plural(nEdit, ['готовый стиль', 'готовых стиля', 'готовых стилей'])}.</p></div>
    <div><h3>История к релизу</h3><p>Обложка в одной из ${nPromo === 15 ? 'пятнадцати' : nPromo} анимаций — от пластинки и диска до плеера и полароида, — сингл, EP или альбом, дата выхода, призыв, десять способов появления текста и девять эффектов, бегущие строки и ленты со своим текстом, бейджи площадок с бликами в нужном порядке.</p></div>
    <div><h3>Припев одним нажатием</h3><p>Для эдита и истории студия сама находит припевы и куплеты — по тексту и по звуку — и предлагает их. Свой отрывок задаётся вручную или перетаскиванием прямо на шкале.</p></div>
    <div><h3>Соцсети артиста и лейбла</h3><p>Впишите ники один раз — они встанут в финал лирик-видео и эдита и в истории к релизу. Соцсети лейбла подставляются всем артистам сами.</p></div>
    <div><h3>Подсветка по словам</h3><p>TTML с таймингом слов закрашивает строку слово за словом. Понимает дуэты, бэк-вокал и перевод.</p></div>
    <div><h3>TTML за пару прослушиваний</h3><p>Нет файла с таймингом — вставьте слова и отстучите строки пробелом под музыку. Файл подойдёт и дистрибьютору.</p></div>
    <div><h3>Финал и превью для YouTube</h3><p>Когда текст закончился, появляется карточка релиза: QR-код, ссылка, соцсети и площадки. Превью 1920×1080 с обложкой, названием и знаком лейбла — одной кнопкой.</p></div>
    <div><h3>Настройка до мелочей</h3><p>Шестнадцать сцен фона, двадцать шрифтов, цвета с обложки, четыре формата кадра, визуализаторы, частицы, плёнка. Свои стили сохраняются.</p></div>
  </div>
</section>

<section id="how">
  <h2>Три шага до готового файла</h2>
  <ol class="steps">
    <li class="glass"><h3>Загрузите материалы</h3><p>Обложка, трек и текст с таймингом. Файлы можно перетащить на страницу или прислать боту.</p></li>
    <li class="glass"><h3>Выберите стиль</h3><p>Листайте готовые стили и смотрите на своём треке. Понравившийся можно довести вручную.</p></li>
    <li class="glass"><h3>Соберите видео</h3><p>MP4 сохраняется на устройство. Одна кнопка даёт ссылку на страницу с видео или шлёт его в Telegram.</p></li>
  </ol>
</section>

${gallery ? `<section id="looks">
  <h2>${plural(total, ['готовый стиль', 'готовых стиля', 'готовых стилей'])}</h2>
  <p class="sub">Один и тот же демо-трек в каждом стиле: ${kinds.map((k) => `${KIND_NAMES[k].toLowerCase()} — ${count(k)}`).join(', ')}. Цвета студия берёт с вашей обложки, поэтому на вашем релизе они будут своими. Любой стиль можно довести вручную и сохранить как свой.</p>
  ${gallery}
</section>` : ''}

<section id="ways">
  <h2>На сайте или в Telegram</h2>
  <p class="sub">Аккаунт и баланс общие: купили пакет в боте, собрали видео на сайте, и наоборот.</p>
  <div class="ways">
    <article class="glass"><span class="tagline">Сайт</span><h3>Студия в браузере</h3><ul><li>все настройки и предпросмотр вживую</li><li>до 4K и 120 кадров в секунду</li><li>видео собирает ваш компьютер, файлы не уходят с устройства</li></ul><a class="btn primary" href="${studio}"${ext}>Открыть студию</a></article>
    <article class="glass"><span class="tagline">Telegram</span><h3>Бот по шагам</h3><ul><li>шесть шагов в чате: обложка, трек, текст, подписи и соцсети, стиль, формат</li><li>${plural(nLyric, ['стиль', 'стиля', 'стилей'])} лирик-видео</li><li>до ${resName(s.botMaxRes)} и ${s.botMaxFps} кадров в секунду</li><li>видео собирает сервер и присылает файл и ссылку</li></ul>${botBtn('', 'Открыть бота') || '<span class="note">Бот скоро появится.</span>'}</article>
  </div>
</section>

<section id="prices">
  <h2>Цены</h2>
  <p class="sub">Платите за собранные видео. Чем больше пакет, тем дешевле каждое.</p>
  <div class="packs">${trial}${packs}</div>
  <p class="note">Трек до ${Math.round(s.maxDuration / 60)} минут, до ${plural(s.dailyLimit, ['видео', 'видео', 'видео'])} в сутки на аккаунт. Оплата проходит на странице ЮKassa.${s.offerUrl ? ` Оплачивая, вы принимаете <a href="${esc(s.offerUrl)}" target="_blank" rel="noopener">оферту</a>.` : ''}${s.support ? ` Вопросы: ${esc(s.support)}.` : ''}</p>
</section>

<section id="faq">
  <h2>Вопросы</h2>
  <div class="faq">${faq}</div>
</section>

<section class="closing glass">
  <h2>Попробуйте на своём треке</h2>
  <p class="lead">В студии уже открыт демо-трек: стили можно листать сразу, без файлов и без входа.</p>
  <div class="cta"><a class="btn primary" href="${studio}"${ext}>Открыть студию</a>${botBtn('', 'Собрать в Telegram')}</div>
</section>
</main>

<footer><span>© ${new Date().getFullYear()} talk with a star</span><nav aria-label="Ссылки">${foot}</nav></footer>
</div>`;
  if (o.fragment) return head + '\n' + body + '\n';
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="icon" href="${asset('icon.png')}">
<meta property="og:title" content="talk with a star // tools"><meta property="og:description" content="Лирик-видео из обложки, трека и текста: до 4K, с анимацией под бит. В браузере и в Telegram.">${o.publicUrl ? `<meta property="og:image" content="${esc(o.publicUrl)}/looks.jpg">` : ''}
${head}
</head><body>
${body}
</body></html>`;
}
module.exports = { render };
