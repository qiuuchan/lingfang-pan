import { TextDecoder } from 'node:util';
import { PLUGIN_ADAPTATION_REPORT_MAX_BYTES } from '@lingfang/contract';
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

export const PLUGIN_INGEST_CHANNELS = ['DESKTOP', 'API', 'MIGRATION', 'ADAPT'] as const;

export type ReleaseSourceKind = (typeof RELEASE_SOURCE_KINDS)[number];
export type PluginIngestChannel = (typeof PLUGIN_INGEST_CHANNELS)[number];

export type ReleaseSourceHeaders = {
  sourceKind?: string;
  sourceLabelBase64?: string;
  ingestChannel?: string;
  /**
   * 适配报告暂存位 id（纯 ASCII uuid）。报告本身走 POST /plugin-registry/adaptation-reports
   * 暂存——HTTP 头是 ASCII-only 且长度受限，装不下含中文、可达数百 KiB 的 AdaptationReport。
   */
  adaptationReportId?: string;
};

export const ADAPTATION_STATUSES = [
  'NOT_RUN',
  'ADAPTED_PASSED',
  'ADAPTED_FAILED',
  'NEEDS_HUMAN',
] as const;

export type AdaptationStatus = (typeof ADAPTATION_STATUSES)[number];

export type NormalizedReleaseSource = {
  sourceKind: ReleaseSourceKind;
  sourceLabel: string;
  ingestChannel: PluginIngestChannel;
  /** 客户端附带的适配报告原始 JSON（已校验可解析），无则 null。 */
  adaptationReport: string | null;
  /** 从报告解析出的适配状态，缺省 NOT_RUN。 */
  adaptationStatus: AdaptationStatus;
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

/**
 * 兑付暂存位后拿到的适配报告。发布路径先在 service 里按 id + 归属做一次性兑付，
 * 再把结果交给这个纯函数派生通道——模型层保持无 IO，便于单测。
 */
export const NO_ADAPTATION: RedeemedAdaptation = { report: null, status: 'NOT_RUN' };

export type RedeemedAdaptation = {
  report: string | null;
  status: AdaptationStatus;
};

export function normalizeReleaseSource(
  headers: ReleaseSourceHeaders = {},
  adaptation: RedeemedAdaptation = NO_ADAPTATION
): NormalizedReleaseSource {
  const declaredChannel = enumValue(
    headers.ingestChannel,
    PLUGIN_INGEST_CHANNELS,
    'API',
    '插件接入通道'
  );
  // 适配通道标记只能来自「兑付到报告」的证据，客户端不能自报 ADAPT：
  // 否则任何人 headers 里写 adapt 就能把发行版打入适配来源（审核/计费都按它归类）。
  let ingestChannel: PluginIngestChannel;
  if (adaptation.status !== 'NOT_RUN') {
    ingestChannel = 'ADAPT';
  } else if (declaredChannel === 'ADAPT') {
    throw badRequest('客户端不能自报 ADAPT 接入通道：请先暂存适配报告再携带 x-adaptation-report-id');
  } else {
    ingestChannel = declaredChannel;
  }
  return {
    sourceKind: enumValue(headers.sourceKind, RELEASE_SOURCE_KINDS, 'UNKNOWN', '插件来源类型'),
    sourceLabel: decodeSourceLabel(headers.sourceLabelBase64),
    ingestChannel,
    adaptationReport: adaptation.report,
    adaptationStatus: adaptation.status,
  };
}

/** 适配干跑的请求体来自不可信客户端，且策略扫描是同步 CPU 密集操作，必须在入口设上限。 */
export function assertDryRunPayloadSize(files: { content?: string }[]): void {
  if (files.length > PLUGIN_DRY_RUN_MAX_FILES) {
    throw badRequest(`适配干跑最多支持 ${PLUGIN_DRY_RUN_MAX_FILES} 个文件`);
  }
  let total = 0;
  for (const file of files) {
    total += file.content ? Buffer.byteLength(file.content, 'utf8') : 0;
    if (total > PLUGIN_DRY_RUN_MAX_TOTAL_BYTES) {
      throw badRequest('适配干跑的源码总量超过 8 MiB，请改用桌面端完整适配流水线');
    }
  }
}

export const PLUGIN_DRY_RUN_MAX_FILES = 2000;
export const PLUGIN_DRY_RUN_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * 归一化暂存进来的适配报告。报告完全由客户端提供，服务端不执行插件，只做「留证 + 复核」，
 * 因此 status 必须落在白名单内，否则一律降级为 NOT_RUN——
 * 绝不能让客户端自定义字符串直接落库成为审核依据。
 * 体积超限直接拒（而不是静默丢弃），否则开发者会以为报告已留证。
 */
export function normalizeAdaptationReport(report: unknown): {
  report: string;
  status: AdaptationStatus;
} {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw badRequest('适配报告必须是 JSON 对象');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(report);
  } catch {
    throw badRequest('适配报告无法序列化');
  }
  if (Buffer.byteLength(serialized, 'utf8') > PLUGIN_ADAPTATION_REPORT_MAX_BYTES) {
    throw badRequest('适配报告超过 512 KiB，请裁剪运行时日志后重试');
  }
  return {
    report: serialized,
    status: normalizeStoredAdaptationStatus((report as Record<string, unknown>).status as string),
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
  adaptationStatus?: string;
  runEvidence?: string | null;
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
    adaptationStatus: normalizeStoredAdaptationStatus(release.adaptationStatus),
    createdAt: release.createdAt.toISOString(),
  };
}

/**
 * README 与适配报告原文体积较大，仅由不可变的单条发布详情路由暴露，
 * 列表投影只带 adaptationStatus 这个枚举。
 */
export function releaseDetailJson(
  release: ReleaseJsonInput,
  options: { includeRunEvidence?: boolean } = {}
) {
  return {
    ...releaseJson(release),
    readme_markdown: release.readmeMarkdown || '',
    runEvidence: options.includeRunEvidence ? (release.runEvidence ?? null) : null,
  };
}

/** 历史行可能没有该列或存了旧值，读侧同样只认白名单。 */
export function normalizeStoredAdaptationStatus(raw: string | undefined | null): AdaptationStatus {
  return typeof raw === 'string' && (ADAPTATION_STATUSES as readonly string[]).includes(raw)
    ? (raw as AdaptationStatus)
    : 'NOT_RUN';
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
