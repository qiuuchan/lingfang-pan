// plugin-script.ts — R3 脚本型插件本地预览执行的类型与 invoke 封装。
//
// 职责：
// - 封装桌面壳 run_plugin_script / probe_script_runtime 两个 Tauri 命令的调用。
// - 把 Rust RunResult（stdout/stderr/exit_code/timed_out/elapsed_ms）+ ProbeResult
//   转换为 R5 creator-error.RunScriptResult 形状（ok/stdout/stderr/exitCode/failure/interpreter），
//   以便复用 R5 已实现的 fromRunResult 友好错误渲染。
//
// 安全：run_plugin_script 是不受控执行通道（软隔离），见 plugin_script.rs 顶部注释与 design §6.1。

import { tauriInvoke } from '@/lib/api';
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
}

/** 探测解释器是否可用 + 版本。缺失时 available=false 并带 hint 安装指引。 */
export function probeScriptRuntime(runtime: ScriptRuntime) {
  return tauriInvoke<ProbeResult>('probe_script_runtime', { runtime });
}

/** 运行插件脚本入参（前端 camelCase，封装层转为 Rust snake_case）。 */
export interface RunPluginScriptInput {
  pluginId: string;
  runtime: ScriptRuntime;
  entry: string;
  files: ScriptFile[];
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

  if (raw.timed_out) {
    return {
      ok: true,
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exit_code,
      failure: 'timeout',
      elapsedMs: raw.elapsed_ms,
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
    };
  }
  return {
    ok: true,
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exit_code,
    elapsedMs: raw.elapsed_ms,
  };
}

/** 安装指引文案（与 Rust install_hint 镜像，前端首屏快速展示无需等待 probe）。 */
// winget 包 id 经 microsoft/winget-pkgs 官方 manifest 核实（design §6.4）：
// Node.js LTS 是 OpenJS.NodeJS.LTS（非 OpenJS.Technology.NodeJS，后者不存在）。
export const RUNTIME_INSTALL_HINT: Record<ScriptRuntime, string> = {
  nodejs: '未检测到 Node.js。请安装：访问 https://nodejs.org 下载 LTS，或运行 winget install OpenJS.NodeJS.LTS',
  python: '未检测到 Python。请安装：运行 winget install Python.Python.3.12，或访问 https://python.org 下载。Windows 推荐 py launcher。',
};

/** 运行时显示名（UI 状态条展示）。 */
export const RUNTIME_LABEL: Record<ScriptRuntime, string> = {
  nodejs: 'Node.js',
  python: 'Python',
};
