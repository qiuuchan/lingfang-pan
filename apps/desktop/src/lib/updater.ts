// updater.ts — 检查更新 / 下载安装的前端封装（design §5）。
//
// 职责：
// - 封装桌面壳 check_update / download_update 两个 Tauri 命令（自制更新器，已摆脱 tauri-plugin-updater）。
// - 暴露 UpdateMetadata / DownloadEvent 类型供 Settings 页与启动静默检查消费。
// - downloadUpdate 用 Tauri 2 Channel 推进度（官方推荐，类型安全优于字符串事件）。
//
// 契约对齐（Rust update.rs，design §5）：
// - UpdateMetadata serde rename_all="camelCase"：version / currentVersion / available / notes
//   / downloadUrl / sha256 / sizeBytes。
// - DownloadEvent serde tag="event"（PascalCase：Started/Progress/Finished），content="data"
//   （字段 camelCase：contentLength/chunkLength）。事件契约与旧实现一致，前端无需改进度逻辑。
//
// check_update 入参：{ channel: 'STABLE', backendUrl: 'http://...' }。
// download_update 入参：{ meta: UpdateMetadata, onEvent: Channel<DownloadEvent> }。
// 成功后 Rust 下载 + 校验 SHA-256 + 调起 updater.exe 覆盖重启，随后 app.exit()，本 Promise 不会 resolve。

import { Channel } from '@tauri-apps/api/core';
import { tauriInvoke } from '@/lib/api';

/** 更新检查结果（对应 Rust UpdateMetadata，camelCase 字段名）。
 *  available 始终为 true（Rust 仅在有更新时构造此结构；无更新返回 null）。
 *  downloadUrl/sha256/sizeBytes 供 downloadUpdate 下载 + 完整性校验（替代旧 minisign 签名）。 */
export interface UpdateMetadata {
  version: string;
  currentVersion: string;
  available: boolean;
  notes: string | null;
  downloadUrl: string;
  sha256: string;
  sizeBytes: number | null;
}

/** 下载安装进度事件（对应 Rust DownloadEvent，discriminated union）。
 *  event 字段 PascalCase，字段 camelCase。 */
export type DownloadEvent =
  | { event: 'Started'; data: { contentLength: number | null } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export type UpdateChannel = 'STABLE' | 'BETA';
const UPDATE_CHANNEL_STORAGE_KEY = 'lf:update-channel';

export function loadUpdateChannel(): UpdateChannel {
  try {
    return localStorage.getItem(UPDATE_CHANNEL_STORAGE_KEY) === 'BETA' ? 'BETA' : 'STABLE';
  } catch {
    return 'STABLE';
  }
}

export function saveUpdateChannel(channel: UpdateChannel): void {
  try { localStorage.setItem(UPDATE_CHANNEL_STORAGE_KEY, channel); } catch { /* localStorage 不可用则忽略 */ }
}

export function isBetaUpdateEnabled(): boolean {
  return loadUpdateChannel() === 'BETA';
}

// === 检查结果缓存（更新可用提示增强）===
// 启动静默检查 / 手动检查发现新版本时写入 localStorage，设置页挂载即读，无需重新请求后端
// 就能直接展示「发现新版本」并一键更新；检查无更新或开始安装时清除。
const CACHED_UPDATE_KEY = 'lf:cached-update';

export interface CachedUpdate {
  meta: UpdateMetadata;
  channel: UpdateChannel;
  /** 检查时间 ISO 字符串（展示「检查于 …」用）。 */
  checkedAt: string;
}

export function loadCachedUpdate(): CachedUpdate | null {
  try {
    const raw = localStorage.getItem(CACHED_UPDATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUpdate;
    // 结构兜底：缺关键字段视为无效缓存。checkedAt 非法（localStorage 被篡改/损坏）也判无效，
    // 避免设置页横幅显示 "Invalid Date"。
    if (!parsed?.meta?.version || !parsed?.meta?.downloadUrl) return null;
    if (!parsed.checkedAt || Number.isNaN(new Date(parsed.checkedAt).getTime())) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedUpdate(meta: UpdateMetadata, channel: UpdateChannel): void {
  try {
    const payload: CachedUpdate = { meta, channel, checkedAt: new Date().toISOString() };
    localStorage.setItem(CACHED_UPDATE_KEY, JSON.stringify(payload));
  } catch { /* localStorage 不可用则忽略 */ }
}

export function clearCachedUpdate(): void {
  try { localStorage.removeItem(CACHED_UPDATE_KEY); } catch { /* ignore */ }
}

/** 进度回调类型（供 Settings 页订阅 Started/Progress/Finished）。 */
export type DownloadEventHandler = (event: DownloadEvent) => void;

/**
 * 检查更新（不下载）。
 *
 * 调桌面 check_update：GET <backendUrl>/api/releases/latest?channel=&platform=&arch=&currentVersion=，
 * 读后端 updateAvailable + 匹配平台 asset。
 * 返回 null → 已是最新（无更新 / 无匹配平台产物 / 后端无已发布版本）；返回 UpdateMetadata → 有更新。
 *
 * 错误：backendUrl 无效 / 网络失败 → throw String（ApiError.message）。
 */
export function checkUpdate(backendUrl: string, channel: UpdateChannel = loadUpdateChannel()): Promise<UpdateMetadata | null> {
  return tauriInvoke<UpdateMetadata | null>('check_update', {
    channel,
    backendUrl,
  });
}

/**
 * 下载并安装更新（传入 checkUpdate 返回的 meta）。
 *
 * 用 Tauri 2 Channel 接收 Rust 推送的进度事件：
 * - Started：首个 chunk 到达，data.contentLength 为总字节数（未知则 null）。
 * - Progress：每个 chunk，data.chunkLength 为本次块字节数（前端累加算已下载量）。
 * - Finished：下载完成 + SHA-256 校验通过，即将调起 updater.exe 覆盖重启。
 *
 * Rust 下载完成后校验 SHA-256（不匹配则 throw），通过后复制 updater.exe 到临时目录、
 * 启动它 `update --wait-pid <主进程> --restart`、随后 app.exit()。
 * 成功路径本 Promise 不会 resolve（进程已退出）；校验/下载失败则 reject。
 */
export function downloadUpdate(meta: UpdateMetadata, onEvent: DownloadEventHandler): Promise<void> {
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = onEvent;
  return tauriInvoke<void>('download_update', { meta, onEvent: channel });
}
