// runtime-config.ts — 应用管理/用户指定运行时与镜像源的 Tauri 契约。

import { Channel } from '@tauri-apps/api/core';
import { tauriInvoke } from '@/lib/api';

/** 脚本型运行时种类（与 plugin-script ScriptRuntime 同语义，复用字面量）。 */
export type RuntimeKind = 'nodejs' | 'python';

/** 运行时来源。系统 PATH 不属于可执行来源。 */
export type RuntimeSource = 'appManaged' | 'userSpecified';

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

/** 镜像源选择。pipId/npmId 为预置 id 或 "custom"；*Url 仅 custom 时用。 */
export interface MirrorConfig {
  pipId: string;
  pipUrl?: string | null;
  npmId: string;
  npmUrl?: string | null;
}

/** Rust get_runtime_config 返回（简化版：仅 mirrors）。 */
export interface RuntimeConfig {
  userSpecifiedPython?: string | null;
  userSpecifiedNode?: string | null;
  appManagedPython?: ManagedEntry | null;
  appManagedNode?: ManagedEntry | null;
  mirrors: MirrorConfig;
  downloadMirrorBase?: string | null;
}

export interface ManagedEntry {
  version: string;
  dir: string;
  installedAt: string;
}

export interface SystemRuntimeProbe {
  available: boolean;
  path: string | null;
  version: string | null;
  meetsMinimum: boolean;
}

export type RuntimeDownloadEvent =
  | { event: 'Started'; data: { kind: string; total: number | null } }
  | { event: 'Progress'; data: { kind: string; downloaded: number; total: number | null } }
  | { event: 'Stage'; data: { kind: string; stage: string } }
  | { event: 'Finished'; data: { kind: string; version: string } };

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

/** 读取完整运行时配置（仅 mirrors）。 */
export function getRuntimeConfig() {
  return tauriInvoke<RuntimeConfig>('get_runtime_config');
}

/** 设置镜像源（写入 config.mirrors，仅注入本应用子进程）。 */
export function setMirrorConfig(mirrors: MirrorConfig) {
  return tauriInvoke<void>('set_mirror_config', { mirrors });
}

export function downloadRuntime(kind: RuntimeKind, onEvent: (event: RuntimeDownloadEvent) => void, version?: string) {
  const channel = new Channel<RuntimeDownloadEvent>();
  channel.onmessage = onEvent;
  return tauriInvoke<void>('download_runtime', { kind, version, onEvent: channel });
}

export function uninstallRuntime(kind: RuntimeKind) {
  return tauriInvoke<void>('uninstall_runtime', { kind });
}

export function setUserSpecifiedRuntime(kind: RuntimeKind, path: string | null) {
  return tauriInvoke<void>('set_user_specified_runtime', { kind, path });
}

export function probeSystemRuntime(kind: RuntimeKind) {
  return tauriInvoke<SystemRuntimeProbe>('probe_system_runtime', { kind });
}

// === UI 辅助 ===

/** 运行时显示名（与 plugin-script RUNTIME_LABEL 同步，独立导出避免循环依赖）。 */
export const RUNTIME_LABEL: Record<RuntimeKind, string> = {
  nodejs: 'Node.js',
  python: 'Python',
};

/** 来源 Badge 文案 + 样式 key。 */
export const SOURCE_LABEL: Record<RuntimeSource, string> = {
  appManaged: '应用管理',
  userSpecified: '用户指定',
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
