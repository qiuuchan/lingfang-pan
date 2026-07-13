// =============================================================================
// AI 能力演示插件入口（runtime_type: nodejs）
// -----------------------------------------------------------------------------
// 演示 Node.js 脚本插件如何经「平台本地桥」调用大模型对话(llm.chat)与生图(image.generate)。
//
// 关键机制（见 packages/plugin-sdk/src/index.ts 的 invokeScriptBridge + Rust 桥
// plugin_llm_bridge.rs）：
//  - 桌面壳 start_plugin 启动本进程时，注入两个环境变量：
//      LINGFANG_PLUGIN_BRIDGE_URL  = http://127.0.0.1:<port>   （基础 endpoint）
//      LINGFANG_PLUGIN_BRIDGE_TOKEN = <session token>            （当前进程会话）
//  - 脚本不持有用户 JWT 或上游密钥；宿主注入的会话 token 只用于当前运行周期，
//    桥会校验 manifest 声明的能力（llm.chat / image.generate），再以宿主登录态转发到平台 relay
//    并计费扣团队灵石。这是「脚本插件安全调用平台 AI」的标准范式。
//  - 路由：POST <BRIDGE_URL>/llm/chat（body: {messages, model}，返回 {content}）
//          POST <BRIDGE_URL>/image/generate（body: {prompt, model, n, size}，返回 {images:[url|data:]})
//
// 约束：sandbox 无 node_modules，仅用 Node.js 内置模块（http/net/child_process）。
// 进程在用户权限下运行，等价于本地 `node index.js`。
// =============================================================================

const http = require('http');
const net = require('net');
const { exec } = require('child_process');

// 平台本地桥地址与 token 只能直接取宿主注入值，不提供自定义 fallback。
const BRIDGE_URL = process.env.LINGFANG_PLUGIN_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.LINGFANG_PLUGIN_BRIDGE_TOKEN;

const PORT_START = 41984;
const PORT_END = 42084;

/** 在 [start, end] 范围内找第一个可用 TCP 端口。 */
function findFreePort(start, end) {
  return new Promise((resolve, reject) => {
    const probe = (port) => {
      if (port > end) return reject(new Error('无可用端口'));
      const srv = net.createServer();
      srv.unref();
      srv.on('error', () => probe(port + 1));
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(port));
      });
    };
    probe(start);
  });
}

/**
 * 调用平台本地桥。POST JSON，带插件 token。
 * @param {string} path  路由路径，如 '/llm.chat' '/image/generate'
 * @param {object} body  请求体
 * @returns {Promise<object>} 解析后的 JSON 响应
 */
function callBridge(path, body) {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    return Promise.reject(new Error('平台本地桥不可用，请在桌面客户端中以 nodejs 插件方式运行。'));
  }
  // BRIDGE_URL 形如 http://127.0.0.1:port，拆出 host/port。
  const m = BRIDGE_URL.match(/^http:\/\/([^:/]+)(?::(\d+))?/);
  if (!m) return Promise.reject(new Error(`桥地址格式异常：${BRIDGE_URL}`));
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
          try { data = JSON.parse(text); } catch { return reject(new Error(`桥返回非 JSON：${text.slice(0, 200)}`)); }
          if (res.statusCode >= 400) {
            return reject(new Error(data.message || data.error || `HTTP ${res.statusCode}`));
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

/** llm.chat：发一句话，返回助手回复文本。 */
async function chat(prompt) {
  const data = await callBridge('/llm/chat', {
    model: 'fast',
    messages: [{ role: 'user', content: prompt }],
  });
  return typeof data.content === 'string' ? data.content : JSON.stringify(data);
}

/** image.generate：生成一张图，返回可直接展示的 url 或 data:base64。 */
async function generateImage(prompt) {
  const data = await callBridge('/image/generate', { model: 'fast', prompt, n: 1, size: '1024x1024' });
  const images = Array.isArray(data.images) ? data.images : [];
  if (!images.length) throw new Error('平台未返回图片');
  return images[0];
}

// 简单内存状态，供网页轮询展示最近一次结果（演示用，非持久）。
const state = { lastChat: null, lastChatAt: null, lastImage: null, lastImageAt: null, busy: null, error: null };

/** 启动 HTTP 服务：提供一个极简网页 + JSON 接口。 */
async function main() {
  if (!BRIDGE_URL) {
    console.error('[ai-demo] 未检测到平台本地桥环境变量。请在桌面客户端中运行本插件。');
  }
  const port = await findFreePort(PORT_START, PORT_END);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const prompt = url.searchParams.get('prompt') || '用一句话介绍灵坊平台';
      state.busy = 'chat';
      state.error = null;
      chat(prompt)
        .then((text) => { state.lastChat = text; state.lastChatAt = new Date().toISOString(); })
        .catch((e) => { state.error = e.message; })
        .finally(() => { state.busy = null; });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, prompt }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/image') {
      const prompt = url.searchParams.get('prompt') || '一只可爱的橙色小猫，简笔画风格';
      state.busy = 'image';
      state.error = null;
      generateImage(prompt)
        .then((src) => { state.lastImage = src; state.lastImageAt = new Date().toISOString(); })
        .catch((e) => { state.error = e.message; })
        .finally(() => { state.busy = null; });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, prompt }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = `http://127.0.0.1:${port}`;
    console.log(`[ai-demo] 服务已启动：${addr}`);
    // 自动打开浏览器（错误忽略：某些环境无 GUI）。
    const open = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${open} ${addr}`, () => undefined);
  });
}

const PAGE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AI 能力演示</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#222}
  h1{font-size:1.4rem}
  .card{border:1px solid #e2e2e2;border-radius:10px;padding:14px 16px;margin:14px 0}
  button{cursor:pointer;border:0;border-radius:8px;padding:8px 14px;background:#2563eb;color:#fff;font-size:14px}
  button:disabled{opacity:.5;cursor:default}
  .muted{color:#888;font-size:12px}
  img{max-width:100%;border-radius:8px;margin-top:8px;border:1px solid #eee}
  pre{white-space:pre-wrap;word-break:break-word;background:#f7f7f7;padding:10px;border-radius:8px;margin:8px 0}
  .err{color:#c00}
</style></head><body>
<h1>AI 能力演示插件</h1>
<p class="muted">Node.js 脚本插件经平台本地桥调用大模型对话(llm.chat)与生图(image.generate)。点击按钮实调平台 AI。</p>

<div class="card">
  <h2>① 对话 llm.chat</h2>
  <button onclick="doChat()">发一句「say hi」</button>
  <div id="chatOut" class="muted">—</div>
</div>

<div class="card">
  <h2>② 生图 image.generate</h2>
  <button onclick="doImage()">生成一张小猫简笔画</button>
  <div id="imgOut" class="muted">—</div>
</div>

<p id="err" class="err"></p>

<script>
let timer = null;
function poll(){
  fetch('/state').then(r=>r.json()).then(s=>{
    document.getElementById('err').textContent = s.error ? ('错误：'+s.error) : '';
    if(s.busy){ document.getElementById('chatOut').textContent='调用中…'; document.getElementById('imgOut').textContent='调用中…'; return; }
    document.getElementById('chatOut').innerHTML = s.lastChat ? ('<pre>'+s.lastChat+'</pre><div class="muted">'+s.lastChatAt+'</div>') : '—';
    document.getElementById('imgOut').innerHTML = s.lastImage ? ('<img src="'+s.lastImage+'"/><div class="muted">'+s.lastImageAt+'</div>') : '—';
  }).catch(()=>{});
}
function startPoll(){ if(!timer) timer = setInterval(poll, 1000); poll(); }
function doChat(){ fetch('/chat?prompt='+encodeURIComponent('say hi')).then(()=>startPoll()); }
function doImage(){ fetch('/image?prompt='+encodeURIComponent('一只可爱的橙色小猫，简笔画风格')).then(()=>startPoll()); }
startPoll();
</script>
</body></html>`;

main().catch((err) => {
  console.error(`[ai-demo] 启动失败：${err.message}`);
  process.exit(1);
});
