// 应用版本发布 API 客户端（落地页 Download / Changelog 用）。
// 与原 apps/website/src/lib/releases.ts 等价，迁移自官网合并入管理端。
// 复用 @/lib/api 的 apiBase()（同源 collab-api），无鉴权公开端点用 auth:false 的 fetch。
import { api, apiBase } from '@/lib/api';

/** 产物（与 collab-api ReleaseAsset 出参对齐）。 */
export interface ReleaseAsset {
  id: string;
  platform: 'WINDOWS' | 'DARWIN' | 'LINUX';
  arch: 'X86_64' | 'AARCH64' | 'UNIVERSAL';
  url: string;
  filename: string;
  signature: string;
  sizeBytes: number | null;
}

/** 版本（与 collab-api publicRelease 出参对齐）。 */
export interface Release {
  id: string;
  version: string;
  channel: 'STABLE' | 'BETA';
  title: string;
  notes: string;
  isLatest: boolean;
  publishedAt: string | null;
  assets: ReleaseAsset[];
  updateAvailable?: boolean;
}

const TIMEOUT_MS = 5000;

/** 带超时的无鉴权 fetch（落地页未登录可见，不携带 token）。 */
async function fetchPublic(path: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${apiBase()}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 获取最新版本（含产物）。API 不可用或无版本时返回 null（落地页降级展示占位）。
 *  可选 currentVersion：透传给后端 /api/releases/latest?currentVersion=，后端返回 updateAvailable
 *  （semver 比较，宽松解析主.次.修 + prerelease），避免调用方自行实现版本比较导致格式不一致误判。 */
export async function getLatestRelease(
  channel: 'STABLE' | 'BETA' = 'STABLE',
  currentVersion?: string,
): Promise<Release | null> {
  try {
    const cv = currentVersion ? `&currentVersion=${encodeURIComponent(currentVersion)}` : '';
    const resp = await fetchPublic(`/api/releases/latest?channel=${channel}${cv}`);
    if (!resp.ok) return null;
    return (await resp.json()) as Release;
  } catch {
    return null;
  }
}

/** 获取已发布版本列表（changelog 时间线）。API 不可用时返回空数组。 */
export async function listReleases(channel: 'STABLE' | 'BETA' = 'STABLE', limit = 10): Promise<Release[]> {
  try {
    const resp = await fetchPublic(`/api/releases?channel=${channel}&limit=${limit}`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { releases: Release[] };
    return data.releases ?? [];
  } catch {
    return [];
  }
}

/** 人类可读的文件大小（KB/MB）。 */
export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 格式化发布日期（2026-06-14）。 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 平台展示信息。 */
export const PLATFORM_META = {
  WINDOWS: { label: 'Windows', arch: 'x64', ext: '.exe / .msi' },
  DARWIN: { label: 'macOS', arch: 'Apple Silicon / Intel', ext: '.dmg' },
  LINUX: { label: 'Linux', arch: 'x64 / arm64', ext: '.AppImage / .deb' },
} as const;

// === Gitee 更新日志（与 collab-api /api/changelog 契约对齐） ===
// 刻意与上方 Release 不同构：Gitee release 无 assets（非 Tauri 签名产物）、无 channel、无 updateAvailable。
// ChangelogPage 只读 id/version/title/notes/publishedAt/isLatest 六字段，独立 DTO 保证语义正确。

/** 更新日志单条（Gitee release 标准化后的展示契约，与后端 ChangelogEntry 对齐）。 */
export interface ChangelogEntry {
  /** Gitee release id 转 string，无 id 时用 tag 兜底。 */
  id: string;
  /** tag_name 剥离前导 v/V。 */
  version: string;
  /** name（Gitee 允许空），空时 fallback tag。 */
  title: string;
  /** body 原文（markdown），前端 renderNotes 解析渲染。 */
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

/** 获取 Gitee 更新日志（公开端点，无鉴权）。API 不可用或未配置时返回 source=unconfigured / degraded。
 *  与 getLatestRelease/listReleases 数据源不同（后两者读本地 DB release，供下载页与 Tauri updater）。 */
export async function listChangelog(): Promise<ChangelogResponse> {
  try {
    const resp = await fetchPublic('/api/changelog');
    if (!resp.ok) {
      return { source: 'unconfigured', releases: [], degraded: true, message: '更新日志暂时不可用' };
    }
    return (await resp.json()) as ChangelogResponse;
  } catch {
    return { source: 'unconfigured', releases: [], degraded: true, message: '无法连接服务器，检查网络后重试' };
  }
}

// === Admin 版本发布管理（写操作，需 PLATFORM_ADMIN token） ===

/** Admin 视角版本（比公开 Release 多 status：DRAFT/PUBLISHED/ARCHIVED）。 */
export interface AdminRelease extends Release {
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
}

/** 创建版本入参（POST /api/admin/releases）。 */
export interface ReleaseCreateInput {
  version: string;
  channel?: 'STABLE' | 'BETA';
  title?: string;
  notes?: string;
}

/** 登记外链产物入参（POST /api/admin/releases/:id/assets）。 */
export interface AssetCreateInput {
  platform: 'WINDOWS' | 'DARWIN' | 'LINUX';
  arch: 'X86_64' | 'AARCH64' | 'UNIVERSAL';
  url: string;
  filename?: string;
  signature?: string;
  sizeBytes?: number;
}

/** GET /api/admin/releases：版本列表（含 DRAFT/ARCHIVED）。channel 可选过滤。 */
export async function listAdminReleases(channel?: 'STABLE' | 'BETA'): Promise<AdminRelease[]> {
  const q = channel ? `?channel=${channel}` : '';
  const data = await api<{ releases: AdminRelease[] }>(`/api/admin/releases${q}`);
  return data.releases ?? [];
}

/** POST /api/admin/releases：创建 DRAFT 版本。 */
export function createRelease(input: ReleaseCreateInput) {
  return api<{ release: AdminRelease }>('/api/admin/releases', { method: 'POST', body: input });
}

/** PATCH /api/admin/releases/:id：改 title/notes。 */
export function updateRelease(id: string, body: { title?: string; notes?: string }) {
  return api<{ release: AdminRelease }>(`/api/admin/releases/${id}`, { method: 'PATCH', body });
}

/** POST /api/admin/releases/:id/publish：发布。 */
export function publishRelease(id: string) {
  return api<{ release: AdminRelease }>(`/api/admin/releases/${id}/publish`, { method: 'POST' });
}

/** POST /api/admin/releases/:id/archive：归档。 */
export function archiveRelease(id: string) {
  return api<{ release: AdminRelease }>(`/api/admin/releases/${id}/archive`, { method: 'POST' });
}

/** POST /api/admin/releases/:id/assets：登记外链产物。 */
export function addAsset(id: string, input: AssetCreateInput) {
  return api<{ asset: ReleaseAsset }>(`/api/admin/releases/${id}/assets`, { method: 'POST', body: input });
}

/** POST /api/admin/releases/:id/assets/upload：上传安装包文件（multipart）+ 可选 .sig 签名。
 *  上传大文件需较长超时（120s），与默认 30s 区分。返回建好的 asset（含 /downloads/ 下载链接 + signature）。 */
export async function uploadAsset(
  id: string,
  file: File,
  platform: 'WINDOWS' | 'DARWIN' | 'LINUX',
  arch: 'X86_64' | 'AARCH64' | 'UNIVERSAL',
  sigFile?: File,
): Promise<ReleaseAsset> {
  const form = new FormData();
  form.append('file', file);
  if (sigFile) form.append('signature', sigFile);
  form.append('platform', platform);
  form.append('arch', arch);
  const data = await api<{ asset: ReleaseAsset }>(`/api/admin/releases/${id}/assets/upload`, {
    method: 'POST',
    formData: form,
    timeoutMs: 120_000,
  });
  return data.asset;
}

/** DELETE /api/admin/releases/:id/assets/:assetId：删除产物。 */
export function deleteAsset(id: string, assetId: string) {
  return api(`/api/admin/releases/${id}/assets/${assetId}`, { method: 'DELETE' });
}

/** 拼接下载直链：asset.url 是相对路径（/downloads/xxx），前端展示/复制时拼后端基址。 */
export function absoluteDownloadUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${apiBase()}${url}`;
}

/** 触发下载（带 token？downloads 是公开静态目录，无需 token，直接打开）。 */
export function openDownload(url: string) {
  window.open(absoluteDownloadUrl(url), '_blank');
}

