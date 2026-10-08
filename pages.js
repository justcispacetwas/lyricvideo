'use strict';
// Small standalone pages: a finished video, the upload page the bot links to, and the return page after payment.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const shell = (title, body, head = '') => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>${head}
<style>
:root{color-scheme:dark;--bg:#0e0c14;--fg:#f3eff9;--muted:#aaa2bd;--accent:#ff6b93;--glass:rgba(38,32,54,.5);--rim:rgba(255,255,255,.16)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;padding:20px}
body::before{content:"";position:fixed;inset:0;z-index:-1;opacity:.45;background:radial-gradient(60vmax 50vmax at 10% 0,#6a4fd0,transparent 65%),radial-gradient(55vmax 50vmax at 95% 25%,#e2557a,transparent 65%),radial-gradient(70vmax 55vmax at 45% 110%,#ffb36b,transparent 65%)}
main{width:min(100%,880px);background:var(--glass);border:1px solid var(--rim);border-radius:24px;padding:20px;display:grid;gap:14px;-webkit-backdrop-filter:blur(26px) saturate(1.6);backdrop-filter:blur(26px) saturate(1.6);box-shadow:0 20px 56px rgba(0,0,0,.45)}
h1{margin:0;font-size:22px;line-height:1.25;text-wrap:balance}
p{margin:0;color:var(--muted)}
small{color:var(--muted);font:500 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.09em;text-transform:uppercase}
video{width:100%;max-height:70vh;border-radius:14px;background:#000;display:block}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:10px 20px;border-radius:12px;border:1px solid var(--rim);background:rgba(255,255,255,.07);color:var(--fg);text-decoration:none;font:inherit;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#26101a;font-weight:600}
.row{display:flex;gap:10px;flex-wrap:wrap}
.drop{border:1px dashed var(--rim);border-radius:16px;padding:22px;text-align:center;background:rgba(255,255,255,.05);cursor:pointer}
.drop.over{border-color:var(--accent);border-style:solid}
ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
li{display:grid;gap:5px;font-size:14px}
.bar{height:8px;border-radius:4px;background:rgba(255,255,255,.1);overflow:hidden}.bar i{display:block;height:100%;width:0;background:var(--accent)}
.ok{color:#55d6c8}.bad{color:#f0b35a}
</style></head><body><main>${body}</main></body></html>`;

function video(v, url, fileUrl, days) {
  const title = v.name.replace(/\.mp4$/i, '');
  const head = `<meta property="og:title" content="${esc(title)}"><meta property="og:type" content="video.other"><meta property="og:video" content="${esc(fileUrl)}"><meta property="og:video:type" content="video/mp4"><meta property="og:site_name" content="talk with a star // tools">`;
  const left = Math.max(0, Math.ceil((v.expires_at - Date.now()) / 86400000));
  return shell(title, `<small>talk with a star // tools</small>
<h1>${esc(title)}</h1>
<video src="${esc(fileUrl)}" controls playsinline preload="metadata"></video>
<div class="row"><a class="btn primary" href="${esc(fileUrl)}?dl=1" download="${esc(v.name)}">Скачать видео · ${(v.size / 1048576).toFixed(v.size < 10485760 ? 1 : 0)} МБ</a>
<button class="btn" type="button" id="cp">Скопировать ссылку</button></div>
<p>Ссылка будет работать ещё ${left} дн. Сохраните файл, если он нужен дольше.</p>
<script>document.getElementById('cp').onclick=function(){var b=this;(navigator.clipboard?navigator.clipboard.writeText(${JSON.stringify(url)}):Promise.reject()).then(function(){b.textContent='Ссылка скопирована'},function(){prompt('Ссылка на видео',${JSON.stringify(url)})})}</script>`, head);
}

const gone = () => shell('Видео недоступно', '<small>talk with a star // tools</small><h1>Этого видео здесь уже нет</h1><p>Срок хранения ссылки истёк, или ссылка скопирована не полностью. Попросите автора собрать видео заново.</p>');

function upload(token, maxMb) {
  return shell('Загрузка файлов для бота', `<small>talk with a star // tools</small>
<h1>Файлы для бота</h1>
<p>Сюда можно загрузить то, что не помещается в чат: трек в WAV, обложку, текст .ttml или .lrc. Файл сразу попадёт в начатое в боте видео.</p>
<label class="drop" id="drop"><b>Выберите файлы</b><br><span style="color:var(--muted)">или перетащите их сюда · до ${maxMb} МБ каждый</span><input type="file" id="f" multiple hidden></label>
<ul id="list"></ul>
<p id="done" hidden class="ok">Готово. Вернитесь в Telegram — бот уже продолжил.</p>
<script>
(function(){
var list=document.getElementById('list'),drop=document.getElementById('drop'),inp=document.getElementById('f'),MAX=${maxMb}*1048576;
function add(file){
  var li=document.createElement('li'),t=document.createElement('span'),bar=document.createElement('div'),i=document.createElement('i');
  t.textContent=file.name;bar.className='bar';bar.appendChild(i);li.appendChild(t);li.appendChild(bar);list.appendChild(li);
  if(file.size>MAX){t.textContent=file.name+' — файл больше '+${maxMb}+' МБ';t.className='bad';return}
  var x=new XMLHttpRequest();
  x.open('PUT','/api/up/${token}?name='+encodeURIComponent(file.name));
  x.setRequestHeader('content-type',file.type||'application/octet-stream');
  x.upload.onprogress=function(e){if(e.lengthComputable)i.style.width=(e.loaded/e.total*100).toFixed(1)+'%'};
  x.onload=function(){var j=null;try{j=JSON.parse(x.responseText)}catch(e){}
    if(j&&j.ok){i.style.width='100%';t.textContent=file.name+' — получен';t.className='ok';document.getElementById('done').hidden=false}
    else{t.textContent=file.name+' — '+(j&&j.error||'не удалось загрузить');t.className='bad'}};
  x.onerror=function(){t.textContent=file.name+' — связь оборвалась, попробуйте ещё раз';t.className='bad'};
  x.send(file);
}
inp.onchange=function(){[].forEach.call(inp.files,add);inp.value=''};
drop.ondragover=function(e){e.preventDefault();drop.classList.add('over')};
drop.ondragleave=function(){drop.classList.remove('over')};
drop.ondrop=function(e){e.preventDefault();drop.classList.remove('over');[].forEach.call(e.dataTransfer.files,add)};
})();
</script>`);
}
const uploadGone = () => shell('Ссылка устарела', '<small>talk with a star // tools</small><h1>Ссылка для загрузки устарела</h1><p>Она работает час. Вернитесь в бота и нажмите «Новое видео» — он пришлёт новую.</p>');

function paid(orderId, bot) {
  return shell('Оплата', `<small>talk with a star // tools</small>
<h1 id="h">Проверяю оплату…</h1>
<p id="p">Обычно это занимает несколько секунд.</p>
<div class="row"><a class="btn primary" href="/studio">Открыть студию</a>${bot ? `<a class="btn" href="https://t.me/${esc(bot)}">Вернуться в бота</a>` : ''}</div>
<script>
(function(){var n=0,h=document.getElementById('h'),p=document.getElementById('p');
function go(){fetch('/api/pay/status?order=${encodeURIComponent(orderId)}').then(function(r){return r.json()}).then(function(j){
  if(j.status==='paid'){h.textContent='Оплата прошла';p.textContent='Пакет «'+j.pack+'» уже на балансе. Если студия открыта в другой вкладке, вернитесь в неё — баланс обновился сам.'}
  else if(j.status==='canceled'){h.textContent='Платёж не прошёл';p.textContent='Деньги не списаны. Выберите пакет ещё раз в студии или в боте.'}
  else if(++n<60)setTimeout(go,3000);
  else{h.textContent='Оплата ещё не подтверждена';p.textContent='Банк иногда отвечает с задержкой. Баланс пополнится сам, как только платёж подтвердится.'}
},function(){if(++n<60)setTimeout(go,4000)})}
go()})();
</script>`);
}
module.exports = { video, gone, upload, uploadGone, paid, esc };
