// plugin-upload.ts — 插件上传（带进度推送）的前端封装。
//
// 与 lib/updater.ts 的 downloadUpdate 对称：用 Tauri 2 Channel 接收 Rust upload_plugin
// 命令推送的进度事件（Started/Progress/Finished），提供真实字节级上传进度。
//
// 为什么不走 fetch：fetch 无法获取上传进度（只有下载侧能 stream）。Rust 侧用 reqwest
// 的 wrap_stream 把 payload 切成 chunk 流式发送，每 chunk emit Progress 事件。
//
// 契约对齐（Rust upload.rs）：
// - UploadEvent serde tag="event"（PascalCase：Started/Progress/Finished），content="data"
//   （字段 camelCase：totalBytes/chunkLength/response）。
// - upload_plugin 入参：{ apiBase, authToken, payload, onEvent: Channel<UploadEvent> }。
// - 返回值：后端 JSON 响应体（{ plugin: { id }, upgraded?, deduplicated? }）。

import { Channel } from '@tauri-apps/api/core';
import { tauriInvoke, apiBase, getAuthToken } from '@/lib/api';

/** 上传进度事件（对应 Rust UploadEvent，discriminated union）。 */
export type UploadEvent =
  | { event: 'Started'; data: { totalBytes: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished'; data: { response: UploadResponse } };

/** 后端 /api/plugins/upload 的响应体。 */
export interface UploadResponse {
  plugin: { id: string };
  upgraded?: boolean;
  deduplicated?: boolean;
}

/** 上传进度信息（由 onProgress 回调接收，供 UI 渲染进度条）。 */
export interface UploadProgress {
  /** 已上传字节数。 */
  uploaded: number;
  /** 总字节数（Started 事件给出）。 */
  total: number;
  /** 当前速度（bytes/sec，基于最近一段时间的 chunk 间隔计算）。 */
  speed: number;
}

/** 上传 payload（与后端 PluginPackageDto 对齐，Rust UploadPayload 反序列化）。 */
export interface UploadPayload {
  manifest: unknown;
  files: { path: string; content: string }[];
  priceCents: number;
}

/**
 * 上传插件到后端（带进度推送）。
 *
 * 调 Rust upload_plugin 命令，通过 Channel 接收 Started/Progress/Finished 事件：
 * - Started：设 total，回调 uploaded=0。
 * - Progress：累加 uploaded，计算 speed（基于时间差），回调最新进度。
 * - Finished：resolve Promise，返回后端响应。
 *
 * @param payload 完整的上传 payload（manifest + files + priceCents）。
 * @param onProgress 进度回调（每次 chunk 触发）。
 * @returns 后端响应（{ plugin: { id }, upgraded?, deduplicated? }）。
 * @throws 网络/HTTP 错误（含后端返回的 error message）。
 */
export async function uploadPlugin(
  payload: UploadPayload,
  onProgress: (info: UploadProgress) => void,
): Promise<UploadResponse> {
  const base = apiBase();
  if (!base) throw new Error('尚未配置后端服务地址，请先填写后端 URL。');
  const token = getAuthToken() ?? '';

  const channel = new Channel<UploadEvent>();
  let uploaded = 0;
  let total = 0;
  // 速度计算：记录最近 500ms 内的 chunk 时间戳和字节数，算平均速度。
  let lastTime = 0;
  let lastUploaded = 0;

  channel.onmessage = (event: UploadEvent) => {
    if (event.event === 'Started') {
      total = event.data.totalBytes;
      uploaded = 0;
      lastTime = Date.now();
      lastUploaded = 0;
      onProgress({ uploaded: 0, total, speed: 0 });
    } else if (event.event === 'Progress') {
      uploaded += event.data.chunkLength;
      const now = Date.now();
      const elapsed = now - lastTime;
      // 每 300ms 更新一次速度（避免每个小 chunk 都算，抖动太大）。
      if (elapsed >= 300) {
        const deltaBytes = uploaded - lastUploaded;
        const speed = deltaBytes / (elapsed / 1000);
        onProgress({ uploaded, total, speed });
        lastTime = now;
        lastUploaded = uploaded;
      } else {
        // 不更新速度，只更新 uploaded（UI 仍能看到进度条走动）。
        onProgress({ uploaded, total, speed: 0 });
      }
    }
    // Finished 事件由 tauriInvoke 的返回值处理（response 直接 return）。
  };

  return tauriInvoke<UploadResponse>('upload_plugin', {
    apiBase: base,
    authToken: token,
    payload,
    onEvent: channel,
  });
}
