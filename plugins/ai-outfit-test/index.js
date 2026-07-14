// =============================================================================
// AI 换装测试插件入口（runtime_type: nodejs）
// -----------------------------------------------------------------------------
// 测试平台「带参考图的图片编辑」能力（image.edit）。
//
// 关键机制（见 packages/plugin-sdk/src/index.ts 的 invokeScriptBridge +
// Rust 桥 plugin_llm_bridge.rs 的 route_image_edit）：
//  - 桌面壳启动本进程时注入两个环境变量：
//      LINGFANG_PLUGIN_BRIDGE_URL   = http://127.0.0.1:<port>   （基础 endpoint）
//      LINGFANG_PLUGIN_BRIDGE_TOKEN = <session token>             （当前进程会话）
//  - 脚本不持有任何密钥；把 token 放进 X-LingFang-Plugin-Token 头，POST 到桥的
//    /image/edit（body: {prompt, images:[{filename,mimeType,data(base64)}], model, n, size}）。
//  - 桥校验 manifest 声明的 image.edit 能力，解码 base64 重建 multipart，转发到平台 relay
//    /api/relay/v1/images/edits（按张计费，扣团队灵石），relay 按命中渠道注入上游 model。
//  - 桥返回 {images:[url|data:base64...]}，本服务原样回传给网页展示。
//
// 约束：sandbox 无 node_modules，仅用 Node.js 内置模块（http/net/child_process）。
// =============================================================================

const http = require('http');
const net = require('net');
const { exec } = require('child_process');

// 平台本地桥地址与 token 只取宿主注入值，不提供自定义 fallback（AI 策略要求）。
const BRIDGE_URL = process.env.LINGFANG_PLUGIN_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.LINGFANG_PLUGIN_BRIDGE_TOKEN;

const PORT_START = 42184;
const PORT_END = 42284;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024; // 参考图 base64 可达数十 MB

/** 在 [start, end] 范围内找第一个可用 TCP 端口。 */
function findFreePort(start, end) {
  return new Promise((resolve, reject) => {
    const probe = (port) => {
      if (port > end) return reject(new Error('无可用端口'));
      const srv = net.createServer();
      srv.unref();
      srv.on('error', () => probe(port + 1));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    probe(start);
  });
}

/**
 * 调用平台本地桥：POST JSON，带插件 token。
 * @param {string} path  桥路由，如 '/image/edit'
 * @param {object} body  请求体
 * @returns {Promise<object>} 解析后的 JSON 响应
 */
function callBridge(path, body) {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    return Promise.reject(new Error('平台本地桥不可用，请在桌面客户端中运行本插件。'));
  }
  const m = BRIDGE_URL.match(/^http:\/\/([^:/]+)(?::(\d+))?/);
  if (!m) return Promise.reject(new Error('桥地址格式异常'));
  const host = m[1];
  const port = m[2] ? Number(m[2]) : 80;
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body ?? {}));
    const req = http.request(
      {
        host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'X-LingFang-Plugin-Token': BRIDGE_TOKEN,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            return reject(new Error('桥返回非 JSON：' + text.slice(0, 200)));
          }
          if (res.statusCode >= 400) {
            const msg = data && (data.message || data.error);
            return reject(new Error(typeof msg === 'string' ? msg : 'HTTP ' + res.statusCode));
          }
          resolve(data);
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** image.edit：参考图 + prompt → 换装/编辑结果，返回可直接展示的图片数组。 */
async function editImage(input) {
  const tier = input.model === 'premium' ? 'premium' : 'fast';
  const data = await callBridge('/image/edit', {
    prompt: input.prompt,
    images: input.images,
    model: tier,
    n: Number(input.n) || 1,
    size: input.size || '1024x1024',
  });
  const images = Array.isArray(data.images) ? data.images : [];
  if (!images.length) throw new Error('平台未返回编辑后的图片');
  return images;
}

/** 读取请求体（带大小上限，防内存溢出）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function main() {
  if (!BRIDGE_URL) {
    console.error('[ai-outfit-test] 未检测到平台本地桥环境变量，请在桌面客户端中运行本插件。');
  }
  const port = await findFreePort(PORT_START, PORT_END);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + port);
    // 首页：演示网页。
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    // 生成：浏览器把 prompt + 参考图(base64) POST 到这里，转发给平台桥 /image/edit。
    if (req.method === 'POST' && url.pathname === '/generate') {
      try {
        const raw = await readBody(req);
        const input = JSON.parse(raw);
        if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '请输入提示词' }));
          return;
        }
        if (!Array.isArray(input.images) || input.images.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '请至少上传一张参考图' }));
          return;
        }
        const images = await editImage(input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ images }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = 'http://127.0.0.1:' + port;
    console.log('[ai-outfit-test] 服务已启动：' + addr);
    const open = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(open + ' ' + addr, () => undefined);
  });
}

// 提示词预设（来源于原换装工具的稳定版模板，仅保留测试用核心几条）。
const PRESET_PROMPTS = {
  change: '把图2全套（上衣+裤子+内搭）全套换到图1身上，图1保持姿态背景不变。去除图1文字字母banner标签横条幅小海报遮挡物，严格保持人物身材比例的一致性。要求极高精度与细节还原，像素级的面料纹理，逼真的光线，焦点清晰，高清质感',
  inner: '让图1的模特穿上图2所示内搭服装，保持外套不变，保持模特的面部表情和身体姿势完全不变，保持图2内搭细节颜色完全一致。',
  face: '将图2的头像换到图1的人物身上，保持图1的身体姿势、服装、背景完全不变，保持图2的面部特征、发型、表情，要求自然融合，光影一致。',
  refine: '展示全身图，专业摄影，像素级的面料纹理，质感清晰，焦点清晰，电影级布光，景深效果。高清画质',
  creative: '创意生成高质量图片，细节丰富，光影自然，画面具有商业摄影质感',
};

// 尺寸比例 → 像素（与上游 OpenAI 兼容 images/edits 的 size 字段对齐）。
const SIZE_MAP = {
  '1:1': '1024x1024',
  '3:4': '768x1024',
  '4:3': '1024x768',
  '9:16': '576x1024',
  '16:9': '1024x576',
  '2:3': '768x1152',
  '3:2': '1152x768',
};

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AI 换装测试</title>
<style>
  :root{
    --bg:#0f1222; --panel:#171a2e; --panel-2:#1f2340; --line:#2a2f4e;
    --text:#e7e9f5; --muted:#9aa0c4; --accent:#7c5cff; --accent-2:#4f8cff;
    --good:#2fd08a; --warn:#ffb454; --bad:#ff6b81; --radius:16px;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
    background:radial-gradient(1200px 800px at 15% -10%,#1b1f3a 0,transparent 60%),
               radial-gradient(900px 700px at 110% 10%,#241a3a 0,transparent 55%),
               var(--bg);
    color:var(--text);min-height:100vh;line-height:1.5;
  }
  .wrap{max-width:1180px;margin:0 auto;padding:28px 20px 64px}
  header{display:flex;align-items:center;gap:14px;margin-bottom:22px}
  .logo{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;
    background:linear-gradient(135deg,var(--accent),var(--accent-2));box-shadow:0 8px 24px rgba(124,92,255,.35)}
  .logo svg{width:26px;height:26px}
  h1{font-size:20px;margin:0;letter-spacing:.5px}
  .sub{color:var(--muted);font-size:12.5px;margin-top:2px}
  .grid{display:grid;grid-template-columns:1fr;gap:18px}
  @media(min-width:980px){.grid{grid-template-columns:1fr 1fr}}
  .card{background:linear-gradient(180deg,var(--panel),var(--panel-2));
    border:1px solid var(--line);border-radius:var(--radius);padding:18px}
  .card h2{font-size:14px;margin:0 0 14px;color:var(--muted);font-weight:600;letter-spacing:.4px;text-transform:uppercase}
  .slots{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
  .slot{position:relative;border:1.5px dashed var(--line);border-radius:14px;aspect-ratio:1/1;
    display:flex;align-items:center;justify-content:center;flex-direction:column;gap:6px;
    cursor:pointer;transition:.18s;overflow:hidden;background:rgba(255,255,255,.02)}
  .slot:hover{border-color:var(--accent);background:rgba(124,92,255,.08)}
  .slot.has{border-style:solid;border-color:var(--good)}
  .slot img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  .slot .cap{position:relative;z-index:2;font-size:12px;color:var(--muted);text-align:center;padding:0 8px}
  .slot .cap b{display:block;color:var(--text);font-size:13px;margin-bottom:2px}
  .slot .rm{position:absolute;top:6px;right:6px;z-index:3;width:24px;height:24px;border-radius:50%;
    border:0;background:rgba(0,0,0,.6);color:#fff;cursor:pointer;font-size:14px;display:none}
  .slot.has .rm{display:block}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
  .chip{border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--text);
    padding:7px 13px;border-radius:999px;font-size:12.5px;cursor:pointer;transition:.15s}
  .chip:hover{border-color:var(--accent);color:#fff}
  .chip.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));border-color:transparent;color:#fff}
  textarea{width:100%;min-height:96px;resize:vertical;background:rgba(0,0,0,.25);
    border:1px solid var(--line);border-radius:12px;color:var(--text);padding:12px 13px;
    font:inherit;font-size:13px;outline:none}
  textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(124,92,255,.18)}
  .row{display:flex;flex-wrap:wrap;gap:14px;align-items:end;margin-top:14px}
  .field{display:flex;flex-direction:column;gap:6px}
  .field label{font-size:11.5px;color:var(--muted)}
  select,input[type=number]{background:rgba(0,0,0,.25);border:1px solid var(--line);border-radius:10px;
    color:var(--text);padding:9px 10px;font:inherit;font-size:13px;outline:none;min-width:96px}
  select:focus,input:focus{border-color:var(--accent)}
  .btn{border:0;border-radius:12px;padding:11px 22px;font:inherit;font-size:14px;font-weight:600;
    cursor:pointer;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent-2));
    box-shadow:0 8px 22px rgba(79,140,255,.3);transition:.15s}
  .btn:hover{filter:brightness(1.08)}
  .btn:disabled{opacity:.55;cursor:default;filter:none}
  .btn.ghost{background:transparent;border:1px solid var(--line);box-shadow:none;color:var(--muted)}
  .btn.ghost:hover{color:#fff;border-color:var(--accent)}
  .status{margin-top:14px;font-size:13px;min-height:20px}
  .status.err{color:var(--bad)} .status.ok{color:var(--good)} .status.busy{color:var(--warn)}
  .gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
  .gallery .ph{aspect-ratio:1/1;border-radius:12px;border:1px solid var(--line);
    background:rgba(255,255,255,.03);display:grid;place-items:center;color:var(--muted);font-size:12px}
  .gallery a{display:block;aspect-ratio:1/1;border-radius:12px;overflow:hidden;border:1px solid var(--line);position:relative}
  .gallery a img{width:100%;height:100%;object-fit:cover;transition:.2s}
  .gallery a:hover img{transform:scale(1.04)}
  .spin{width:18px;height:18px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;
    display:inline-block;animation:sp .7s linear infinite;vertical-align:-3px;margin-right:8px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .empty{color:var(--muted);font-size:13px;text-align:center;padding:40px 0}
  .hint{font-size:11.5px;color:var(--muted);margin-top:10px}
  code{background:rgba(255,255,255,.08);padding:1px 6px;border-radius:6px;font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>
      </svg>
    </div>
    <div>
      <h1>AI 换装测试</h1>
      <div class="sub">经平台 <code>image.edit</code> 能力上传参考图换装 · 模型由平台内置 · 按团队灵石计费</div>
    </div>
  </header>

  <div class="grid">
    <section class="card">
      <h2>① 参考图</h2>
      <div class="slots" id="slots">
        <div class="slot" data-slot="0"><img alt=""/><div class="rm" title="移除">×</div><div class="cap"><b>图1 · 模特/目标</b>点击或拖入</div></div>
        <div class="slot" data-slot="1"><img alt=""/><div class="rm" title="移除">×</div><div class="cap"><b>图2 · 服装/参考</b>点击或拖入</div></div>
        <div class="slot" data-slot="2"><img alt=""/><div class="rm" title="移除">×</div><div class="cap"><b>图3 · 搭配/细节</b>可选</div></div>
        <div class="slot" data-slot="3"><img alt=""/><div class="rm" title="移除">×</div><div class="cap"><b>图4 · 场景/参考</b>可选</div></div>
      </div>
      <div class="hint">换装/换内搭/换头：图1=目标模特，图2=参考服装。最多 4 张。</div>

      <h2 style="margin-top:20px">② 提示词</h2>
      <div class="chips" id="chips">
        <button class="chip on" data-preset="change">换装</button>
        <button class="chip" data-preset="inner">换内搭</button>
        <button class="chip" data-preset="face">换头</button>
        <button class="chip" data-preset="refine">精修口令</button>
        <button class="chip" data-preset="creative">创意</button>
      </div>
      <textarea id="prompt" placeholder="输入场景描述或选择上方预设…"></textarea>

      <div class="row">
        <div class="field"><label>模型档位</label>
          <select id="model"><option value="fast">fast · 快速</option><option value="premium">premium · 高级</option></select>
        </div>
        <div class="field"><label>尺寸比例</label>
          <select id="size">${Object.keys(SIZE_MAP).map((k) => '<option value="' + k + '">' + k + '</option>').join('')}</select>
        </div>
        <div class="field"><label>生成数量</label>
          <input type="number" id="n" min="1" max="4" value="1"/>
        </div>
        <div class="field" style="margin-left:auto">
          <button class="btn" id="gen">🚀 生成换装</button>
        </div>
      </div>
      <div class="status" id="status"></div>
    </section>

    <section class="card">
      <h2>③ 生成结果</h2>
      <div class="gallery" id="gallery"><div class="empty">结果会显示在这里</div></div>
    </section>
  </div>
</div>

<script>
var PRESETS = ${JSON.stringify(PRESET_PROMPTS)};
var SIZES = ${JSON.stringify(SIZE_MAP)};
var slots = [null, null, null, null]; // {filename, mimeType, data}

var promptEl = document.getElementById('prompt');
promptEl.value = PRESETS.change;

document.getElementById('chips').addEventListener('click', function (e) {
  var c = e.target.closest('.chip');
  if (!c) return;
  document.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); });
  c.classList.add('on');
  promptEl.value = PRESETS[c.dataset.preset] || '';
});

function setSlot(i, file) {
  var reader = new FileReader();
  reader.onload = function () {
    var full = String(reader.result || '');
    var comma = full.indexOf(',');
    var data = comma >= 0 ? full.slice(comma + 1) : full;
    slots[i] = { filename: file.name || 'image', mimeType: file.type || 'image/jpeg', data: data };
    var el = document.querySelector('.slot[data-slot="' + i + '"]');
    el.querySelector('img').src = full;
    el.classList.add('has');
  };
  reader.readAsDataURL(file);
}

document.querySelectorAll('.slot').forEach(function (el) {
  var i = Number(el.dataset.slot);
  el.addEventListener('click', function (e) {
    if (e.target.classList.contains('rm')) return;
    var input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = function () { if (input.files && input.files[0]) setSlot(i, input.files[0]); };
    input.click();
  });
  el.querySelector('.rm').addEventListener('click', function (e) {
    e.stopPropagation();
    slots[i] = null;
    el.querySelector('img').removeAttribute('src');
    el.classList.remove('has');
  });
  el.addEventListener('dragover', function (e) { e.preventDefault(); el.style.borderColor = '#7c5cff'; });
  el.addEventListener('dragleave', function () { el.style.borderColor = ''; });
  el.addEventListener('drop', function (e) {
    e.preventDefault(); el.style.borderColor = '';
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) setSlot(i, e.dataTransfer.files[0]);
  });
});

function setStatus(text, kind) {
  var el = document.getElementById('status');
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.innerHTML = text;
}

document.getElementById('gen').addEventListener('click', async function () {
  var images = slots.filter(Boolean);
  if (!images.length) { setStatus('请至少上传一张参考图（图1）', 'err'); return; }
  if (!promptEl.value.trim()) { setStatus('请输入提示词', 'err'); return; }
  var btn = this; btn.disabled = true;
  setStatus('<span class="spin"></span>正在调用平台图片编辑…换装通常需要 10–60 秒', 'busy');
  try {
    var res = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: promptEl.value,
        images: images,
        model: document.getElementById('model').value,
        size: SIZES[document.getElementById('size').value],
        n: Number(document.getElementById('n').value) || 1,
      }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    render(data.images || []);
    setStatus('完成，生成 ' + (data.images || []).length + ' 张', 'ok');
  } catch (e) {
    setStatus('失败：' + (e.message || e), 'err');
  } finally {
    btn.disabled = false;
  }
});

function render(list) {
  var g = document.getElementById('gallery');
  if (!list.length) { g.innerHTML = '<div class="empty">无结果</div>'; return; }
  g.innerHTML = list.map(function (src) {
    return '<a href="' + src + '" target="_blank" download="outfit.png"><img src="' + src + '" alt="结果"/></a>';
  }).join('');
}
</script>
</body>
</html>`;

main().catch((err) => {
  console.error('[ai-outfit-test] 启动失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});
