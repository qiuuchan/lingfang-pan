import { Prisma } from '@prisma/client';
import { badRequest } from '../common';
import { highestSemVer, type ReleaseSourceKind } from './plugin-registry-model';

export type AdminPageQuery = {
  page?: number;
  pageSize?: number;
};

export type AdminPluginPackageQuery = AdminPageQuery & {
  search?: string;
  status?: 'ACTIVE' | 'ARCHIVED';
  reviewStatus?: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';
  sourceKind?: ReleaseSourceKind;
};

const ADMIN_LISTING_SUMMARY_SELECT = {
  status: true,
  priceCents: true,
  currentReleaseId: true,
  delistedBy: true,
  delistReason: true,
  delistedAt: true,
  delistedByUserId: true,
} as const satisfies Prisma.MarketplaceListingSelect;

const ADMIN_LISTING_DETAIL_SELECT = {
  ...ADMIN_LISTING_SUMMARY_SELECT,
} as const satisfies Prisma.MarketplaceListingSelect;

export const ADMIN_PACKAGE_LIST_SELECT = {
  id: true,
  manifestId: true,
  name: true,
  description: true,
  governanceStatus: true,
  createdAt: true,
  updatedAt: true,
  ownerTeam: { select: { id: true, name: true, slug: true } },
  listing: { select: ADMIN_LISTING_SUMMARY_SELECT },
} as const satisfies Prisma.PluginPackageSelect;

export const ADMIN_PACKAGE_DETAIL_SELECT = {
  id: true,
  ownerTeamId: true,
  authorUserId: true,
  manifestId: true,
  name: true,
  description: true,
  governanceStatus: true,
  createdAt: true,
  updatedAt: true,
  ownerTeam: { select: { id: true, name: true, slug: true } },
  listing: { select: ADMIN_LISTING_DETAIL_SELECT },
} as const satisfies Prisma.PluginPackageSelect;

export const ADMIN_RELEASE_SUMMARY_SELECT = {
  id: true,
  packageId: true,
  version: true,
  targetPlatform: true,
  sizeBytes: true,
  status: true,
  marketReviewStatus: true,
  sourceKind: true,
  sourceLabel: true,
  ingestChannel: true,
  aiPolicyVersion: true,
  aiPolicyStatus: true,
  aiPolicyReason: true,
  createdAt: true,
} as const satisfies Prisma.PluginReleaseSelect;

export const ADMIN_RELEASE_CORE_SELECT = {
  id: true,
  packageId: true,
  version: true,
  sha256: true,
  sizeBytes: true,
  targetPlatform: true,
  sourceKind: true,
  sourceLabel: true,
  ingestChannel: true,
  status: true,
  marketReviewStatus: true,
  reviewReason: true,
  aiPolicyVersion: true,
  aiPolicyStatus: true,
  aiPolicyReason: true,
  reviewedById: true,
  reviewedAt: true,
  createdAt: true,
  package: { select: { listing: { select: ADMIN_LISTING_DETAIL_SELECT } } },
} as const satisfies Prisma.PluginReleaseSelect;

export const ADMIN_RELEASE_MANIFEST_SELECT = {
  id: true,
  manifest: true,
} as const satisfies Prisma.PluginReleaseSelect;

export const ADMIN_RELEASE_FILES_SELECT = {
  id: true,
  fileManifest: true,
} as const satisfies Prisma.PluginReleaseSelect;

export const ADMIN_RELEASE_REVIEW_SELECT = {
  id: true,
  status: true,
  reason: true,
  createdAt: true,
  reviewer: { select: { id: true, displayName: true, email: true } },
} as const satisfies Prisma.PluginReleaseReviewSelect;

export type AdminPackageListRow = Prisma.PluginPackageGetPayload<{ select: typeof ADMIN_PACKAGE_LIST_SELECT }>;
export type AdminPackageDetailRow = Prisma.PluginPackageGetPayload<{ select: typeof ADMIN_PACKAGE_DETAIL_SELECT }>;
export type AdminReleaseSummaryRow = Prisma.PluginReleaseGetPayload<{ select: typeof ADMIN_RELEASE_SUMMARY_SELECT }>;
export type AdminReleaseCoreRow = Prisma.PluginReleaseGetPayload<{ select: typeof ADMIN_RELEASE_CORE_SELECT }>;
export type AdminReleaseReviewRow = Prisma.PluginReleaseReviewGetPayload<{ select: typeof ADMIN_RELEASE_REVIEW_SELECT }>;

export function normalizeAdminPage(query: AdminPageQuery) {
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 20)));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export function normalizeRequiredReason(reason: string, message: string): string {
  const normalized = String(reason || '').trim();
  if (!normalized || normalized.length > 500) throw badRequest(message);
  return normalized;
}

export function adminPackageWhere(query: AdminPluginPackageQuery): Prisma.PluginPackageWhereInput {
  const where: Prisma.PluginPackageWhereInput = {};
  const search = query.search?.trim();
  if (search) {
    where.OR = [
      { manifestId: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { ownerTeam: { is: { name: { contains: search, mode: 'insensitive' } } } },
      { ownerTeam: { is: { slug: { contains: search, mode: 'insensitive' } } } },
    ];
  }
  if (query.status) where.governanceStatus = query.status;
  if (query.reviewStatus || query.sourceKind) {
    where.releases = {
      some: {
        ...(query.reviewStatus ? { marketReviewStatus: query.reviewStatus } : {}),
        ...(query.sourceKind ? { sourceKind: query.sourceKind } : {}),
      },
    };
  }
  return where;
}

function iso(value: Date | string | null | undefined): string | null {
  if (typeof value === 'string') return value;
  return value?.toISOString() ?? null;
}

export function adminListingProjection(listing: {
  status: string;
  priceCents: number;
  currentReleaseId: string | null;
  delistedBy?: string | null;
  delistReason?: string;
  delistedAt?: Date | string | null;
  delistedByUserId?: string | null;
} | null | undefined) {
  if (!listing) return null;
  const delistMetadata = {
    delistedBy: listing.delistedBy === 'OWNER' || listing.delistedBy === 'PLATFORM' ? listing.delistedBy : null,
    delistReason: listing.delistReason || '',
    delistedAt: iso(listing.delistedAt ?? null),
    delistedByUserId: listing.delistedByUserId ?? null,
  };
  if (listing.status === 'ACTIVE' && listing.currentReleaseId) {
    return {
      status: 'ACTIVE' as const,
      priceCents: listing.priceCents,
      currentReleaseId: listing.currentReleaseId,
      ...delistMetadata,
    };
  }
  return {
    status: listing.status === 'DELISTED' ? 'DELISTED' as const : 'DRAFT' as const,
    priceCents: listing.priceCents,
    currentReleaseId: listing.status === 'DELISTED' ? listing.currentReleaseId : null,
    ...delistMetadata,
  };
}

function latestReleaseSummary(release: AdminReleaseSummaryRow | null) {
  if (!release) return null;
  return {
    id: release.id,
    version: release.version,
    status: release.status,
    marketReviewStatus: release.marketReviewStatus,
    sourceKind: release.sourceKind,
    sourceLabel: release.sourceLabel,
    ingestChannel: release.ingestChannel,
    aiPolicyVersion: release.aiPolicyVersion,
    aiPolicyStatus: release.aiPolicyStatus,
    aiPolicyReason: release.aiPolicyReason,
    createdAt: release.createdAt.toISOString(),
  };
}

export function adminPackageListItem(pkg: AdminPackageListRow, releases: AdminReleaseSummaryRow[]) {
  return {
    id: pkg.id,
    manifestId: pkg.manifestId,
    name: pkg.name,
    description: pkg.description,
    governanceStatus: pkg.governanceStatus,
    ownerTeam: pkg.ownerTeam,
    listing: adminListingProjection(pkg.listing),
    latestRelease: latestReleaseSummary(highestSemVer(releases)),
    marketplaceCurrentVersion: releases.find((release) => release.id === pkg.listing?.currentReleaseId)?.version ?? null,
    releaseCount: releases.length,
    pendingReviewCount: releases.filter((release) => release.marketReviewStatus === 'PENDING').length,
    createdAt: pkg.createdAt.toISOString(),
    updatedAt: pkg.updatedAt.toISOString(),
  };
}

export function groupAdminReleases(releases: AdminReleaseSummaryRow[]) {
  const grouped = new Map<string, AdminReleaseSummaryRow[]>();
  for (const release of releases) {
    const packageReleases = grouped.get(release.packageId);
    if (packageReleases) packageReleases.push(release);
    else grouped.set(release.packageId, [release]);
  }
  return grouped;
}

export function adminPackageDetail(pkg: AdminPackageDetailRow, releaseCount: number, pendingReviewCount: number) {
  return {
    package: {
      id: pkg.id,
      ownerTeamId: pkg.ownerTeamId,
      authorUserId: pkg.authorUserId,
      manifestId: pkg.manifestId,
      name: pkg.name,
      description: pkg.description,
      governanceStatus: pkg.governanceStatus,
      createdAt: pkg.createdAt.toISOString(),
      updatedAt: pkg.updatedAt.toISOString(),
    },
    ownerTeam: pkg.ownerTeam,
    listing: adminListingProjection(pkg.listing),
    releaseCount,
    pendingReviewCount,
  };
}

export function adminReleaseSummary(
  release: AdminReleaseSummaryRow,
  listing: { status: string; currentReleaseId: string | null } | null,
) {
  return {
    id: release.id,
    version: release.version,
    targetPlatform: release.targetPlatform,
    sizeBytes: release.sizeBytes,
    status: release.status,
    marketReviewStatus: release.marketReviewStatus,
    sourceKind: release.sourceKind,
    sourceLabel: release.sourceLabel,
    ingestChannel: release.ingestChannel,
    aiPolicyVersion: release.aiPolicyVersion,
    aiPolicyStatus: release.aiPolicyStatus,
    aiPolicyReason: release.aiPolicyReason,
    isMarketplaceCurrent: listing?.status === 'ACTIVE' && listing.currentReleaseId === release.id,
    createdAt: release.createdAt.toISOString(),
  };
}

export function adminReleaseCore(release: AdminReleaseCoreRow) {
  const listing = release.package.listing;
  return {
    release: {
      id: release.id,
      packageId: release.packageId,
      version: release.version,
      sha256: release.sha256,
      sizeBytes: release.sizeBytes,
      targetPlatform: release.targetPlatform,
      sourceKind: release.sourceKind,
      sourceLabel: release.sourceLabel,
      ingestChannel: release.ingestChannel,
      status: release.status,
      marketReviewStatus: release.marketReviewStatus,
      reviewReason: release.reviewReason,
      aiPolicyVersion: release.aiPolicyVersion,
      aiPolicyStatus: release.aiPolicyStatus,
      aiPolicyReason: release.aiPolicyReason,
      reviewedById: release.reviewedById,
      reviewedAt: iso(release.reviewedAt),
      createdAt: release.createdAt.toISOString(),
    },
    listing: adminListingProjection(listing),
    isMarketplaceCurrent: listing?.status === 'ACTIVE' && listing.currentReleaseId === release.id,
  };
}

export type AdminPluginFile = { path: string; sizeBytes: number };

export function normalizeFileManifest(value: unknown): AdminPluginFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const path = Reflect.get(item, 'path');
    const sizeBytes = Reflect.get(item, 'sizeBytes');
    if (typeof path !== 'string' || !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0) return [];
    return [{ path, sizeBytes: Number(sizeBytes) }];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function adminReleaseReview(review: AdminReleaseReviewRow) {
  return {
    id: review.id,
    status: review.status,
    reason: review.reason,
    reviewer: review.reviewer,
    createdAt: review.createdAt.toISOString(),
  };
}
