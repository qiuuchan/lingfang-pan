#!/usr/bin/env node
// test-plugin-run.mjs —— 在「应用实际环境」中运行插件，验证 start_plugin 流程。
//
// 模拟 plugin_runner.rs::start_plugin_from_dir：
//   1. 解析应用内置运行时（runtimes/python, runtimes/nodejs，与 RuntimeResolver 同源）。
//   2. Python：python_venv_dir 同款哈希路径（%LOCALAPPDATA%\LingFang\python-venvs\venv-<hash>）
//      → 不存在则 python -m venv → pip install -r requirements.txt（清华镜像）。
//   3. Node：pnpm install（npmmirror）若 node_modules 缺失。
//   4. spawn 入口（cwd=插件目录），**stdout=null / stderr=piped**（与 runner 完全一致），
//      注入 minimal_env + PIP/NPM 镜像 + LINGFANG_PLUGIN_BRIDGE_URL（指向真实桥或占位）。
//   5. 轮询端口（7860/8501/5679）判定「真的起来了」；超时或非零退出 = 失败。
//
// 用法：node scripts/test-plugin-run.mjs <facefusion|moneyprinter-turbo|pixelle-video|huobao-drama> [--no-venv-recreate] [--bridge-url URL]

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const RUNTIMES = join(REPO, 'apps', 'desktop', 'runtimes');
const PYTHON_EXE = join(RUNTIMES, 'python', 'python.exe');
const NODE_EXE = join(RUNTIMES, 'nodejs', 'node.exe');
const PNPM_CMD = join(RUNTIMES, 'nodejs', 'pnpm.cmd');
const NPM_CMD = join(RUNTIMES, 'nodejs', 'npm.cmd');

const PLUGIN_PORTS = {
  'facefusion': 7860,
  'moneyprinter-turbo': 8501,
  'pixelle-video': 8501,
  'huobao-drama': 5679,
};

function parseArgs(argv) {
  const ids = [];
  let noRecreate = false;
  let bridgeUrl = 'http://127.0.0.1:0'; // 占位（不真实调，仅验证启动）
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-venv-recreate') { noRecreate = true; continue; }
    if (a === '--bridge-url') { bridgeUrl = argv[++i]; continue; }
    if (a === '--help' || a === '-h') { ids.length = 0; break; }
    ids.push(a);
  }
  return { ids, noRecreate, bridgeUrl };
}

/** 模拟 plugin_runner::minimal_env（白名单转发宿主变量）。 */
function minimalEnv() {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];
  const env = {};
  for (const k of keys) { if (process.env[k] !== undefined) env[k] = process.env[k]; }
  // 运行时 PATH：node + node/bin + python + python/Scripts + python/bin（与 RuntimeResolver.path_value 一致）。
  const paths = [
    join(RUNTIMES, 'nodejs'),
    join(RUNTIMES, 'python'),
    join(RUNTIMES, 'python', 'Scripts'),
  ].filter(p => existsSync(p));
  // 宿主 SystemRoot 下 system32（ffmpeg/git/curl 等系统工具）。
  if (process.env.SystemRoot) paths.push(join(process.env.SystemRoot, 'System32'));
  // WinGet shim 目录（ffmpeg/git 等经 winget 装后的 PATH 入口；本机测试用）。
  if (process.env.LOCALAPPDATA) {
    const winGetLinks = join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links');
    if (existsSync(winGetLinks)) paths.push(winGetLinks);
  }
  env.PATH = paths.join(';');
  env.PIP_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple';
  env.PIP_TRUSTED_HOST = 'pypi.tuna.tsinghua.edu.cn';
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  env.PIP_NO_INPUT = '1';
  env.NPM_CONFIG_REGISTRY = 'https://registry.npmmirror.com';
  env.npm_config_registry = 'https://registry.npmmirror.com';
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  return env;
}

/** 模拟 stable_path_hash（Rust DefaultHasher 对归一化路径的 hash，取低 16 hex）。 */
function stablePathHash(p) {
  // Rust DefaultHasher 是 SipHash13，无法在 JS 精确复现，但平台 venv 路径基于插件目录的
  // canonicalize 后字符串。这里我们**用 sha256 前 16 字符**作为独立 venv 目录（不复用平台 venv，
  // 避免污染用户真实 venv；测试结束可整体删）。
  const norm = p.replace(/\\/g, '/').toLowerCase();
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 16);
}

function venvDir(pluginDir) {
  const base = process.env.LOCALAPPDATA || process.env.HOME;
  return join(base, 'LingFang', 'python-venvs', `venv-test-${stablePathHash(pluginDir)}`);
}
function venvPython(vdir) { return join(vdir, 'Scripts', 'python.exe'); }

function run(cmd, args, opts = {}) {
  return new Promise((resolveFn) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; process.stdout.write(c); });
    child.stderr.on('data', c => { stderr += c; process.stderr.write(c); });
    child.on('exit', code => resolveFn({ code, stdout, stderr }));
    child.on('error', err => resolveFn({ code: -1, stdout, stderr, error: err }));
  });
}

function venvHasPip(vdir) {
  return existsSync(join(vdir, 'Lib', 'site-packages', 'pip'));
}

async function ensurePythonVenv(pluginDir, noRecreate) {
  const vdir = venvDir(pluginDir);
  const py = venvPython(vdir);
  if (!existsSync(py) || !venvHasPip(vdir) || !noRecreate) {
    if (existsSync(vdir)) { console.log(`[harness] 清理旧测试 venv: ${vdir}`); rmSync(vdir, { recursive: true, force: true }); }
    console.log(`[harness] 创建 venv: ${vdir}`);
    const r = await run(PYTHON_EXE, ['-m', 'venv', '--clear', vdir], { env: minimalEnv() });
    if (r.code !== 0) throw new Error(`venv 创建失败 (exit ${r.code})`);
  }
  const req = join(pluginDir, 'requirements.txt');
  if (existsSync(req)) {
    console.log(`[harness] pip install -r requirements.txt（清华镜像，可能几分钟）…`);
    const r = await run(py, ['-m', 'pip', 'install', '--no-input', '-r', req], { cwd: pluginDir, env: minimalEnv() });
    if (r.code !== 0) throw new Error(`pip install 失败 (exit ${r.code})`);
  }
  return py;
}

async function ensureNodeDeps(pluginDir, noRecreate) {
  const nm = join(pluginDir, 'node_modules');
  const pkg = join(pluginDir, 'package.json');
  if (!existsSync(pkg)) return;
  if (existsSync(nm)) { console.log(`[harness] node_modules 已存在，跳过 install`); return; }
  // 优先 runtime pnpm，回退 runtime npm，最后回退系统 npm/pnpm
  // （dev runtime 的 pnpm/npm shim 可能损坏，生产安装包会用可用的内置版）。
  const candidates = [
    { cmd: PNPM_CMD, name: 'pnpm', useShell: true },
    { cmd: NPM_CMD, name: 'npm', useShell: true },
    { cmd: 'pnpm', name: 'pnpm(system)', useShell: true },
    { cmd: 'npm', name: 'npm(system)', useShell: true },
  ].filter(c => c.cmd && (existsSync(c.cmd) || !c.cmd.includes('\\')));
  for (const c of candidates) {
    console.log(`[harness] ${c.name} install（npmmirror，可能几分钟）…`);
    const r = await run(c.cmd, ['install'], {
      cwd: pluginDir,
      env: { ...minimalEnv(), PATH: [process.env.PATH].join(';') }, // install 用完整宿主 PATH 兜底
      shell: process.platform === 'win32',
    });
    if (r.code === 0) return;
    console.log(`[harness] ${c.name} 失败 (exit ${r.code})，尝试下一个…`);
  }
  throw new Error('所有 pnpm/npm 候选都失败');
}

function probePort(port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolveFn) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 1500 }, (res) => {
        // 任意响应（含 4xx/5xx）都说明端口已起。
        res.resume();
        resolveFn(true);
      });
      req.on('error', () => {
        if (Date.now() - start >= timeoutMs) resolveFn(false);
        else setTimeout(tick, 1500);
      });
      req.on('timeout', () => { req.destroy(); if (Date.now() - start >= timeoutMs) resolveFn(false); else setTimeout(tick, 1000); });
    };
    tick();
  });
}

async function runPythonPlugin(pluginId, pluginDir, py, bridgeUrl, port) {
  const env = minimalEnv();
  env.LINGFANG_PLUGIN_BRIDGE_URL = bridgeUrl;
  env.LINGFANG_PLUGIN_BRIDGE_TOKEN = 'test-token-placeholder';
  // 与 runner 一致：stdin=null, stdout=null, stderr=piped。
  console.log(`[harness] spawn: ${py} -u main.py (cwd=${pluginDir}, stdout=null, stderr=piped)`);
  const child = spawn(py, ['-u', 'main.py'], { cwd: pluginDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; process.stderr.write(c); });
  // facefusion 首启下载 ONNX 模型（数百 MB），给 15 分钟；其余插件 2 分钟够。
  const waitMs = pluginId === 'facefusion' ? 15 * 60 * 1000 : 120000;
  console.log(`[harness] 等待端口 ${port} 起来（最多 ${Math.round(waitMs/1000)}s）…`);
  const up = await probePort(port, waitMs);
  let exitCode = null;
  if (up) {
    console.log(`\n[harness] ✅ 端口 ${port} 已响应 = 插件成功启动！`);
    console.log('[harness] 停止插件进程…');
    try { child.kill('SIGTERM'); } catch { /* noop */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 5000);
    return { ok: true, stderr };
  } else {
    // 超时：进程可能还活着但没起端口，或已退出。
    const still = child.exitCode === null && child.pid;
    console.log(`\n[harness] ❌ 端口 ${port} 未在 120s 内响应${still ? '（进程仍存活但没开端口）' : `（进程已退出）`}`);
    if (still) { try { child.kill('SIGKILL'); } catch { /* noop */ } }
    return { ok: false, stderr, exitCode: child.exitCode };
  }
}

async function runNodePlugin(pluginId, pluginDir, bridgeUrl, port) {
  const env = minimalEnv();
  env.LINGFANG_PLUGIN_BRIDGE_URL = bridgeUrl;
  env.LINGFANG_PLUGIN_BRIDGE_TOKEN = 'test-token-placeholder';
  console.log(`[harness] spawn: ${NODE_EXE} index.js (cwd=${pluginDir}, stdout=null, stderr=piped)`);
  const child = spawn(NODE_EXE, ['index.js'], { cwd: pluginDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; process.stderr.write(c); });
  console.log(`[harness] 等待端口 ${port} 起来（最多 120s）…`);
  const up = await probePort(port, 120000);
  if (up) {
    console.log(`\n[harness] ✅ 端口 ${port} 已响应 = 插件成功启动！`);
    console.log('[harness] 停止插件进程…');
    try { child.kill('SIGTERM'); } catch { /* noop */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 5000);
    return { ok: true, stderr };
  } else {
    const still = child.exitCode === null && child.pid;
    console.log(`\n[harness] ❌ 端口 ${port} 未在 120s 内响应${still ? '（进程仍存活但没开端口）' : `（进程已退出）`}`);
    if (still) { try { child.kill('SIGKILL'); } catch { /* noop */ } }
    return { ok: false, stderr, exitCode: child.exitCode };
  }
}

async function testPlugin(pluginId, opts) {
  console.log(`\n${'='.repeat(70)}\n测试插件：${pluginId}\n${'='.repeat(70)}`);
  const pluginDir = join(REPO, 'plugins', pluginId);
  if (!existsSync(pluginDir)) { console.error(`插件目录不存在：${pluginDir}`); return { id: pluginId, ok: false, reason: '目录不存在' }; }
  const port = PLUGIN_PORTS[pluginId];
  if (!port) { console.error(`未知插件：${pluginId}`); return { id: pluginId, ok: false, reason: '未知插件' }; }
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'));
  console.log(`[harness] runtime=${manifest.runtime_type} entry=${manifest.entry} port=${port}`);
  try {
    if (manifest.runtime_type === 'python') {
      const py = await ensurePythonVenv(pluginDir, opts.noRecreate);
      return { id: pluginId, ...(await runPythonPlugin(pluginId, pluginDir, py, opts.bridgeUrl, port)) };
    } else if (manifest.runtime_type === 'nodejs') {
      await ensureNodeDeps(pluginDir, opts.noRecreate);
      return { id: pluginId, ...(await runNodePlugin(pluginId, pluginDir, opts.bridgeUrl, port)) };
    } else {
      return { id: pluginId, ok: false, reason: `不支持的 runtime_type: ${manifest.runtime_type}` };
    }
  } catch (err) {
    console.error(`[harness] ❌ 异常：${err.message}`);
    return { id: pluginId, ok: false, reason: err.message };
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.ids.length === 0) {
    console.log('用法: node scripts/test-plugin-run.mjs <plugin-id>... [--no-venv-recreate] [--bridge-url URL]');
    console.log('可用插件: facefusion moneyprinter-turbo pixelle-video huobao-drama');
    console.log('示例: node scripts/test-plugin-run.mjs facefusion');
    process.exit(0);
  }
  if (!existsSync(PYTHON_EXE)) { console.error(`内置 Python 不存在：${PYTHON_EXE}`); process.exit(1); }
  if (!existsSync(NODE_EXE)) { console.error(`内置 Node 不存在：${NODE_EXE}`); process.exit(1); }
  const results = [];
  for (const id of opts.ids) results.push(await testPlugin(id, opts));
  console.log(`\n${'='.repeat(70)}\n汇总\n${'='.repeat(70)}`);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.id}: ${r.ok ? '成功启动' : (r.reason || '失败')}`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
