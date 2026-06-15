// 更新日志（Gitee release 标准化）出参契约。
//
// 设计契约（详见子任务 design.md）：
//  - 刻意与 release.service 的 Release 出参不同构：Gitee release 无 assets（browser_download_url 非 Tauri
//    签名产物，不能塞进 ReleaseAsset）、无 channel（Gitee 无通道概念）、无 updateAvailable（changelog 不做
//    版本比较）。独立 DTO 保证语义正确，避免前端 Release 类型的 assets 永远空数组变成「谎言」。
//  - 仅出参，无 class-validator 装饰器：GET /api/changelog 是公开端点，无 body/query 入参（channel 不适用）。
//  - 字段 camelCase（与所有出参一致），publishedAt 用 created_at（Gitee 无 published_at）。

/** GET /api/changelog 单条更新日志（Gitee release 标准化后的展示契约）。 */
export interface ChangelogEntry {
  /** Gitee release 数字 id 转 string（防 JS 大数溢出），无 id 时用 tag_name 兜底保唯一性。 */
  id: string;
  /** tag_name 剥离前导 v/V（v1.0.0 → 1.0.0），与 Release.version 风格一致。 */
  version: string;
  /** name（Gitee 允许空），空时 fallback 到 tag_name。 */
  title: string;
  /** body 原文（markdown），前端 ChangelogPage.renderNotes 解析渲染。 */
  notes: string;
  /** created_at ISO（Gitee 无 published_at，用 created_at 排序展示）。 */
  publishedAt: string | null;
  /** 派生：按 created_at desc 排序后首条为 true（Gitee 无 isLatest 概念，前端据此点亮 latest 徽标）。 */
  isLatest: boolean;
}

/** GET /api/changelog 响应包装。source/degraded/message 让前端区分数据来源与健康度。 */
export interface ChangelogResponse {
  /** 数据来源：gitee=已配置并成功/降级；unconfigured=token 未配。 */
  source: 'gitee' | 'unconfigured';
  /** 标准化后的更新日志列表（失败降级时可能是上次缓存或空数组）。 */
  releases: ChangelogEntry[];
  /** true=本次降级（失败/限流/吐缓存兜底），前端据此显示降级横幅。 */
  degraded: boolean;
  /** degraded=true 时给前端展示的简短说明（失败原因 / 缓存提示）。 */
  message?: string;
}
