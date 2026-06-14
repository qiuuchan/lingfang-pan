// updater.ts — 检查更新 / 下载安装的前端封装（design §3.1）。
//
// 职责：
// - 封装桌面壳 check_update / download_and_install 两个 Tauri 命令。
// - 暴露 UpdateMetadata / DownloadEvent 类型供 Settings 页消费。
// - downloadAndInstall 用 Tauri 2 Channel 推进度（官方推荐，类型安全优于字符串事件）。
//
// 契约对齐（Rust updater.rs，design §4.4）：
// - UpdateMetadata serde rename_all="camelCase"：version / currentVersion / available / notes。
// - DownloadEvent serde tag="event"（PascalCase：Started/Progress/Finished），content="data"
//   （字段 camelCase：contentLength/chunkLength）。event 字段名保持 PascalCase 是官方
//   tauri-plugin-updater JS 端 switch(event.event) 的约定（见 updater.rs 单测断言）。
//
// Channel 用法（已用 context7 查证 /tauri-apps/tauri-docs 官方文档，非训练记忆）：
// - import { Channel } from '@tauri-apps/api/core'。
// - new Channel<T>() 创建通道，设置 .onmessage = handler 接收事件。
// - 作为 invoke 参数传入：tauriInvoke('download_and_install', { onEvent })。
// - TitleBar.tsx 已用 @tauri-apps/api/window 标准导入（v2 推荐路径），同源复用。
//
// check_update 入参（design §4.4）：{ channel: 'STABLE', backendUrl: 'http://...' }。
// download_and_install 入参：{ onEvent: Channel<DownloadEvent> }（无其它参数，Update 来自全局 PendingUpdate）。

import { Channel } from '@tauri-apps/api/core';
import { tauriInvoke } from '@/lib/api';

/** 更新检查结果（对应 Rust UpdateMetadata，camelCase 字段名）。
 *  available 始终为 true（Rust 仅在有更新时构造此结构；无更新返回 null）。 */
export interface UpdateMetadata {
  version: string;
  currentVersion: string;
  available: boolean;
  notes: string | null;
}

/** 下载安装进度事件（对应 Rust DownloadEvent，discriminated union）。
 *  event 字段 PascalCase（对齐官方 tauri-plugin-updater JS 端约定），字段 camelCase。 */
export type DownloadEvent =
  | { event: 'Started'; data: { contentLength: number | null } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

/** 更新通道（design R2 约束：endpoint 动态，channel 走 STABLE）。
 *  后端 release 模块当前仅 seed 了 STABLE 通道，硬编码即可。 */
export const UPDATE_CHANNEL = 'STABLE';

/** 进度回调类型（供 Settings 页订阅 Started/Progress/Finished）。 */
export type DownloadEventHandler = (event: DownloadEvent) => void;

/**
 * 检查更新（不下载）。
 *
 * 调桌面 check_update 命令，传入通道 + 后端地址（Rust 侧据此运行时拼接 tauri-update 端点）。
 * 返回 null → 已是最新（后端 204 / 无匹配平台产物）；返回 UpdateMetadata → 有更新。
 *
 * 错误：backendUrl 无效 / 网络失败 / 验签元数据异常 → throw String（ApiError.message）。
 */
export function checkUpdate(backendUrl: string): Promise<UpdateMetadata | null> {
  return tauriInvoke<UpdateMetadata | null>('check_update', {
    channel: UPDATE_CHANNEL,
    backendUrl,
  });
}

/**
 * 下载并安装待处理的更新（来自上次 check_update 缓存的 PendingUpdate）。
 *
 * 用 Tauri 2 Channel 接收 Rust 推送的进度事件：
 * - Started：首个 chunk 到达，data.contentLength 为总字节数（未知则 null）。
 * - Progress：每个 chunk，data.chunkLength 为本次块字节数（前端累加算已下载量）。
 * - Finished：下载完成，即将进入安装阶段，随后 Rust 调 app.restart() 自动重启。
 *
 * onEvent 是前端回调，内部桥接为 Channel 传给 Rust（官方 calling-frontend 文档模式）。
 * 成功后 Rust 自身 app.restart()，本 Promise 不会 resolve（进程已退出）。
 */
export function downloadAndInstall(onEvent: DownloadEventHandler): Promise<void> {
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = onEvent;
  return tauriInvoke<void>('download_and_install', { onEvent: channel });
}
