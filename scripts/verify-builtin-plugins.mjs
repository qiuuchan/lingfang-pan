#!/usr/bin/env node
// verify-builtin-plugins.mjs —— 内置插件「离线契约」验证。
//
// 目标：全新电脑下载灵坊后，内置插件必须开箱即跑（不依赖网络、不装第三方依赖）。
// 检查项（与 plugin_runner / runtime_resolver / tauri.conf resources 的运行时策略对齐）：
//   1. 每个内置插件目录存在 manifest.json（可解析、必备字段齐全）。
//   2. runtime_type 仅允许 client / nodejs / python（与本地运行器支持面一致）。
//   3. 入口文件存在：client=HTML 合法，nodejs=node --check，python=py_compile。
//   4. 零第三方依赖契约：不允许 requirements.txt / package.json 里的 dependencies
//      （内置 runtime 自带的 tsc/tsx/requests 等不在其列，见 runtimes/preset）。
//   5. 声明 llm.chat / image.generate 的插件必须带 try/catch 兜底（后端不可达时报错不崩）。
//
// 用法：node scripts/verify-builtin-plugins.mjs
// 任一项失败时进程退出码非 0（可直接接入 CI / verify-all.mjs）。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtinRoot = join(root, 'apps', 'desktop', 'builtin-plugins');
const IS_WIN = process.platform === 'win32';

// 内置运行时目录（apps/desktop/runtimes）在 Windows 下是 *.exe；macOS/Linux CI 上
// 可能不存在该目录——此时回退到 PATH 上的 python3/python 与 node，避免全部误报失败。
const runtimeDir = join(root, 'apps', 'desktop', 'runtimes');
const pythonExe = IS_WIN
  ? join(runtimeDir, 'python', 'python.exe')
  : join(runtimeDir, 'python', 'bin', 'python3');
const nodeExe = IS_WIN ? join(runtimeDir, 'nodejs', 'node.exe') : join(runtimeDir, 'nodejs', 'bin', 'node');
const pythonCmd = existsSync(pythonExe) ? pythonExe : IS_WIN ? 'python.exe' : 'python3';
const nodeCmd = existsSync(nodeExe) ? nodeExe : 'node';

const REQUIRED_FIELDS = ['id', 'name', 'version', 'runtime_type', 'entry', 'capabilities'];
const SUPPORTED_RUNTIMES = ['client', 'nodejs', 'python'];
const LLM_KINDS = new Set(['llm.chat', 'image.generate']);

let failures = 0;
let checked = 0;

function fail(message) {
  failures += 1;
  console.error(`✗ ${message}`);
}

function run(cmd, args, cwd) {
  try {
    return spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  } catch (e) {
    // spawnSync 在命令不存在等场景抛异常（而非返回 error 对象），统一转成 status=1。
    return { status: 1, stdout: '', stderr: String(e?.message ?? e) };
  }
}

/** 解析 entry 并强制约束在插件目录内，防 `../` 越界读取宿主文件。 */
function entryWithin(pluginDir, entry) {
  const p = resolve(pluginDir, entry);
  const base = resolve(pluginDir);
  if (p !== base && !p.startsWith(base + sep)) {
    fail(`${pluginDir}: 入口路径越出插件目录: ${entry}`);
    return null;
  }
  return p;
}

function checkPython(pluginDir, entry) {
  checked += 1;
  if (!existsSync(pythonExe)) {
    fail(`内置 Python 缺失: ${pythonExe}`);
    return;
  }
  const r = run(pythonCmd, ['-m', 'py_compile', entry], pluginDir);
  if (r.error) fail(`${pluginDir}: 无法启动 ${pythonCmd} — ${String(r.error)}`);
  else if (r.status !== 0) fail(`${pluginDir}: py_compile 失败 — ${r.stderr?.slice(0, 300)}`);
}

function checkNode(pluginDir, entry) {
  checked += 1;
  if (!existsSync(nodeExe)) {
    fail(`内置 Node 缺失: ${nodeExe}`);
    return;
  }
  const r = run(nodeCmd, ['--check', entry], pluginDir);
  if (r.error) fail(`${pluginDir}: 无法启动 ${nodeCmd} — ${String(r.error)}`);
  else if (r.status !== 0) fail(`${pluginDir}: node --check 失败 — ${r.stderr?.slice(0, 300)}`);
}

function checkClient(pluginDir, entry) {
  checked += 1;
  const path = entryWithin(pluginDir, entry);
  if (!path) return;
  let html = '';
  try {
    html = readFileSync(path, 'utf8');
  } catch (e) {
    fail(`${pluginDir}: ${entry} 读取失败 — ${e.message}`);
    return;
  }
  if (!/<html[\s>]/i.test(html) && !/<!doctype html/i.test(html)) {
    fail(`${pluginDir}: ${entry} 不是合法 HTML`);
  }
}

function checkErrorFallback(pluginDir, entry, runtime) {
  const path = entryWithin(pluginDir, entry);
  if (!path) return;
  const content = readFileSync(path, 'utf8');
  if (runtime === 'python') {
    if (!/except\s*(.+)?\s*:/.test(content)) fail(`${pluginDir}: LLM 调用缺少 except 兜底`);
  } else if (!/catch\s*\(/.test(content)) {
    fail(`${pluginDir}: LLM 调用缺少 catch 兜底`);
  }
}

function checkManifest(pluginDir, dirName) {
  const manifestPath = join(pluginDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    fail(`${dirName}: 缺少 manifest.json`);
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail(`${dirName}: manifest.json 解析失败 — ${e.message}`);
    return null;
  }
  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined) fail(`${dirName}: manifest 缺字段 ${field}`);
  }
  if (!SUPPORTED_RUNTIMES.includes(manifest.runtime_type)) {
    fail(`${dirName}: 不支持的 runtime_type=${manifest.runtime_type}`);
    return null;
  }
  return manifest;
}

function main() {
  if (!existsSync(builtinRoot)) return fail(`内置插件目录缺失: ${builtinRoot}`);
  const entries = readdirSync(builtinRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of entries) {
    // game-2048 等内置脚本目录无 manifest.json（纯运行时资产），跳过非插件目录。
    if (!existsSync(join(builtinRoot, dir.name, 'manifest.json'))) continue;

    const pluginDir = join(builtinRoot, dir.name);
    const manifest = checkManifest(pluginDir, dir.name);
    if (!manifest) continue;

    // 入口必须落在插件目录内（防 ../ 越权读取宿主文件内容做语法检查）
    const entryPath = entryWithin(pluginDir, manifest.entry);
    if (!entryPath) continue;
    if (!existsSync(entryPath)) {
      fail(`${dir.name}: 入口不存在 ${manifest.entry}`);
      continue;
    }

    // 零第三方依赖契约：python 不允许 requirements.txt；nodejs 不允许 dependencies。
    if (existsSync(join(pluginDir, 'requirements.txt'))) {
      fail(`${dir.name}: 存在 requirements.txt（违反内置插件零依赖契约）`);
    }
    if (existsSync(join(pluginDir, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
      if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
        fail(`${dir.name}: package.json 声明了 dependencies（违反内置插件零依赖契约）`);
      }
    }

    if (manifest.runtime_type === 'python') {
      checkPython(pluginDir, manifest.entry);
    } else if (manifest.runtime_type === 'nodejs') {
      checkNode(pluginDir, manifest.entry);
    } else {
      checkClient(pluginDir, manifest.entry);
    }

    const needsAi = (manifest.capabilities ?? []).some((c) => LLM_KINDS.has(c.kind));
    if (needsAi) checkErrorFallback(pluginDir, manifest.entry, manifest.runtime_type);
  }

  console.log(
    failures === 0
      ? `✓ 内置插件离线契约验证通过（${checked} 个入口）`
      : `✗ 内置插件离线契约验证失败（${failures} 项问题）`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();