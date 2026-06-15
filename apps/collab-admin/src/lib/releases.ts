// 应用版本发布 API 客户端（落地页 Download / Changelog 用）。
// 与原 apps/website/src/lib/releases.ts 等价，迁移自官网合并入管理端。
// 复用 @/lib/api 的 apiBase()（同源 collab-api），无鉴权公开端点用 auth:false 的 fetch。
import { apiBase } from '@/lib/api';

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
