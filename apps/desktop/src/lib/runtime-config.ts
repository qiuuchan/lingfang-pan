// runtime-config.ts — 运行时按需下载与配置的前端封装（task 07-03 step 5）。
//
// 镜像 Rust 侧 runtime_commands 的 7 个 Tauri 命令 + runtime_download 的 2 个进度 event。
// 设置页 RuntimeEnvTab / 首启引导 RuntimeSetupGate 通过本模块与 Rust 交互。
//
// 命名约定：Rust serde camelCase（RuntimeStatus/SystemProbeResult 等用 #[serde(rename_all="camelCase")]）；
// Tauri 命令参数名直接用 snake_case 兼容的单词（kind/version/path/mirrors），前端原样传。

import { tauriInvoke } from '@/lib/api';
import type { listen } from '@tauri-apps/api/event';

/** 脚本型运行时种类（与 plugin-script ScriptRuntime 同语义，复用字面量）。 */
export type RuntimeKind = 'nodejs' | 'python';

/** 运行时来源（与 Rust RuntimeSource 对齐）。 */
export type RuntimeSource = 'app_managed' | 'user_specified' | 'legacy';

/** Rust get_runtime_status 单项（camelCase）。 */
export interface RuntimeStatus {
  available: boolean;
  source: RuntimeSource | null;
  version: string | null;
  dir: string | null;
}

/** Rust get_runtime_status 返回。 */
export interface RuntimeStatusMap {
  python: RuntimeStatus;
  node: RuntimeStatus;
}

/** 应用管理的运行时登记条目（download_runtime 返回 / RuntimeConfig 内嵌）。 */
export interface ManagedEntry {
  version: string;
  dir: string;
  installedAt: string;
}

/** 镜像源选择。pipId/npmId 为预置 id 或 "custom"；*Url 仅 custom 时用。 */
export interface MirrorConfig {
  pipId: string;
  pipUrl?: string | null;
  npmId: string;
  npmUrl?: string | null;
}

/** Rust get_runtime_config 返回（整体 runtime-config.json 形态）。 */
export interface RuntimeConfig {
  userSpecifiedPython: string | null;
  userSpecifiedNode: string | null;
  appManagedPython: ManagedEntry | null;
  appManagedNode: ManagedEntry | null;
  mirrors: MirrorConfig;
  downloadMirrorBase: string | null;
}

/** Rust probe_system_runtime 返回（仅信息展示，不参与执行）。 */
export interface SystemProbeResult {
  path: string | null;
  version: string | null;
  meetsMinimum: boolean;
}

/** 下载阶段 event payload（runtime-download-stage）。 */
export interface DownloadStagePayload {
  kind: RuntimeKind;
  stage: 'downloading' | 'verifying' | 'extracting' | 'activating' | 'done' | 'failed';
}

/** 下载进度 event payload（runtime-download-progress）。 */
export interface DownloadProgressPayload {
  kind: RuntimeKind;
  downloaded: number;
  total: number | null;
}

// === 镜像源预置清单（与 Rust mirror_presets.rs 对齐；改一处需同步两侧） ===

export interface MirrorPreset {
  id: string;
  label: string;
  url: string;
}

export const PIP_MIRROR_PRESETS: MirrorPreset[] = [
  { id: 'tsinghua', label: '清华', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { id: 'aliyun', label: '阿里', url: 'https://mirrors.aliyun.com/pypi/simple/' },
  { id: 'tencent', label: '腾讯', url: 'https://mirrors.cloud.tencent.com/pypi/simple' },
  { id: 'huawei', label: '华为', url: 'https://repo.huaweicloud.com/repository/pypi/simple' },
  { id: 'official', label: '官方', url: 'https://pypi.org/simple' },
];

export const NPM_MIRROR_PRESETS: MirrorPreset[] = [
  { id: 'npmmirror', label: 'npmmirror', url: 'https://registry.npmmirror.com' },
  { id: 'huawei', label: '华为', url: 'https://repo.huaweicloud.com/repository/npm/' },
  { id: 'tencent', label: '腾讯', url: 'https://mirrors.cloud.tencent.com/npm/' },
  { id: 'official', label: '官方', url: 'https://registry.npmjs.org' },
];

export const CUSTOM_MIRROR_ID = 'custom';

// === 命令封装 ===

/** 查询当前生效的 python/node 运行时来源 + 版本。 */
export function getRuntimeStatus() {
  return tauriInvoke<RuntimeStatusMap>('get_runtime_status');
}

/** 下载便携版运行时（异步，进度经 runtime-download-stage/progress event 推送）。 */
export function downloadRuntime(kind: RuntimeKind, version?: string) {
  return tauriInvoke<ManagedEntry>('download_runtime', {
    kind,
    version: version ?? null,
  });
}

/** 卸载应用管理的运行时（删目录 + 清 config 条目）。返回是否真的清理了。 */
export function uninstallRuntime(kind: RuntimeKind) {
  return tauriInvoke<boolean>('uninstall_runtime', { kind });
}

/** 读取完整运行时配置（镜像源 + app_managed 登记 + 用户指定路径）。 */
export function getRuntimeConfig() {
  return tauriInvoke<RuntimeConfig>('get_runtime_config');
}

/** 设置镜像源（写入 config.mirrors，仅注入本应用子进程）。 */
export function setMirrorConfig(mirrors: MirrorConfig) {
  return tauriInvoke<void>('set_mirror_config', { mirrors });
}

/** 设置/清除用户手动指定的运行时路径（path=null 清除，回退 app_managed）。 */
export function setUserSpecifiedRuntime(kind: RuntimeKind, path: string | null) {
  return tauriInvoke<void>('set_user_specified_runtime', { kind, path });
}

/** 探测系统 PATH 上的运行时版本（仅信息展示）。 */
export function probeSystemRuntime(kind: RuntimeKind) {
  return tauriInvoke<SystemProbeResult>('probe_system_runtime', { kind });
}

// === 进度 event 订阅 ===

/**
 * 订阅下载阶段 event（downloading/verifying/extracting/activating/done/failed）。
 * 返回 unlisten 函数（组件卸载时调用）。
 */
export async function onDownloadStage(
  handler: (payload: DownloadStagePayload) => void,
): Promise<() => void> {
  const { listen: doListen } = await import('@tauri-apps/api/event');
  return doListen<DownloadStagePayload>('runtime-download-stage', (event) => {
    handler(event.payload);
  });
}

/** 订阅下载进度 event（downloaded/total）。 */
export async function onDownloadProgress(
  handler: (payload: DownloadProgressPayload) => void,
): Promise<() => void> {
  const { listen: doListen } = await import('@tauri-apps/api/event');
  return doListen<DownloadProgressPayload>('runtime-download-progress', (event) => {
    handler(event.payload);
  });
}

// === UI 辅助 ===

/** 运行时显示名（与 plugin-script RUNTIME_LABEL 同步，独立导出避免循环依赖）。 */
export const RUNTIME_LABEL: Record<RuntimeKind, string> = {
  nodejs: 'Node.js',
  python: 'Python',
};

/** 来源 Badge 文案 + 样式 key。 */
export const SOURCE_LABEL: Record<RuntimeSource, string> = {
  app_managed: '应用管理',
  user_specified: '用户指定',
  legacy: '内置（过渡）',
};

/** 把版本字符串归一化展示（去 "Python "/"v" 前缀）。 */
export function formatVersion(label: string, version: string | null): string | null {
  if (!version) return null;
  const trimmed = version.trim();
  const withoutLabel = trimmed.toLowerCase().startsWith(label.toLowerCase())
    ? trimmed.slice(label.length).trim()
    : trimmed;
  const normalized = withoutLabel.replace(/^v/i, '');
  return normalized || trimmed;
}

/** 字节数 → 人类可读（与 Settings formatBytes 同款，独立导出供 DownloadProgress 用）。 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// 占位引用以保证类型导入在 tree-shaking 前不丢（listen 仅作类型用）。
export type { listen as _ListenFn } from '@tauri-apps/api/event';
