import { api } from '@/lib/api';
import type {
  ApplicationStatus,
  Page,
  PendingReleaseItem,
  PluginFileSummary,
  PluginGovernanceStatus,
  PluginManifestDetail,
  PluginPackageDetail,
  PluginPackageSummary,
  PluginReleaseCore,
  PluginReleaseSummary,
  PluginReviewStatus,
  PluginReviewSummary,
  PluginSourceKind,
  TeamAdminApplicationDetail,
  TeamAdminApplicationSummary,
} from '@/components/governance/types';

type PageQuery = { page: number; pageSize: number };

export function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function segment(value: string): string {
  return encodeURIComponent(value);
}

export function loadPluginPackages(
  query: PageQuery & {
    search?: string;
    status?: PluginGovernanceStatus;
    reviewStatus?: PluginReviewStatus;
    sourceKind?: PluginSourceKind;
  },
  signal: AbortSignal
) {
  return api<Page<PluginPackageSummary>>(`/api/admin/plugin-packages${queryString(query)}`, {
    signal,
  });
}

/** v4 待审核发行版队列：消费 GET /api/admin/plugin-releases/review-pending。 */
export function loadPendingReleases(signal: AbortSignal): Promise<{ items: PendingReleaseItem[] }> {
  return api(`/api/admin/plugin-releases/review-pending`, { signal });
}

export function loadPluginPackage(packageId: string, signal: AbortSignal) {
  return api<PluginPackageDetail>(`/api/admin/plugin-packages/${segment(packageId)}`, { signal });
}

export function loadPluginReleases(packageId: string, query: PageQuery, signal: AbortSignal) {
  return api<Page<PluginReleaseSummary>>(
    `/api/admin/plugin-packages/${segment(packageId)}/releases${queryString(query)}`,
    { signal }
  );
}

export function loadPluginRelease(releaseId: string, signal: AbortSignal) {
  return api<PluginReleaseCore>(`/api/admin/plugin-releases/${segment(releaseId)}`, { signal });
}

export function loadPluginManifest(releaseId: string, signal: AbortSignal) {
  return api<PluginManifestDetail>(`/api/admin/plugin-releases/${segment(releaseId)}/manifest`, {
    signal,
  });
}

export function loadPluginFiles(releaseId: string, query: PageQuery, signal: AbortSignal) {
  return api<Page<PluginFileSummary>>(
    `/api/admin/plugin-releases/${segment(releaseId)}/files${queryString(query)}`,
    { signal }
  );
}

export function loadPluginReviews(releaseId: string, query: PageQuery, signal: AbortSignal) {
  return api<Page<PluginReviewSummary>>(
    `/api/admin/plugin-releases/${segment(releaseId)}/reviews${queryString(query)}`,
    { signal }
  );
}

export function approvePluginRelease(releaseId: string) {
  return api(`/api/admin/plugin-releases/${segment(releaseId)}/approve`, { method: 'POST' });
}

export function rejectPluginRelease(releaseId: string, reason: string) {
  return api(`/api/admin/plugin-releases/${segment(releaseId)}/reject`, {
    method: 'POST',
    body: { reason },
  });
}

export function delistPluginRelease(releaseId: string, reason: string) {
  return api(`/api/admin/plugin-releases/${segment(releaseId)}/delist`, {
    method: 'POST',
    body: { reason },
  });
}

export function relistPluginPackage(packageId: string, reason: string) {
  return api(`/api/admin/plugin-packages/${segment(packageId)}/relist`, {
    method: 'POST',
    body: { reason },
  });
}

export function loadApplications(
  query: PageQuery & { q?: string; status?: ApplicationStatus },
  signal: AbortSignal
) {
  return api<Page<TeamAdminApplicationSummary>>(
    `/api/admin/team-admin-applications${queryString(query)}`,
    { signal }
  );
}

export function loadApplication(applicationId: string, signal: AbortSignal) {
  return api<{ application: TeamAdminApplicationDetail }>(
    `/api/admin/team-admin-applications/${segment(applicationId)}`,
    { signal }
  );
}

export function approveApplication(applicationId: string) {
  return api(`/api/admin/team-admin-applications/${segment(applicationId)}/approve`, {
    method: 'POST',
  });
}

export function rejectApplication(applicationId: string, reason: string) {
  return api(`/api/admin/team-admin-applications/${segment(applicationId)}/reject`, {
    method: 'POST',
    body: { reason },
  });
}
