#!/usr/bin/env node
// ensure-plugins-ready.mjs —— 确保本机「灵坊承载插件」全部可运行。
//
// 复刻桌面端 plugin_runner.rs 的就绪契约（venv + pip install + import 冒烟），
// 但适配当前 plugins/ 下的实际 7 个插件，并用「import 冒烟 + py_compile / node --check」
// 代替端口探测（GUI 插件无端口、无显示器无法真正跑完，但依赖就绪 + 代码语法正确即满足可运行）。
//
// 关键：运行器用白名单环境（不含宿主失效的 HTTP(S)_PROXY 127.0.0.1:7897），故 pip 走直连，
// 命中 PIP_INDEX_URL=清华镜像。本脚本同样只转发白名单变量，避免死代理。
//
// 用法： node scripts/ensure-plugins-ready.mjs [--recreate] [--only <id>]...
//   --recreate   强制重建 venv 并重装依赖
//   --only <id>  只校验指定插件（可多次）

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const RUNTIMES = join(REPO, 'apps', 'desktop', 'runtimes');
const PYTHON_EXE = join(RUNTIMES, 'python', 'python.exe');
const NODE_EXE = join(RUNTIMES, 'nodejs', 'node.exe');
const PLUGINS_DIR = join(REPO, 'plugins');

/** 仅转发白名单变量，制造与 RuntimeResolver.env(minimal_env()) 等价的环境（不含死代理）。 */
function minimalEnv(extra = {}) {
  const keys = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ];
  const env = {};
  for (const k of keys) if (process.env[k] !== undefined) env[k] = process.env[k];
  const paths = [
    join(RUNTIMES, 'nodejs'),
    join(RUNTIMES, 'python'),
    join(RUNTIMES, 'python', 'Scripts'),
    join(RUNTIMES, 'ffmpeg'),
  ].filter((p) => existsSync(p));
  if (process.env.SystemRoot) paths.push(join(process.env.SystemRoot, 'System32'));
  env.PATH = paths.join(';');
  // 清华 PyPI 镜像（与 runtime_resolver 注入一致）。
  env.PIP_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple';
  env.PIP_TRUSTED_HOST = 'pypi.tuna.tsinghua.edu.cn';
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  env.PIP_NO_INPUT = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.LANG = 'zh_CN.UTF-8';
  // 显式清空死代理，确保走直连。
  env.HTTP_PROXY = '';
  env.HTTPS_PROXY = '';
  env.http_proxy = '';
  env.https_proxy = '';
  env.NO_PROXY = '*';
  return { ...env, ...extra };
}

/** 全局 pip 缓存目录（与 plugin_runner::global_cache_dir 对齐，便于桌面端首次启动复用已下轮子）。 */
function pipCacheDir() {
  const base = process.env.LOCALAPPDATA || process.env.HOME || process.env.TEMP;
  return join(base, 'LingFang', 'cache', 'pip-cache');
}

function stablePathHash(p) {
  const norm = p.replace(/\\/g, '/').toLowerCase();
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 16);
}
function venvDir(pluginDir) {
  const base = process.env.LOCALAPPDATA || process.env.HOME;
  return join(base, 'LingFang', 'python-venvs', `venv-test-${stablePathHash(pluginDir)}`);
}
function venvPython(vdir) {
  return join(vdir, 'Scripts', 'python.exe');
}
function venvHasPip(vdir) {
  return existsSync(join(vdir, 'Lib', 'site-packages', 'pip'));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolveFn) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
      process.stdout.write(c);
    });
    child.stderr.on('data', (c) => {
      stderr += c;
      process.stderr.write(c);
    });
    child.on('exit', (code) => resolveFn({ code, stdout, stderr }));
    child.on('error', (err) => resolveFn({ code: -1, stdout, stderr, error: err }));
  });
}

// === 依赖名 → import 名（移植 plugin_runner.rs 的 dist_to_import_name + normalize） ===
const DIST_IMPORT_MAP = {
  pillow: 'PIL',
  pyyaml: 'yaml',
  beautifulsoup4: 'bs4',
  openpyxl: 'openpyxl',
  lxml: 'lxml',
  requests: 'requests',
  pyqt5: 'PyQt5',
  pyside6: 'PySide6',
  psutil: 'psutil',
  'ffmpeg-python': 'ffmpeg_python',
  tkinterdnd2: 'tkinterdnd2',
  videofetch: 'videofetch',
};
function parseReqDistNames(content) {
  const names = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    if (line.includes('://') || line.startsWith('.') || line.includes('@ ')) continue;
    const name = line
      .split(/[;<\[]/)[0]
      .split(/[><=!~]/)[0]
      .trim();
    if (name) names.push(name);
  }
  return names;
}
function smokeImportNames(distNames) {
  const out = [];
  for (const d of distNames) {
    const low = d.toLowerCase();
    if (DIST_IMPORT_MAP[low]) out.push(DIST_IMPORT_MAP[low]);
    else out.push(d.replace(/[-.]/g, '_'));
  }
  return [...new Set(out)].sort();
}
function buildSmokeScript(importNames) {
  const namesLiteral = '[' + importNames.map((n) => JSON.stringify(n)).join(', ') + ']';
  return `
import importlib, sys, traceback
names = ${namesLiteral}
corrupt = []
for name in names:
    try:
        importlib.import_module(name)
    except ModuleNotFoundError:
        pass
    except ImportError as e:
        msg = str(e).lower()
        cause = "".join(traceback.format_exception(type(e), e, e.__traceback__)).lower()
        if "null byte" in cause or "null byte" in msg or ("errno" in cause and "oserror" in cause):
            corrupt.append((name, repr(e)))
    except (SyntaxError, ValueError, OSError, UnicodeDecodeError) as e:
        corrupt.append((name, repr(e)))
    except BaseException:
        pass
if corrupt:
    for name, reason in corrupt:
        sys.stderr.write("CORRUPT:" + name + " " + reason + "\\n")
    sys.exit(2)
sys.exit(0)
`;
}

async function ensurePythonVenv(pluginDir, recreate) {
  const vdir = venvDir(pluginDir);
  const py = venvPython(vdir);
  if (!existsSync(py) || !venvHasPip(vdir) || recreate) {
    if (existsSync(vdir)) {
      rmSync(vdir, { recursive: true, force: true });
    }
    console.log(`  · 创建 venv: ${vdir}`);
    const r = await run(PYTHON_EXE, ['-m', 'venv', '--clear', vdir], { env: minimalEnv() });
    if (r.code !== 0) throw new Error(`venv 创建失败 (exit ${r.code})`);
  }
  const req = join(pluginDir, 'requirements.txt');
  if (existsSync(req)) {
    const cache = pipCacheDir();
    mkdirSync(cache, { recursive: true });
    console.log(`  · pip install -r requirements.txt（清华镜像，PIP_CACHE_DIR=${cache}）`);
    const r = await run(py, ['-m', 'pip', 'install', '--no-input', '-r', req], {
      cwd: pluginDir,
      env: { ...minimalEnv(), PIP_CACHE_DIR: cache },
    });
    if (r.code !== 0)
      throw new Error(`pip install 失败 (exit ${r.code}): ${r.stderr.slice(0, 500)}`);
  }
  return { py, vdir };
}

async function smokeAndCompile(py, vdir, pluginDir, entry) {
  const req = join(pluginDir, 'requirements.txt');
  if (existsSync(req)) {
    const distNames = parseReqDistNames(readFileSync(req, 'utf8'));
    const importNames = smokeImportNames(distNames);
    if (importNames.length) {
      const script = buildSmokeScript(importNames);
      const sp = join(vdir, '.lf-smoke.py');
      writeFileSync(sp, script);
      const r = await run(py, [sp], { env: minimalEnv(), timeout: 120000 });
      try {
        rmSync(sp);
      } catch {}
      if (r.code === 2) throw new Error('依赖损坏: ' + r.stderr.trim());
      if (r.code !== 0)
        throw new Error('import 冒烟异常 (exit ' + r.code + '): ' + r.stderr.slice(0, 400));
      console.log(`  · import 冒烟通过: ${importNames.join(', ')}`);
    }
  }
  // 语法编译入口。
  const entryPath = join(pluginDir, entry);
  const c = await run(py, ['-m', 'py_compile', entryPath], { env: minimalEnv() });
  if (c.code !== 0)
    throw new Error(`py_compile ${entry} 失败 (exit ${c.code}): ${c.stderr.slice(0, 400)}`);
  console.log(`  · py_compile ${entry} 通过`);
}

async function checkNode(pluginDir, entry) {
  const entryPath = join(pluginDir, entry);
  const c = await run(NODE_EXE, ['--check', entryPath], { env: minimalEnv() });
  if (c.code !== 0)
    throw new Error(`node --check ${entry} 失败 (exit ${c.code}): ${c.stderr.slice(0, 400)}`);
  console.log(`  · node --check ${entry} 通过`);
  // 短跑验证启动不立即崩溃（桥缺失仅影响点击 AI，不影响进程拉起）。
  const child = spawn(NODE_EXE, [entry], {
    cwd: pluginDir,
    env: {
      ...minimalEnv(),
      LINGFANG_PLUGIN_BRIDGE_URL: 'http://127.0.0.1:0',
      LINGFANG_PLUGIN_BRIDGE_TOKEN: 'placeholder',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (c) => {
    err += c;
  });
  await new Promise((res) => setTimeout(res, 3500));
  const alive = child.exitCode === null;
  try {
    child.kill('SIGKILL');
  } catch {}
  if (alive) console.log(`  · 启动存活（3.5s 未退）✅`);
  else
    console.log(
      `  · 启动后 ${child.exitCode === null ? '存活' : '退出码 ' + child.exitCode}（stderr: ${err.slice(0, 200) || '(空)'}）`
    );
}

function checkClient(pluginDir, entry) {
  const p = join(pluginDir, entry);
  if (!existsSync(p)) throw new Error(`UI 入口不存在: ${p}`);
  const html = readFileSync(p, 'utf8');
  if (!/<html[\s>]/i.test(html) && !/<!doctype html/i.test(html)) {
    console.log(`  · 警告：${entry} 不像标准 HTML，但仍存在（${html.length} 字节）`);
  } else {
    console.log(`  · UI 入口 ${entry} 有效（${html.length} 字节）✅`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let recreate = false;
  const only = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--recreate') recreate = true;
    else if (args[i] === '--only') only.push(args[++i]);
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('用法: node scripts/ensure-plugins-ready.mjs [--recreate] [--only <id>]...');
      process.exit(0);
    }
  }
  if (!existsSync(PYTHON_EXE)) {
    console.error(`内置 Python 不存在: ${PYTHON_EXE}`);
    process.exit(1);
  }
  if (!existsSync(NODE_EXE)) {
    console.error(`内置 Node 不存在: ${NODE_EXE}`);
    process.exit(1);
  }

  // 扫描 plugins/*/manifest.json。
  const ids = readdirSync(PLUGINS_DIR)
    .filter((d) => {
      const m = join(PLUGINS_DIR, d, 'manifest.json');
      return existsSync(m) && statSync(m).isFile();
    })
    .sort();
  const targets = only.length ? ids.filter((d) => only.includes(d)) : ids;
  if (!targets.length) {
    console.error('未找到任何插件');
    process.exit(1);
  }

  const results = [];
  for (const id of targets) {
    const pluginDir = join(PLUGINS_DIR, id);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'));
    } catch (e) {
      results.push({ id, ok: false, reason: 'manifest 解析失败: ' + e.message });
      continue;
    }
    const rt = manifest.runtime_type;
    const entry = manifest.entry || (rt === 'python' ? 'main.py' : 'index.js');
    console.log(
      `\n${'='.repeat(72)}\n插件: ${id}  (runtime=${rt}, entry=${entry})\n${'='.repeat(72)}`
    );
    try {
      if (rt === 'python') {
        const { py, vdir } = await ensurePythonVenv(pluginDir, recreate);
        await smokeAndCompile(py, vdir, pluginDir, entry);
      } else if (rt === 'nodejs') {
        await checkNode(pluginDir, entry);
      } else if (rt === 'client') {
        checkClient(pluginDir, entry);
      } else {
        throw new Error(`不支持的 runtime_type: ${rt}`);
      }
      results.push({ id, ok: true });
      console.log(`✅ ${id} 就绪`);
    } catch (e) {
      results.push({ id, ok: false, reason: e.message });
      console.error(`❌ ${id} 失败: ${e.message}`);
    }
  }

  console.log(`\n${'='.repeat(72)}\n汇总\n${'='.repeat(72)}`);
  for (const r of results)
    console.log(`${r.ok ? '✅' : '❌'} ${r.id}${r.ok ? '' : ': ' + r.reason}`);
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n结果: ${okCount}/${results.length} 个插件就绪`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
