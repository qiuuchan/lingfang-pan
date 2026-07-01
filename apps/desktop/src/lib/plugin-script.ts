// plugin-script.ts — R3 脚本型插件本地预览执行的类型与 invoke 封装。
//
// 职责：
// - 封装桌面壳 run_plugin_script / probe_script_runtime 两个 Tauri 命令的调用。
// - 把 Rust RunResult（stdout/stderr/exit_code/timed_out/elapsed_ms）+ ProbeResult
//   转换为 R5 creator-error.RunScriptResult 形状（ok/stdout/stderr/exitCode/failure/interpreter），
//   以便复用 R5 已实现的 fromRunResult 友好错误渲染。
//
// 安全：run_plugin_script 是不受控执行通道（软隔离），见 plugin_script.rs 顶部注释与 design §6.1。

import { tauriInvoke, apiBase, getAuthToken } from '@/lib/api';
import type { RunScriptResult } from '@/lib/creator-error';

/** 脚本型运行时（仅 nodejs/python，不含 client/cloud）。与契约 RuntimeType 子集对齐。 */
export type ScriptRuntime = 'nodejs' | 'python';

/** 脚本文件（前端 PluginDraft.files 形状）。 */
export interface ScriptFile {
  path: string;
  content: string;
}

/** Rust probe_script_runtime 返回结构（snake_case，serde 默认）。 */
export interface ProbeResult {
  available: boolean;
  binary_path: string | null;
  version: string | null;
  hint: string | null;
}

/** Rust run_plugin_script 返回结构（snake_case）。 */
export interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  elapsed_ms: number;
  /** 依赖安装日志摘要（试跑前自动装依赖时记录）。 */
  install_log?: string | null;
}

/** 探测软件内置解释器是否可用 + 版本。缺失时 available=false 并带打包指引。 */
export function probeScriptRuntime(runtime: ScriptRuntime) {
  return tauriInvoke<ProbeResult>('probe_script_runtime', { runtime });
}

/** 运行插件脚本入参（前端 camelCase，封装层转为 Rust snake_case）。 */
export interface RunPluginScriptInput {
  pluginId: string;
  runtime: ScriptRuntime;
  entry: string;
  files: ScriptFile[];
  capabilities?: string[];
  /** 超时毫秒，缺省由 Rust 侧兜底 15000。 */
  timeoutMs?: number;
}

/**
 * 运行插件脚本，返回统一 RunScriptResult（R5 形状）。
 *
 * 错误归一：
 * - 解释器缺失（Rust 返回 interpreter_missing: 前缀错误）→ failure: 'interpreter_missing'。
 * - spawn 失败（拉起异常）→ failure: 'spawn_failed'。
 * - 成功返回但 timed_out → failure: 'timeout'（Rust 已 kill 并收尾，ok=true 但标记超时）。
 * - 成功返回 exitCode 非 0 → failure: 'nonzero_exit'。
 * - 完全成功（exitCode=0 且未超时）→ ok=true，无 failure。
 */
export async function runPluginScript(input: RunPluginScriptInput): Promise<RunScriptResult> {
  let raw: RunResult;
  try {
    raw = await tauriInvoke<RunResult>('run_plugin_script', {
      input: {
        plugin_id: input.pluginId,
        runtime: input.runtime,
        entry: input.entry,
        files: input.files,
        capabilities: input.capabilities ?? [],
        api_base: apiBase(),
        auth_token: getAuthToken() ?? '',
        timeout_ms: input.timeoutMs ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 解释器缺失：Rust 返回 interpreter_missing:<hint> 前缀错误。
    if (message.startsWith('interpreter_missing:')) {
      return {
        ok: false,
        failure: 'interpreter_missing',
        stderr: message.slice('interpreter_missing:'.length),
      };
    }
    // 其余 spawn / 落盘 / 路径逃逸等异常归为 spawn_failed。
    return { ok: false, failure: 'spawn_failed', stderr: message };
  }

  // 依赖安装失败：Rust 在装依赖失败时返回 exit_code=null + install_log 含「依赖安装失败」。
  // 此时插件根本没跑起来（不是运行失败），单列为 spawn_failed 语义（让 AI 读 installLog 修复依赖）。
  const installLog = raw.install_log ?? undefined;
  if (raw.exit_code === null && installLog && installLog.includes('依赖安装失败')) {
    return { ok: false, failure: 'spawn_failed', stderr: installLog, installLog };
  }

  if (raw.timed_out) {
    return {
      ok: true,
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exit_code,
      failure: 'timeout',
      elapsedMs: raw.elapsed_ms,
      installLog,
    };
  }
  if (raw.exit_code !== 0) {
    return {
      ok: false,
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exit_code,
      failure: 'nonzero_exit',
      elapsedMs: raw.elapsed_ms,
      installLog,
    };
  }
  return {
    ok: true,
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exit_code,
    elapsedMs: raw.elapsed_ms,
    installLog,
  };
}

/** 内置运行时缺失指引文案（与 Rust install_hint 镜像）。 */
export const RUNTIME_INSTALL_HINT: Record<ScriptRuntime, string> = {
  nodejs: '未检测到软件内置 Node.js。请确认应用包内包含 runtimes/nodejs，并随安装包一起发布。',
  python: '未检测到软件内置 Python。请确认应用包内包含 runtimes/python，并随安装包一起发布。',
};

/** 运行时显示名（UI 状态条展示）。 */
export const RUNTIME_LABEL: Record<ScriptRuntime, string> = {
  nodejs: 'Node.js',
  python: 'Python',
};
