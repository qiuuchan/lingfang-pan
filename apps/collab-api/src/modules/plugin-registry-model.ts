import { TextDecoder } from 'node:util';
import { badRequest } from '../common';
import { compareStrictSemVer } from './plugin-semver';

export const RELEASE_SOURCE_KINDS = [
  'LINGFANG_CREATOR',
  'EXTERNAL_TOOL',
  'LOCAL_ARTIFACT',
  'COPIED_INSTALLATION',
  'API',
  'LEGACY_MIGRATION',
  'UNKNOWN',
] as const;

export const PLUGIN_INGEST_CHANNELS = ['DESKTOP', 'API', 'MIGRATION'] as const;

export type ReleaseSourceKind = (typeof RELEASE_SOURCE_KINDS)[number];
export type PluginIngestChannel = (typeof PLUGIN_INGEST_CHANNELS)[number];

export type ReleaseSourceHeaders = {
  sourceKind?: string;
  sourceLabelBase64?: string;
  ingestChannel?: string;
};

export type NormalizedReleaseSource = {
  sourceKind: ReleaseSourceKind;
  sourceLabel: string;
  ingestChannel: PluginIngestChannel;
};

function enumValue<T extends readonly string[]>(
  raw: string | undefined,
  values: T,
  fallback: T[number],
  field: string
): T[number] {
  const value = String(raw || fallback)
    .trim()
    .toUpperCase();
  if (!(values as readonly string[]).includes(value)) throw badRequest(`${field} 无效`);
  return value as T[number];
}

function decodeSourceLabel(raw: string | undefined): string {
  if (!raw) return '';
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw badRequest('插件来源标签编码无效');
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) throw badRequest('插件来源标签编码无效');
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw badRequest('插件来源标签编码无效');
  }
  const label = decoded.trim();
  if (/[\u0000-\u001f\u007f]/.test(label)) {
    throw badRequest('插件来源标签包含非法字符');
  }
  if ([...label].length > 80) throw badRequest('插件来源标签不能超过 80 个字符');
  return label;
}

export function normalizeReleaseSource(
  headers: ReleaseSourceHeaders = {}
): NormalizedReleaseSource {
  return {
    sourceKind: enumValue(headers.sourceKind, RELEASE_SOURCE_KINDS, 'UNKNOWN', '插件来源类型'),
    sourceLabel: decodeSourceLabel(headers.sourceLabelBase64),
    ingestChannel: enumValue(headers.ingestChannel, PLUGIN_INGEST_CHANNELS, 'API', '插件接入通道'),
  };
}

type ReleaseJsonInput = {
  id: string;
  packageId: string;
  version: string;
  manifest: unknown;
  readmeMarkdown?: string;
  packagePolicySurfaceSha256?: string;
  sha256: string;
  sizeBytes: number;
  status: string;
  marketReviewStatus: string;
  targetPlatform: string;
  sourceKind?: string;
  sourceLabel?: string;
  ingestChannel?: string;
  reviewReason?: string;
  aiPolicyVersion?: number;
  aiPolicyStatus?: string;
  aiPolicyReason?: string;
  createdAt: Date;
};

/** Lightweight release projection used by catalogs and mutation responses. */
export function releaseJson(release: ReleaseJsonInput) {
  return {
    id: release.id,
    packageId: release.packageId,
    version: release.version,
    manifest: release.manifest,
    package_policy_surface_sha256: release.packagePolicySurfaceSha256 || '0'.repeat(64),
    sha256: release.sha256,
    sizeBytes: release.sizeBytes,
    status: release.status,
    marketReviewStatus: release.marketReviewStatus,
    targetPlatform: release.targetPlatform,
    sourceKind: release.sourceKind || 'UNKNOWN',
    sourceLabel: release.sourceLabel || '',
    ingestChannel: release.ingestChannel || 'API',
    ...(release.reviewReason === undefined ? {} : { reviewReason: release.reviewReason }),
    aiPolicyVersion: release.aiPolicyVersion ?? 0,
    aiPolicyStatus: release.aiPolicyStatus || 'UNCHECKED',
    aiPolicyReason: release.aiPolicyReason || '',
    createdAt: release.createdAt.toISOString(),
  };
}

/** README content is exposed only by the exact immutable release detail route. */
export function releaseDetailJson(release: ReleaseJsonInput) {
  return {
    ...releaseJson(release),
    readme_markdown: release.readmeMarkdown || '',
  };
}

export function releaseListJson(release: ReleaseJsonInput) {
  return releaseJson(release);
}

export function packageJson(pkg: {
  id: string;
  ownerTeamId: string;
  authorUserId: string | null;
  manifestId: string;
  name: string;
  description: string;
  governanceStatus: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: pkg.id,
    ownerTeamId: pkg.ownerTeamId,
    authorUserId: pkg.authorUserId,
    manifestId: pkg.manifestId,
    name: pkg.name,
    description: pkg.description,
    governanceStatus: pkg.governanceStatus,
    createdAt: pkg.createdAt.toISOString(),
    updatedAt: pkg.updatedAt.toISOString(),
  };
}

export function listingJson(
  listing:
    | {
        priceCents: number;
        status: string;
        currentReleaseId: string | null;
        delistedBy?: string | null;
        delistReason?: string;
        delistedAt?: Date | null;
        delistedByUserId?: string | null;
      }
    | null
    | undefined
) {
  if (!listing) return null;
  return {
    priceCents: listing.priceCents,
    status: listing.status,
    currentReleaseId: listing.currentReleaseId,
    delistedBy: listing.delistedBy ?? null,
    delistReason: listing.delistReason || '',
    delistedAt: listing.delistedAt?.toISOString() ?? null,
    delistedByUserId: listing.delistedByUserId ?? null,
  };
}

export function highestSemVer<T extends { version: string }>(releases: T[]): T | null {
  return releases.reduce<T | null>(
    (current, release) =>
      !current || compareStrictSemVer(release.version, current.version) > 0 ? release : current,
    null
  );
}
