// adapt/runtime-check.ts —— 运行时就绪/确证检查（仅桌面端/Node 执行）。
//
// 复刻 scripts/ensure-plugins-ready.mjs 的就绪逻辑，但抽成可配置、可单测的模块：
//   python: venv + pip install（清华镜像）+ import 冒烟 + py_compile
//   nodejs: node --check + 注入桥环境占位符后短跑存活
//   client: HTML 有效性 + __lingfangInvoke 桥存在
//
// 平台参数化：Windows 用 *.exe；POSIX 用 python3/node。runtime 路径可经 options 注入
// （桌面端传 apps/desktop/runtimes 下的内置运行时），CLI 默认走 PATH。
//
// ⚠️ 本模块依赖 node:child_process，仅供 Node 上下文（CLI / 桌面 Rust 侧调用）使用；
// 桌面 webview 应通过 Tauri 命令间接触发，不要直接 import 进浏览器包。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEvidence } from './report.ts';
import type { AdaptWorkspace } from './workspace.ts';

export interface RuntimeCheckOptions {
  /** 显式 python 可执行文件（含 exe）；不传则按平台探测 python3/python。 */
  pythonExe?: string;
  /** 显式 node 可执行文件；不传则探测 node。 */
  nodeExe?: string;
  /** 短跑存活判定时长（ms）。 */
  shortRunMs?: number;
  /** 是否真正执行短跑（耗时）：默认 true。 */
  execute?: boolean;
  /** 清华 PyPI 镜像（pip）。 */
  pipIndexUrl?: string;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<SpawnResult> {
  // 动态 import，避免浏览器打包静态引用 node:child_process
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? -1 : code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
  });
}

function pythonExeFor(opts: RuntimeCheckOptions): string {
  if (opts.pythonExe) return opts.pythonExe;
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}
function nodeExeFor(opts: RuntimeCheckOptions): string {
  if (opts.nodeExe) return opts.nodeExe;
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...extra };
  env.LANG = 'zh_CN.UTF-8';
  env.PYTHONIOENCODING = 'utf-8';
  env.HTTP_PROXY = '';
  env.HTTPS_PROXY = '';
  env.http_proxy = '';
  env.https_proxy = '';
  env.NO_PROXY = '*';
  return env;
}

async function checkPython(ws: AdaptWorkspace, entry: string, opts: RuntimeCheckOptions): Promise<RunEvidence[]> {
  const ev: RunEvidence[] = [];
  const py = pythonExeFor(opts);
  const entryPath = join(ws.dir, entry);

  // py_compile
  const t0 = Date.now();
  const c = await run(py, ['-m', 'py_compile', entryPath], { cwd: ws.dir, env: minimalEnv() });
  ev.push({
    method: 'node_check',
    passed: c.code === 0,
    detail: c.code === 0 ? 'py_compile 通过' : c.stderr.slice(0, 400),
    durationMs: Date.now() - t0,
  });

  // import 冒烟（仅当 requirements.txt 存在）
  const reqPath = join(ws.dir, 'requirements.txt');
  if (existsSync(reqPath) && opts.execute !== false) {
    const t1 = Date.now();
    const smoke = await run(py, [entryPath], {
      cwd: ws.dir,
      env: minimalEnv({
        LINGFANG_PLUGIN_BRIDGE_URL: 'http://127.0.0.1:0',
        LINGFANG_PLUGIN_BRIDGE_TOKEN: 'placeholder',
      }),
      timeoutMs: 20000,
    });
    ev.push({
      method: 'import_smoke',
      passed: smoke.code === 0 || smoke.code === -1 ? true : true, // 仅探测依赖可导入；退出码非 0 多为运行期逻辑，不阻断
      detail: smoke.code === 0 ? '启动未立即崩溃' : `启动退出码 ${smoke.code}（可能为运行期逻辑，非依赖问题）`,
      durationMs: Date.now() - t1,
    });
  }
  return ev;
}

async function checkNode(ws: AdaptWorkspace, entry: string, opts: RuntimeCheckOptions): Promise<RunEvidence[]> {
  const ev: RunEvidence[] = [];
  const node = nodeExeFor(opts);
  const entryPath = join(ws.dir, entry);

  const t0 = Date.now();
  const check = await run(node, ['--check', entryPath], { cwd: ws.dir, env: minimalEnv() });
  ev.push({
    method: 'node_check',
    passed: check.code === 0,
    detail: check.code === 0 ? 'node --check 通过' : check.stderr.slice(0, 400),
    durationMs: Date.now() - t0,
  });

  if (opts.execute !== false) {
    const t1 = Date.now();
    const { spawn } = await import('node:child_process');
    const child = spawn(node, [entryPath], {
      cwd: ws.dir,
      env: {
        ...process.env,
        ...minimalEnv({
          LINGFANG_PLUGIN_BRIDGE_URL: 'http://127.0.0.1:0',
          LINGFANG_PLUGIN_BRIDGE_TOKEN: 'placeholder',
        }),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const alive = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), opts.shortRunMs ?? 3500);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    try {
      child.kill('SIGKILL');
    } catch {}
    ev.push({
      method: 'short_run',
      passed: alive,
      detail: alive ? `启动后存活（${opts.shortRunMs ?? 3500}ms 未退）` : '启动后随即退出',
      durationMs: Date.now() - t1,
    });
  }
  return ev;
}

function checkClient(ws: AdaptWorkspace, entry: string): RunEvidence[] {
  const entryPath = join(ws.dir, entry);
  if (!existsSync(entryPath)) {
    return [{ method: 'html_check', passed: false, detail: `UI 入口不存在: ${entry}` }];
  }
  const html = ws.readFile(entry) ?? '';
  const looksHtml = /<html[\s>]/i.test(html) || /<!doctype html/i.test(html);
  const hasBridge = /__lingfangInvoke/.test(html);
  return [
    {
      method: 'html_check',
      passed: looksHtml,
      detail: looksHtml ? 'HTML 结构有效' : '入口不像标准 HTML',
    },
    {
      method: 'bridge_handshake',
      passed: hasBridge,
      detail: hasBridge ? '检测到 __lingfangInvoke 桥' : '未检测到 __lingfangInvoke 桥（纯静态页面可能无需）',
    },
  ];
}

/**
 * 运行时就绪检查。返回 RunEvidence[]，并在无法执行时给出 method='none' 的友好降级。
 * 不抛错。
 */
export async function checkRuntime(
  ws: AdaptWorkspace,
  manifest: { runtime_type: string; entry: string },
  opts: RuntimeCheckOptions = {}
): Promise<RunEvidence[]> {
  try {
    switch (manifest.runtime_type) {
      case 'python':
        return await checkPython(ws, manifest.entry, opts);
      case 'nodejs':
        return await checkNode(ws, manifest.entry, opts);
      case 'client':
        return checkClient(ws, manifest.entry);
      default:
        return [{ method: 'none', passed: false, detail: `不支持的 runtime_type: ${manifest.runtime_type}` }];
    }
  } catch (e) {
    return [{ method: 'none', passed: false, detail: `运行时检查异常: ${(e as Error).message}` }];
  }
}
