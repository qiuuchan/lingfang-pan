// v4 制品发布进度的 UI 投影。实际传输由 lib/plugin-registry.ts 的 Tauri Channel 负责。
export interface UploadProgress {
  /** 已上传字节数。 */
  uploaded: number;
  /** 总字节数（Started 事件给出）。 */
  total: number;
  /** 当前速度（bytes/sec，基于最近一段时间的 chunk 间隔计算）。 */
  speed: number;
}
