// 插件创建流程的统一错误模型与工厂。
// 目的：把散落在 PluginCreatorHome 的 toast / setLiveError 收敛为
// 「对话气泡 + 错误卡片」双通道，并提供错误分级（图标/颜色/可重试）。
// 本文件为纯前端内部类型，非跨进程契约（契约见 packages/contract）。

import type { ApiError } from '@/lib/api';

/** 错误等级：决定图标 / 颜色 / 是否可重试的视觉与交互。 */
export type CreatorErrorLevel = 'error' | 'warning' | 'info';

/** 错误分类：每种 kind 映射到固定中文标题、详情与可重试标志。 */
export type CreatorErrorKind =
  | 'cli_start_failed' // CLI 启动失败（code_assistant_start_session 抛错）
  | 'transcript_failed' // 读取 transcript 失败（read_transcript 抛错）
  | 'cli_session_error' // CLI 运行中 error 事件（code-assistant://error）
  | 'session_op_failed' // 会话操作失败（stop_session 抛错等）
  | 'upload_failed' // 上传团队云端 4xx/5xx
  | 'submit_market_failed' // 提交公共市场失败
  | 'interpreter_missing' // 解释器缺失（来自 R3 run_plugin_script）
  | 'run_timeout' // 预览执行超时（来自 R3）
  | 'run_failed' // 预览执行非零退出（来自 R3）
  | 'run_spawn_failed' // 预览执行进程拉起失败（来自 R3）
  | 'manifest_missing' // 持久化运行时 manifest 缺失（temp 目录空，AI 未产出）
  | 'plugin_crashed' // 持久化运行启动后秒退（插件代码异常，附 stderr）
  | 'entry_load_failed' // 客户端(HTML)插件入口文件读取/加载失败
  | 'unknown';

/** 统一错误对象：供 ErrorBubble 渲染。 */
export interface CreatorError {
  level: CreatorErrorLevel;
  kind: CreatorErrorKind;
  /** 面向用户的友好标题（如「无法启动代码助手」）。 */
  title: string;
  /** 面向用户的原因 / 建议（如「请检查 CLI 是否已安装并配置 API Key」）。 */
  detail?: string;
  /** 原始技术信息（折叠展示，便于排障，默认不展示给非高级用户）。 */
  raw?: string;
  /** 是否可重试（决定是否渲染「重试」按钮）。 */
  retryable?: boolean;
}

/** R3 run_plugin_script 返回的统一结构（前端期望形状；R3 实现须对齐）。 */
export interface RunScriptResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** 失败分类，前端据此映射到 CreatorErrorKind。 */
  failure?: 'interpreter_missing' | 'timeout' | 'nonzero_exit' | 'spawn_failed';
  /** 解释器探测到的可执行路径（用于友好卡片展示「已用 node vX」）。 */
  interpreter?: string;
  /** 执行耗时（毫秒），Rust RunResult.elapsed_ms 透传，前端状态条展示。 */
  elapsedMs?: number;
  /** 依赖安装日志摘要（试跑前自动装依赖时记录，AI 据此判断装了什么/是否成功）。 */
  installLog?: string;
}

/** 把任意 unknown 异常归一化为字符串（用于 raw 字段）。 */
function toRawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 文案表：每种 kind 的固定中文标题。 */
const TITLE_MAP: Record<CreatorErrorKind, string> = {
  cli_start_failed: '无法启动本地代码助手',
  transcript_failed: '读取代码助手输出失败',
  cli_session_error: '代码助手运行异常',
  session_op_failed: '代码助手会话操作失败',
  upload_failed: '上传到团队云端失败',
  submit_market_failed: '提交公共市场失败',
  interpreter_missing: '未检测到运行环境',
  run_timeout: '预览执行超时',
  run_failed: '预览执行未成功',
  run_spawn_failed: '预览执行无法启动',
  manifest_missing: '插件未生成完成',
  plugin_crashed: '插件启动后立即退出',
  entry_load_failed: '插件无法加载',
  unknown: '发生未知错误',
};

/** 文案表：每种 kind 的固定中文详情 / 建议。 */
const DETAIL_MAP: Record<CreatorErrorKind, string> = {
  cli_start_failed: '请确认所选 CLI 已安装、已登录，且 API Key 配置正确。',
  transcript_failed: '代码助手已运行但输出文件无法解析，可能是被中断或格式异常。',
  cli_session_error: '代码助手在运行中报告了错误，可在下方查看原始信息。',
  session_op_failed: '对当前会话执行操作时失败，可能已退出，请重新发起。',
  upload_failed: '请检查网络连接与登录态后重试；若提示已存在，说明团队云端已有相同插件。',
  submit_market_failed: '请检查网络连接与登录态后重试提交。',
  interpreter_missing:
    'Node.js 插件需要 Node（≥18），Python 插件需要 Python（≥3.10）。可通过 node 或 py 命令确认是否已安装。',
  run_timeout: '脚本在限定时间内未结束，可能存在死循环或阻塞输入。',
  run_failed: '脚本以非零状态码退出，请在下方查看完整输出定位错误。',
  run_spawn_failed: '进程无法拉起，可能是解释器路径无效或脚本文件不存在。',
  manifest_missing: '该插件目录缺少 manifest.json（可能是创建时 AI 未完成产出）。请继续对话让 AI 补全，或重新创建插件。',
  plugin_crashed: '插件代码运行时抛出异常导致进程立即退出。请查看下方错误信息定位并修复（或点「让 AI 修复」自动修）。',
  entry_load_failed: '读取或加载插件入口文件失败，可能是入口路径不存在、文件损坏或内容异常。可点「让 AI 修复」交给 AI 定位。',
  unknown: '请稍后重试，或查看下方原始信息。',
};

/** 可重试映射：决定是否渲染「重试」按钮。 */
const RETRYABLE_MAP: Record<CreatorErrorKind, boolean> = {
  cli_start_failed: true,
  transcript_failed: true,
  cli_session_error: true,
  session_op_failed: true,
  upload_failed: true,
  submit_market_failed: true,
  // 解释器缺失需先安装环境，重试无效。
  interpreter_missing: false,
  run_timeout: true,
  run_failed: true,
  run_spawn_failed: true,
  // manifest 缺失需先让 AI 补全产出，重试运行无效。
  manifest_missing: false,
  // 插件崩溃需先修代码，重试运行无效（用「让 AI 修复」自动修）。
  plugin_crashed: false,
  // 入口加载失败需先修源码/路径，重试加载多半无效（用「让 AI 修复」自动修）。
  entry_load_failed: false,
  unknown: true,
};

/** 按 kind + 原始异常构造友好错误对象。 */
export function toCreatorError(kind: CreatorErrorKind, error: unknown): CreatorError {
  const raw = toRawMessage(error);
  return {
    level: 'error',
    kind,
    title: TITLE_MAP[kind],
    detail: DETAIL_MAP[kind],
    raw: raw || undefined,
    retryable: RETRYABLE_MAP[kind],
  };
}

/**
 * 上传 / 提交市场的 HTTP 错误映射。
 * 复用 Market.friendlyError 思路（按 code 映射），并扩展「已存在」「未授权」等场景。
 * action 区分上传团队云端与提交公共市场两类动作的标题前缀。
 */
export function toUploadError(error: unknown, action: 'upload' | 'submit'): CreatorError {
  const raw = toRawMessage(error);
  const apiError = error as Partial<ApiError> | undefined;
  const code = apiError?.code;
  const message = apiError?.message || raw;

  // 团队云端已存在相同插件：降级为 info 提示（非真错误），不渲染重试。
  if (code === 'deduplicated' || /已存在|exists|duplicate/i.test(message)) {
    return {
      level: 'info',
      kind: action === 'upload' ? 'upload_failed' : 'submit_market_failed',
      title: action === 'upload' ? '团队云端已存在相同插件' : '该插件已提交至公共市场',
      detail: '无需重复上传，可直接在团队插件列表或市场中查看。',
      raw: raw || undefined,
      retryable: false,
    };
  }

  // 登录态失效：明确提示重新登录，重试无意义。
  if (code === 'unauthorized' || code === 'token_expired' || /未授权|unauthor|登录|login/i.test(message)) {
    return {
      level: 'error',
      kind: action === 'upload' ? 'upload_failed' : 'submit_market_failed',
      title: '登录态已失效，请重新登录',
      detail: '当前登录凭证无效或已过期，重新登录后即可继续操作。',
      raw: raw || undefined,
      retryable: false,
    };
  }

  // 通用失败：保留可重试。
  return {
    level: 'error',
    kind: action === 'upload' ? 'upload_failed' : 'submit_market_failed',
    title: action === 'upload' ? '上传到团队云端失败' : '提交公共市场失败',
    detail: '请检查网络连接与登录态后重试。',
    raw: raw || undefined,
    retryable: true,
  };
}

/** 把 R3 的 RunScriptResult 失败分支映射为 CreatorError。 */
export function fromRunResult(result: RunScriptResult): CreatorError {
  // 成功结果不应进入此函数，兜底返回 unknown。
  if (result.ok || !result.failure) {
    return {
      level: 'info',
      kind: 'unknown',
      title: TITLE_MAP.unknown,
      detail: DETAIL_MAP.unknown,
      raw: result.stderr || undefined,
      retryable: false,
    };
  }

  const kindMap: Record<NonNullable<RunScriptResult['failure']>, CreatorErrorKind> = {
    interpreter_missing: 'interpreter_missing',
    timeout: 'run_timeout',
    nonzero_exit: 'run_failed',
    spawn_failed: 'run_spawn_failed',
  };
  const kind = kindMap[result.failure];
  const detail =
    kind === 'interpreter_missing' && result.interpreter
      ? `未检测到运行环境（尝试路径：${result.interpreter}）。${DETAIL_MAP.interpreter_missing}`
      : DETAIL_MAP[kind];

  return {
    level: 'error',
    kind,
    title: TITLE_MAP[kind],
    detail,
    raw: [result.stdout && `stdout:\n${result.stdout}`, result.stderr && `stderr:\n${result.stderr}`]
      .filter(Boolean)
      .join('\n\n') || undefined,
    retryable: RETRYABLE_MAP[kind],
  };
}
