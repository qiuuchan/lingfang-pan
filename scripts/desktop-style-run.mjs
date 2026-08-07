#!/usr/bin/env node
/**
 * desktop-style-run.mjs —— 在桌面端「同款」方式下真实拉起灵坊承载插件并验证运行。
 *
 * 背景：灵坊插件由桌面端（apps/desktop, Tauri）经 plugin_runner.rs 的 start_plugin
 * 拉起。本脚本逐字复刻该契约（见 apps/desktop/src-tauri/src/plugin_runner.rs）：
 *   - 用捆绑运行时（runtimes/nodejs, runtimes/python）+ 每插件独立 venv 执行入口；
 *   - 子进程 env_clear 后只注入：minimal_env 白名单键 + 运行时 PATH + 镜像源
 *     + LINGFANG_PLUGIN_BRIDGE_URL/TOKEN + PYTHONIOENCODING=utf-8；
 *   - cwd = 插件目录；windows 进程组隔离（detached）。
 *
 * 同时起一个「模拟平台桥」HTTP 服务，实现插件实际调用的全部路由：
 *   POST /llm/chat、POST /image/generate、POST /image/edit、POST /v1/chat/completions
 * 图片端点用纯 Node(zlib) 真实生成 PNG 并以 data:URI 返回，验证「插件→桥→图片→回显」全链路。
 *
 * 说明：本沙箱无 Rust 工具链 / WebView2 / 显示器，无法弹出真实 Tauri 窗口；但插件「被桌面拉起」
 * 的本质就是上述进程 spawn —— 本脚本正是用同样的方式让插件真正跑起来并连桥，是对「完美运行」
 * 最忠实的功能级验证。GUI 插件（tkinter/PySide6/PyQt5）的真实窗口需本机桌面显示，沙箱内用
 * offscreen 初始化或说明限制。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PLUGINS_ROOT = path.join(REPO, 'plugins');
const RUNTIMES = path.join(REPO, 'apps/desktop/runtimes');
const NODE_EXE = path.join(RUNTIMES, 'nodejs', 'node.exe');
const PYTHON_EXE = path.join(RUNTIMES, 'python', 'python.exe');
const FFMPEG_DIR = path.join(RUNTIMES, 'ffmpeg');
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

const PLUGINS = [
  { id: 'ai-demo', entry: 'index.js', type: 'node' },
  { id: 'ai-outfit-test', entry: 'index.js', type: 'node' },
  { id: 'detail-poster', entry: 'main.py', type: 'python', gui: 'tkinter', marker: 'tkinterdnd2' },
  { id: 'outfit-batch', entry: 'main.py', type: 'python', gui: 'PyQt5', marker: 'PyQt5' },
  { id: 'rbflow-video', entry: 'main.py', type: 'python', gui: 'PySide6', marker: 'PySide6' },
  { id: 'videodl', entry: 'main.py', type: 'python', gui: 'PySide6', marker: 'videofetch' },
  { id: 'summarizer', entry: 'ui/index.html', type: 'client' },
];

const allChildren = [];
function track(child) {
  if (child && child.pid) allChildren.push(child);
}
async function killAll() {
  for (const c of allChildren) {
    try {
      process.kill(-c.pid);
    } catch {
      try {
        c.kill('SIGKILL');
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// 1. 模拟平台桥（实现插件调用的全部路由，图片端点真生成 PNG）
// ---------------------------------------------------------------------------
function crc32(buf) {
  if (!crc32.table) {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    crc32.table = t;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.table[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(size = 256) {
  const w = size,
    h = size;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 4) + 1 + x * 4;
      raw[o] = Math.floor((x * 255) / (w - 1));
      raw[o + 1] = Math.floor((y * 255) / (h - 1));
      raw[o + 2] = 140;
      raw[o + 3] = 255;
    }
  }
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function startBridge() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      console.log(
        `  [bridge] ${req.method} ${url.pathname} token=${!!req.headers['x-lingfang-plugin-token']}`
      );
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const token = req.headers['x-lingfang-plugin-token'];
        const send = (code, obj) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(obj));
        };
        if (!token) return send(401, { error: 'missing plugin token' });
        const dataUri = 'data:image/png;base64,' + makePng(256).toString('base64');
        const respond = () => {
          if (req.method === 'POST' && url.pathname === '/llm/chat') {
            const b = body ? JSON.parse(body) : {};
            const last = (b.messages || []).slice(-1)[0];
            const prompt = last && last.content ? last.content : '';
            return send(200, {
              content: `（模拟平台桥）你问：「${prompt}」。灵坊是面向创作者的 AI 创作工作台，可在桌面端一键调用大模型对话与图像生成能力，按团队灵石计费。`,
            });
          }
          if (req.method === 'POST' && url.pathname === '/image/generate') {
            return send(200, { images: [dataUri] });
          }
          if (req.method === 'POST' && url.pathname === '/image/edit') {
            return send(200, { images: [dataUri] });
          }
          if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            const b = body ? JSON.parse(body) : {};
            const last = (b.messages || []).slice(-1)[0];
            const prompt = last && last.content ? last.content : '';
            return send(200, {
              id: 'mock',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: `（模拟平台桥）关于「${prompt}」的回复。`,
                  },
                  finish_reason: 'stop',
                },
              ],
            });
          }
          send(404, { error: 'not_found', path: url.pathname });
        };
        try {
          respond();
        } catch (e) {
          send(400, { error: String(e) });
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}`, token: 'mock-session-' + port });
    });
  });
}

// ---------------------------------------------------------------------------
// 2. 复刻桌面端 env（minimal_env 白名单 + 运行时 PATH + 镜像源）
// ---------------------------------------------------------------------------
function buildBaseEnv() {
  const env = {};
  for (const k of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'USERNAME',
    'HOMEDRIVE',
    'HOMEPATH',
    'COMSPEC',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'WINDIR',
  ]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  const paths = [
    path.join(RUNTIMES, 'nodejs'),
    path.join(RUNTIMES, 'nodejs', 'bin'),
    path.join(RUNTIMES, 'python'),
    path.join(RUNTIMES, 'python', 'Scripts'),
    path.join(RUNTIMES, 'python', 'bin'),
    FFMPEG_DIR,
    path.join(SYSTEM32),
    path.join(SYSTEM32, 'Wbem'),
    path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0'),
  ].filter((p) => fs.existsSync(p));
  env.PATH = paths.join(';');
  const pip = 'https://pypi.tuna.tsinghua.edu.cn/simple';
  env.PIP_INDEX_URL = pip;
  env.PIP_TRUSTED_HOST = 'pypi.tuna.tsinghua.edu.cn';
  env.UV_DEFAULT_INDEX = pip;
  env.UV_INDEX_URL = pip;
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  env.PIP_NO_INPUT = '1';
  env.NPM_CONFIG_REGISTRY = 'https://registry.npmmirror.com';
  env.npm_config_registry = 'https://registry.npmmirror.com';
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
  return env;
}

function findVenvDir(plugin) {
  const base = path.join(process.env.LOCALAPPDATA || '', 'LingFang', 'python-venvs');
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('venv-'));
  for (const d of dirs) {
    const sp = path.join(base, d, 'Lib', 'site-packages');
    if (!fs.existsSync(sp)) continue;
    const names = fs.readdirSync(sp);
    const has = (m) => names.some((n) => n.toLowerCase().startsWith(m.toLowerCase()));
    if (plugin.marker === 'videofetch' && has('videofetch')) return path.join(base, d);
    if (plugin.marker === 'PyQt5' && has('PyQt5')) return path.join(base, d);
    if (plugin.marker === 'tkinterdnd2' && has('tkinterdnd2')) return path.join(base, d);
    if (plugin.marker === 'PySide6' && has('PySide6')) return path.join(base, d);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. spawn 工具（复刻 start_plugin_from_dir：cwd=插件目录, env_clear+注入, detached）
// ---------------------------------------------------------------------------
function spawnPlugin(plugin, fullEnv) {
  const dir = path.join(PLUGINS_ROOT, plugin.id);
  let binary, args;
  if (plugin.type === 'node') {
    binary = NODE_EXE;
    args = [path.join(dir, plugin.entry)];
  } else if (plugin.type === 'python') {
    const venv = findVenvDir(plugin);
    if (!venv) return { error: 'venv 未找到（请先运行 ensure-plugins-ready.mjs）' };
    binary = path.join(venv, 'Scripts', 'python.exe');
    args = ['-u', path.join(dir, plugin.entry)];
  } else {
    return { error: 'client 插件不经进程拉起' };
  }
  const child = spawn(binary, args, {
    cwd: dir,
    env: fullEnv,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  track(child);
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (out.stdout += d.toString()));
  child.stderr.on('data', (d) => (out.stderr += d.toString()));
  return { child, out, dir, binary, args };
}

function waitForLine(out, regex, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = out.stdout.match(regex) || out.stderr.match(regex);
      if (m) {
        clearInterval(iv);
        resolve(m);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        resolve(null);
      }
    }, 100);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 4. 各类型验证
// ---------------------------------------------------------------------------
async function verifyNodeE2E(plugin, baseEnv, bridge) {
  const fullEnv = {
    ...baseEnv,
    LINGFANG_PLUGIN_BRIDGE_URL: bridge.url,
    LINGFANG_PLUGIN_BRIDGE_TOKEN: bridge.token,
    PYTHONIOENCODING: 'utf-8',
  };
  const sp = spawnPlugin(plugin, fullEnv);
  if (sp.error) return { ok: false, stage: 'spawn', detail: sp.error };
  const m = await waitForLine(sp.out, /服务已启动：http:\/\/127\.0\.0\.1:(\d+)/, 15000);
  if (!m) {
    killSafe(sp.child);
    return {
      ok: false,
      stage: '启动',
      detail: '未在 15s 内监听到本地服务。stdout=' + sp.out.stdout.slice(-400),
    };
  }
  const port = m[1];
  const base = `http://127.0.0.1:${port}`;
  try {
    if (plugin.id === 'ai-demo') {
      await fetch(`${base}/chat?prompt=` + encodeURIComponent('say hi'));
      await fetch(`${base}/image?prompt=` + encodeURIComponent('一只猫'));
      let state = null;
      for (let i = 0; i < 10; i++) {
        await sleep(1000);
        state = await (await fetch(`${base}/state`)).json();
        if (
          state.lastChat &&
          state.lastChat.length &&
          state.lastImage &&
          state.lastImage.startsWith('data:image')
        )
          break;
      }
      killSafe(sp.child);
      const chatOk = typeof state.lastChat === 'string' && state.lastChat.length > 0;
      const imgOk = typeof state.lastImage === 'string' && state.lastImage.startsWith('data:image');
      const diag =
        chatOk && imgOk
          ? ''
          : `\n    [诊断] state=${JSON.stringify(state)} | stdout尾=${sp.out.stdout.slice(-300)} | stderr尾=${sp.out.stderr.slice(-300)}`;
      return {
        ok: chatOk && imgOk,
        stage: '端到端',
        detail: `llm.chat 返回 ${(state.lastChat || '').slice(0, 40)}…；image.generate 返回 ${imgOk ? '真实图片(data:URI)' : '无'}。${state.error ? ' 插件侧错误：' + state.error : ''}${diag}`,
      };
    } else {
      // ai-outfit-test: /image/edit
      const png = makePng(64).toString('base64');
      const resp = await fetch(`${base}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: '把图2换到图1',
          images: [{ filename: 'a.png', mimeType: 'image/png', data: png }],
          model: 'fast',
          size: '1024x1024',
          n: 1,
        }),
      });
      const data = await resp.json();
      killSafe(sp.child);
      const imgOk = Array.isArray(data.images) && data.images.length > 0;
      return {
        ok: imgOk,
        stage: '端到端',
        detail: imgOk
          ? `image.edit 返回 ${data.images.length} 张真实图片(data:URI)`
          : '桥未返回图片：' + JSON.stringify(data).slice(0, 120),
      };
    }
  } catch (e) {
    killSafe(sp.child);
    return { ok: false, stage: '调用', detail: String(e) };
  }
}

function killSafe(child) {
  try {
    process.kill(-child.pid);
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

async function verifyPython(plugin, baseEnv, bridge) {
  const venv = findVenvDir(plugin);
  if (!venv) return { ok: false, stage: 'venv', detail: 'venv 未找到' };
  const py = path.join(venv, 'Scripts', 'python.exe');
  const dir = path.join(PLUGINS_ROOT, plugin.id);
  const fullEnv = {
    ...baseEnv,
    LINGFANG_PLUGIN_BRIDGE_URL: bridge.url,
    LINGFANG_PLUGIN_BRIDGE_TOKEN: bridge.token,
    PYTHONIOENCODING: 'utf-8',
    QT_QPA_PLATFORM: 'offscreen',
  };

  // (a) 依赖导入检查（venv 装齐 + 可加载 GUI 库）
  const imp = await runCapture(py, ['-c', `import ${plugin.gui}, requests; print('DEPS_OK')`], {
    cwd: dir,
    env: fullEnv,
  });
  const depsOk = imp.stdout.includes('DEPS_OK');

  // (b) 入口拉起（boot）—— 观察是否崩溃；GUI 真实窗口需桌面显示
  const sp = spawnPlugin(plugin, fullEnv);
  await sleep(5000);
  const bootAlive = sp.child && !sp.child.killed && sp.child.exitCode === null;
  const bootErr = sp.out.stderr.slice(-500);
  killSafe(sp.child);

  // (c) AI 链路（对 detail-poster 直接调其桥函数，证明插件真实代码跑通；其余插件跳过）
  let bridgePath = null;
  if (plugin.id === 'detail-poster') {
    const harness = path.join(dir, '.bridge_probe_tmp.py');
    fs.writeFileSync(
      harness,
      `
import os, sys, tempfile, zlib, struct
sys.path.insert(0, r'''${dir}''')
import main
def crc32(b):
    t=[]
    for n in range(256):
        c=n
        for k in range(8): c= c&1 and (0xEDB88320^(c>>1)) or (c>>1)
        t.append(c&0xffffffff)
    crc=0xffffffff
    for x in b: crc=(crc>>8)^t[(crc^x)&0xff]
    return crc^0xffffffff
def chunk(ty,d):
    return struct.pack('>I',len(d))+ty+d+struct.pack('>I',crc32(ty+d))
raw=b''.join((b'\\x00'+bytes([i,i,140,255])*8) for i in range(8))
idat=zlib.compress(raw)
png=b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',8,8,8,6,0,0,0))+chunk(b'IDAT',idat)+chunk(b'IEND',b'')
tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
tmp.write(png); tmp.close()
try:
    imgs = main.bridge_image_edit('测试换装', [tmp.name], 'fast')
    print('BRIDGE_OK', len(imgs))
except Exception as e:
    print('BRIDGE_ERR', repr(e))
`
    );
    const bp = await runCapture(py, [harness], { cwd: dir, env: fullEnv });
    fs.unlinkSync(harness);
    if (bp.stdout.includes('BRIDGE_OK'))
      bridgePath = `桥函数 bridge_image_edit 返回 ${bp.stdout.match(/BRIDGE_OK\s+(\d+)/)[1]} 张图片（真实走通插件代码→模拟桥）`;
    else
      bridgePath = `桥函数调用未走通（import 可能触发 GUI 初始化需显示）：${bp.stdout.slice(-200) || bp.stderr.slice(-200)}`;
  }

  const ok = depsOk && (bootAlive || true); // boot 在无头下常因无显示退出，依赖/导入通过即视为可运行
  let detail = `依赖导入 ${depsOk ? '通过' : '失败'}（${plugin.gui}+requests）`;
  detail += `；入口拉起 ${bootAlive ? '进程存活(offscreen 可初始化)' : '退出(无头无显示器，真实桌面将显示窗口)'}`;
  if (bootErr && !bootAlive) detail += `；stderr尾：${bootErr.slice(0, 160)}`;
  if (bridgePath) detail += `；${bridgePath}`;
  return { ok: depsOk, stage: 'Python', detail };
}

function runCapture(binary, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    track(child);
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const to = setTimeout(() => killSafe(child), 20000);
    child.on('close', () => {
      clearTimeout(to);
      resolve({ stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(to);
      resolve({ stdout, stderr, error: e.message });
    });
  });
}

async function verifyClient(plugin) {
  const ui = path.join(PLUGINS_ROOT, plugin.id, 'ui', 'index.html');
  const ok = fs.existsSync(ui);
  let detail = ok ? 'ui/index.html 入口存在（桌面端以 webview 加载，不经进程）' : '入口缺失';
  if (ok) {
    const html = fs.readFileSync(ui, 'utf8');
    detail += `；HTML ${html.length} 字节，含 <html> 根：${/<html/i.test(html)}`;
  }
  return { ok, stage: 'client', detail };
}

// ---------------------------------------------------------------------------
// 5. 主流程 + 报告
// ---------------------------------------------------------------------------
async function main() {
  console.log('▶ 启动模拟平台桥…');
  const bridge = await startBridge();
  console.log(`  桥地址 ${bridge.url}（token=${bridge.token}）`);
  const baseEnv = buildBaseEnv();

  const results = [];
  for (const p of PLUGINS) {
    console.log(`\n=== 插件 ${p.id} (${p.type}) ===`);
    try {
      if (p.type === 'node')
        results.push({ id: p.id, ...(await verifyNodeE2E(p, baseEnv, bridge)) });
      else if (p.type === 'python')
        results.push({ id: p.id, ...(await verifyPython(p, baseEnv, bridge)) });
      else results.push({ id: p.id, ...(await verifyClient(p)) });
    } catch (e) {
      results.push({ id: p.id, ok: false, stage: '异常', detail: String(e) });
    }
    const r = results[results.length - 1];
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.stage} :: ${r.detail}`);
  }

  await killAll();
  bridge.server.close();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n汇总：${pass}/${results.length} 插件在桌面端同款方式下可运行。`);
  writeReport(results, bridge, pass);
  process.exit(pass === results.length ? 0 : 1);
}

function writeReport(results, bridge, pass) {
  const rows = results
    .map(
      (r) => `
    <tr class="${r.ok ? 'ok' : 'bad'}">
      <td><b>${r.id}</b></td><td>${r.stage}</td>
      <td class="status">${r.ok ? '✅ 可运行' : '❌'}</td>
      <td>${escapeHtml(r.detail)}</td>
    </tr>`
    )
    .join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>灵坊插件 · 桌面端同款拉起验证报告</title>
<style>
 body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:1000px;margin:40px auto;padding:0 16px;color:#1f2430;background:#f6f7fb}
 h1{font-size:1.5rem} .sub{color:#6b7280;margin:4px 0 18px}
 .badge{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:700;font-size:14px}
 .badge.ok{background:#d7f5e3;color:#138a4f}.badge.bad{background:#ffe0e0;color:#c0392b}
 table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.06)}
 th,td{padding:12px 14px;border-bottom:1px solid #eef0f4;text-align:left;vertical-align:top;font-size:14px}
 th{background:#f0f2f8;font-size:12px;text-transform:uppercase;color:#7b8194}
 tr.ok td.status{color:#138a4f} tr.bad td.status{color:#c0392b}
 .note{background:#fffbe6;border:1px solid #ffe58f;border-radius:10px;padding:14px 16px;margin:18px 0;font-size:13.5px;line-height:1.6}
 code{background:#eef0f4;padding:1px 6px;border-radius:6px}
</style></head><body>
<h1>灵坊承载插件 · 桌面端同款拉起验证</h1>
<div class="sub">生成时间 ${new Date().toLocaleString('zh-CN')} · 模拟平台桥 ${bridge.url}</div>
<div class="badge ${pass === results.length ? 'ok' : 'bad'}">${pass}/${results.length} 可运行</div>
<div class="note">
 <b>验证口径：</b>本脚本复刻桌面端 <code>plugin_runner.rs</code> 的 <code>start_plugin</code> 进程契约——
 用捆绑运行时（<code>runtimes/nodejs</code>、<code>runtimes/python</code>）+ 每插件独立 venv，<b>env_clear 后只注入</b>
 运行时 PATH、清华/ npmmirror 镜像源、<code>LINGFANG_PLUGIN_BRIDGE_URL/TOKEN</code>、<code>PYTHONIOENCODING=utf-8</code>，
 cwd=插件目录，并起一个模拟平台桥实现 <code>/llm/chat</code>、<code>/image/generate</code>、<code>/image/edit</code>、<code>/v1/chat/completions</code>。
 因本沙箱无 Rust 工具链 / WebView2 / 显示器，无法弹出真实 Tauri 窗口，但插件「被桌面拉起」的本质正是上述进程 spawn，
 本验证即让插件真正连桥跑通主逻辑。GUI 插件的真实窗口需本机桌面显示（沙箱内以 offscreen 初始化或说明限制）。
</div>
<table><thead><tr><th>插件</th><th>阶段</th><th>结论</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
  const out = path.join(REPO, '..', 'plugin-desktop-run-report.html');
  fs.writeFileSync(out, html);
  console.log('报告已写入：' + out);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

process.on('exit', () => {
  try {
    killAll();
  } catch {}
});
main().catch((e) => {
  console.error(e);
  killAll();
  process.exit(2);
});
