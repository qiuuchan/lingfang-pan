// changelog.ts — 更新日志 API 封装（桌面端复用 collab-api 的 /api/changelog 公开端点）。
//
// 与 collab-admin/src/lib/releases.ts 的 listChangelog 同构（同 DTO 契约），但走桌面端
// 的 api()（带 X-Client:desktop header + apiBase 解析）。供 ChangelogDialog 悬浮窗拉取版本时间线。
//
// 数据源：后端 GiteeChangelogService 从 Gitee 私有仓库 release 拉取并标准化（详见
// [[gitee-changelog-integration]] 记忆），@Public 端点无需鉴权。

import { api } from '@/lib/api';

/** 更新日志单条（与后端 ChangelogEntry 对齐，Gitee release 标准化后的展示契约）。 */
export interface ChangelogEntry {
  /** Gitee release id 转 string，无 id 时用 tag 兜底。 */
  id: string;
  /** tag_name 剥离前导 v/V。 */
  version: string;
  /** name（Gitee 允许空），空时 fallback tag。 */
  title: string;
  /** body 原文（markdown），前端 react-markdown 渲染。 */
  notes: string;
  /** created_at ISO（Gitee 无 published_at，用 created_at）。 */
  publishedAt: string | null;
  /** 派生：按 created_at desc 排序后首条 true（点亮 latest 徽标）。 */
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
  /** degraded=true 时给前端展示的简短说明。 */
  message?: string;
}

/**
 * 获取更新日志（公开端点，无鉴权）。
 * 后端未配置 Gitee 源 / API 不可用时返回 source=unconfigured / degraded，前端友好降级。
 */
export async function listChangelog(): Promise<ChangelogResponse> {
  try {
    return await api<ChangelogResponse>('/api/changelog', { auth: false });
  } catch {
    // 网络层兜底（api() 抛连接错误时降级为空列表 + 友好提示，不阻断 UI）。
    return {
      source: 'unconfigured',
      releases: [],
      degraded: true,
      message: '无法连接服务器，请检查网络或后端地址',
    };
  }
}

/** 格式化 ISO 时间为本地可读日期（YYYY-MM-DD），失败返回空串。 */
export function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return '';
  }
}
