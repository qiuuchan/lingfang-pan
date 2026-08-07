import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { PLUGIN_AI_POLICY_VERSION } from './plugin-ai-policy';
import { packageJson, releaseListJson } from './plugin-registry-model';
import { resolveMarketplacePrice } from './marketplace-commerce-calculator';
import {
  MarketplaceDiscoveryHome,
  MarketplaceDiscoveryPage,
  MarketplaceQualitySummary,
  MarketplaceQualityMetricSummary,
  MARKETPLACE_QUALITY_POLICY_V1,
  PublicPluginCatalogPage,
  RuntimeType,
  WebPluginCatalogQuery,
  inferMarketplaceCategory,
  type MarketplaceCategory,
  type MarketplaceDiscoverySection,
  type PublicPluginCard,
  type WebPluginCatalogQuery as WebPluginCatalogQueryType,
  type WebPluginPreviewMode,
} from '@lingfang/contract';

/**
 * One read owner for v4 marketplace discovery.
 *
 * The registry and Web center deliberately use different response shapes, but
 * they must read the same MarketplaceListing quality/category projection.  In
 * particular, neither client is allowed to infer a tier from legacy install or
 * rating counters.  All ordering is expressed as Prisma ORDER BY clauses and
 * pagination happens before response projection.
 */
@Injectable()
export class MarketplaceDiscoveryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}

  async catalogForTeam(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const rows = await this.findRows({
      section: 'ALL',
      page: 1,
      pageSize: 500,
      teamId: membership.teamId,
    });
    const entitlements =
      rows.length === 0
        ? []
        : await this.prisma.pluginEntitlement.findMany({
            where: {
              teamId: membership.teamId,
              status: 'ACTIVE',
              packageId: { in: rows.map((row) => row.packageId) },
            },
            select: { packageId: true },
          });
    const entitled = new Set(entitlements.map((item) => item.packageId));
    return {
      items: rows.map((row) => {
        const quality = this.qualitySummary(row, row.snapshot, new Date());
        return {
          package: packageJson(row.package as any),
          latestRelease: releaseListJson({
            ...row.currentRelease,
            packageId: row.packageId,
          } as any),
          priceCents: row.price.effective_price_cents,
          listPriceCents: row.price.list_price_cents,
          discountAmountCents: row.price.discount_amount_cents,
          priceVersion: row.price.price_version,
          listingStatus: row.status,
          entitled: row.price.effective_price_cents === 0 || entitled.has(row.packageId),
          category: row.category,
          qualityTier: quality.tier,
          qualityQualifiedAt: quality.qualified_at,
          quality,
        };
      }),
    };
  }

  async catalog(input: unknown) {
    const query = WebPluginCatalogQuery.parse(input);
    const rows = await this.findRows({
      section: 'ALL',
      page: query.page,
      pageSize: query.page_size,
      category: query.category,
      qualityTier: query.quality_tier,
      query,
    });
    const total = await this.countRows({
      category: query.category,
      qualityTier: query.quality_tier,
      query,
    });
    return PublicPluginCatalogPage.parse({
      items: rows.map((row) => this.publicCard(row, row.snapshot)),
      total,
      page: query.page,
      page_size: query.page_size,
    });
  }

  async home(category: MarketplaceCategory | null = null) {
    const [featured, categoryPopular, recentQuality] = await Promise.all([
      this.findRows({ section: 'FEATURED', page: 1, pageSize: 20, category: undefined }),
      this.findRows({
        section: 'CATEGORY_POPULAR',
        page: 1,
        pageSize: 20,
        category: category ?? undefined,
      }),
      this.findRows({
        section: 'RECENT_QUALITY',
        page: 1,
        pageSize: 20,
        category: category ?? undefined,
      }),
    ]);
    return MarketplaceDiscoveryHome.parse({
      policy: MARKETPLACE_QUALITY_POLICY_V1,
      generated_at: new Date().toISOString(),
      category,
      featured: featured.map((row) => this.discoveryItem(row)),
      category_popular: categoryPopular.map((row) => this.discoveryItem(row)),
      recent_quality: recentQuality.map((row) => this.discoveryItem(row)),
    });
  }

  async page(input: {
    section: MarketplaceDiscoverySection;
    category?: MarketplaceCategory;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 24)));
    const rows = await this.findRows({
      section: input.section,
      category: input.category,
      page,
      pageSize,
    });
    const total = await this.countRows({ section: input.section, category: input.category });
    return MarketplaceDiscoveryPage.parse({
      section: input.section,
      category: input.category ?? null,
      page,
      page_size: pageSize,
      total,
      items: rows.map((row) => this.discoveryItem(row)),
    });
  }

  private async findRows(input: {
    section: 'ALL' | MarketplaceDiscoverySection;
    page: number;
    pageSize: number;
    category?: MarketplaceCategory;
    qualityTier?: string;
    query?: WebPluginCatalogQueryType;
    teamId?: string;
  }) {
    const now = new Date();
    const where: any = {
      status: 'ACTIVE',
      currentReleaseId: { not: null },
      package: { governanceStatus: 'ACTIVE' },
      currentRelease: {
        status: 'PUBLISHED',
        marketReviewStatus: 'APPROVED',
        aiPolicyVersion: PLUGIN_AI_POLICY_VERSION,
        aiPolicyStatus: 'PASSED',
      },
    };
    if (input.category) where.category = input.category;
    if (input.qualityTier) where.qualityTier = input.qualityTier;
    if (input.section === 'FEATURED') {
      where.qualityTier = 'FEATURED';
      where.featuredAt = { not: null };
      where.OR = [{ featuredUntil: null }, { featuredUntil: { gt: now } }];
    } else if (input.section === 'RECENT_QUALITY') {
      where.qualityTier = { in: ['QUALITY', 'FEATURED'] };
      where.qualityQualifiedAt = {
        not: null,
        gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      };
    }
    if (input.query) {
      const q = input.query.q.trim();
      if (q)
        where.package.OR = [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ];
      if (input.query.runtime_type)
        where.currentRelease.manifest = {
          path: ['runtime_type'],
          equals: input.query.runtime_type,
        };
      if (input.query.price === 'FREE') where.priceCents = 0;
      if (input.query.price === 'PAID') where.priceCents = { gt: 0 };
      if (input.query.compatibility === 'WEB')
        where.currentRelease.manifest = { path: ['runtime_type'], equals: 'cloud' };
      if (input.query.compatibility === 'DESKTOP')
        where.currentRelease.manifest = { path: ['runtime_type'], not: 'cloud' };
    }
    const qualityRanked =
      input.section === 'CATEGORY_POPULAR' ||
      input.query?.sort === 'POPULAR' ||
      input.query?.sort === 'RATING';
    const requestedSkip = Math.max(0, (input.page - 1) * input.pageSize);
    const candidateLimit = qualityRanked
      ? Math.min(500, Math.max(100, (requestedSkip + input.pageSize) * 5))
      : input.pageSize;
    const orderBy = this.orderBy(input.section, input.query?.sort) as any;
    const rows = (await this.prisma.marketplaceListing.findMany({
      where,
      select: DISCOVERY_SELECT,
      orderBy,
      skip: qualityRanked ? 0 : requestedSkip,
      take: candidateLimit,
    })) as unknown as DiscoveryRow[];
    const snapshots = await this.attachSnapshots(rows);
    const projected = await this.attachPrices(snapshots, now);
    if (!qualityRanked) return projected;
    const ranked = [...projected].sort(input.query?.sort === 'RATING' ? ratingOrder : popularOrder);
    return ranked.slice(requestedSkip, requestedSkip + input.pageSize);
  }

  private async countRows(input: {
    section?: 'ALL' | MarketplaceDiscoverySection;
    category?: MarketplaceCategory;
    qualityTier?: string;
    query?: WebPluginCatalogQueryType;
  }) {
    const now = new Date();
    const where: any = {
      status: 'ACTIVE',
      currentReleaseId: { not: null },
      package: { governanceStatus: 'ACTIVE' },
      currentRelease: {
        status: 'PUBLISHED',
        marketReviewStatus: 'APPROVED',
        aiPolicyVersion: PLUGIN_AI_POLICY_VERSION,
        aiPolicyStatus: 'PASSED',
      },
    };
    if (input.category) where.category = input.category;
    if (input.qualityTier) where.qualityTier = input.qualityTier;
    if (input.section === 'FEATURED') {
      where.qualityTier = 'FEATURED';
      where.featuredAt = { not: null };
      where.OR = [{ featuredUntil: null }, { featuredUntil: { gt: now } }];
    }
    if (input.section === 'RECENT_QUALITY') {
      where.qualityTier = { in: ['QUALITY', 'FEATURED'] };
      where.qualityQualifiedAt = {
        not: null,
        gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      };
    }
    if (input.query) {
      const q = input.query.q.trim();
      if (q)
        where.package.OR = [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ];
      if (input.query.runtime_type)
        where.currentRelease.manifest = {
          path: ['runtime_type'],
          equals: input.query.runtime_type,
        };
      if (input.query.price === 'FREE') where.priceCents = 0;
      if (input.query.price === 'PAID') where.priceCents = { gt: 0 };
      if (input.query.compatibility === 'WEB')
        where.currentRelease.manifest = { path: ['runtime_type'], equals: 'cloud' };
      if (input.query.compatibility === 'DESKTOP')
        where.currentRelease.manifest = { path: ['runtime_type'], not: 'cloud' };
    }
    return this.prisma.marketplaceListing.count({ where });
  }

  private orderBy(
    section: 'ALL' | MarketplaceDiscoverySection,
    sort?: WebPluginCatalogQueryType['sort']
  ) {
    if (section === 'FEATURED')
      return [{ featuredRank: 'asc' }, { featuredAt: 'desc' }, { packageId: 'asc' }];
    if (section === 'RECENT_QUALITY') return [{ qualityQualifiedAt: 'desc' }, { packageId: 'asc' }];
    // Popular/rating ordering is applied from the immutable quality snapshot
    // after this bounded candidate query. Legacy installCount/ratingSum are
    // intentionally never used as v4 quality facts or recommendation ranks.
    if (section === 'CATEGORY_POPULAR' || sort === 'POPULAR' || sort === 'RATING')
      return [{ qualityTier: 'desc' }, { qualityQualifiedAt: 'desc' }, { packageId: 'asc' }];
    if (sort === 'NAME') return [{ package: { name: 'asc' } }, { packageId: 'asc' }];
    return [{ updatedAt: 'desc' }, { packageId: 'asc' }];
  }

  private async attachSnapshots(rows: DiscoveryRow[]) {
    const ids = [
      ...new Set(
        rows.map((row) => row.qualitySnapshotId).filter((id): id is string => Boolean(id))
      ),
    ];
    if (!ids.length || !this.prisma.marketplaceQualitySnapshot?.findMany)
      return rows.map((row) => ({ ...row, snapshot: null }));
    const snapshots = await this.prisma.marketplaceQualitySnapshot.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    return rows.map((row) => ({
      ...row,
      snapshot: row.qualitySnapshotId ? (byId.get(row.qualitySnapshotId) ?? null) : null,
    }));
  }

  private async attachPrices(rows: DiscoveryRowWithSnapshot[], now: Date) {
    const state =
      (await (this.prisma as any).marketplaceCommerceState?.findUnique?.({
        where: { id: 'singleton' },
      })) ?? null;
    let discounts: Array<{
      id: string;
      packageId: string;
      revision: number;
      priceCents: number;
      startsAt: Date;
      endsAt: Date;
      canceledAt: Date | null;
    }> = [];
    if (state?.writerMode === 'SETTLEMENT_V2' && state.settlementV2ActivatedAt && rows.length > 0) {
      discounts =
        (await (this.prisma as any).marketplaceDiscount?.findMany?.({
          where: {
            packageId: { in: rows.map((row) => row.packageId) },
            canceledAt: null,
            startsAt: { lte: now },
            endsAt: { gt: now },
          },
          orderBy: [{ startsAt: 'asc' }, { revision: 'desc' }],
        })) ?? [];
    }
    const byPackage = new Map(discounts.map((discount) => [discount.packageId, discount]));
    return rows.map((row) => ({
      ...row,
      price: resolveMarketplacePrice({
        listPriceCents: row.priceCents,
        priceRevision: row.priceRevision,
        discount: byPackage.get(row.packageId) ?? null,
        now,
      }),
    }));
  }

  private discoveryItem(row: DiscoveryRowWithProjection) {
    return {
      ...this.publicCard(row, row.snapshot),
      quality: this.qualitySummary(row, row.snapshot, new Date()),
    };
  }

  private publicCard(row: DiscoveryRowWithProjection, snapshot: any): PublicPluginCard {
    const manifest = objectValue(row.currentRelease.manifest);
    const runtime = RuntimeType.safeParse(manifest.runtime_type).success
      ? RuntimeType.parse(manifest.runtime_type)
      : 'client';
    const capabilities = Array.isArray(manifest.capabilities)
      ? manifest.capabilities.flatMap((capability) =>
          typeof capability === 'string'
            ? [capability]
            : typeof objectValue(capability).kind === 'string'
              ? [String(objectValue(capability).kind)]
              : []
        )
      : [];
    const quality = this.qualitySummary(row, snapshot, new Date());
    return {
      package_id: row.package.id,
      listing_id: row.id,
      release_id: row.currentRelease.id,
      name: row.package.name,
      summary: row.package.description,
      author_display_name: row.package.author?.displayName ?? null,
      category:
        row.category ||
        inferMarketplaceCategory({
          name: row.package.name,
          description: row.package.description,
          capabilities,
        }),
      runtime_type: runtime,
      quality_tier: quality.tier,
      version: row.currentRelease.version,
      install_count: row.installCount,
      rating_count: row.ratingCount,
      average_rating_tenths:
        row.ratingCount > 0
          ? Math.max(0, Math.min(50, Math.round((row.ratingSum / row.ratingCount) * 10)))
          : 0,
      base_price_cents: row.priceCents,
      discount_amount_cents: row.price.discount_amount_cents,
      effective_price_cents: row.price.effective_price_cents,
      price_version: row.price.price_version,
      preview_mode: previewMode(runtime, row.currentRelease.actionSurfaceManifest),
      updated_at: maxDate(
        row.updatedAt,
        row.package.updatedAt,
        row.currentRelease.createdAt
      ).toISOString(),
    };
  }

  private qualitySummary(row: DiscoveryRow, snapshot: any, now: Date): MarketplaceQualitySummary {
    const tier = activeTier(row, snapshot, now);
    const metrics: MarketplaceQualityMetricSummary = {
      listing_age_days: snapshot?.listingAgeDays ?? 0,
      current_release_age_days: snapshot?.currentReleaseAgeDays ?? 0,
      active_teams_30d: snapshot?.activeTeams30d ?? 0,
      install_teams_30d: snapshot?.installTeams30d ?? 0,
      observed_runs_30d: snapshot?.observedRuns30d ?? 0,
      failed_runs_30d: snapshot?.failedRuns30d ?? 0,
      failure_rate_bps: snapshot?.failureRateBps ?? null,
      rating_teams: snapshot?.ratingTeams ?? 0,
      rating_sum: snapshot?.ratingSum ?? 0,
      average_rating_tenths: snapshot?.averageRatingTenths ?? null,
      refund_metric_state:
        snapshot?.refundMetricState ?? (row.priceCents > 0 ? 'DATA_UNAVAILABLE' : 'NOT_APPLICABLE'),
      matured_paid_orders_90d: snapshot?.maturedPaidOrders90d ?? 0,
      approved_refunds_90d: snapshot?.approvedRefunds90d ?? 0,
      refund_rate_bps: snapshot?.refundRateBps ?? null,
      security_incidents_90d: snapshot?.securityIncidents90d ?? 0,
    };
    return MarketplaceQualitySummary.parse({
      tier,
      auto_qualified: Boolean(snapshot?.autoQualified && tier !== 'FEATURED'),
      policy_version: snapshot?.policyVersion ?? MARKETPLACE_QUALITY_POLICY_V1.version,
      fact_watermark: (snapshot?.factWatermark ?? row.updatedAt).toISOString(),
      computed_at: (snapshot?.computedAt ?? row.updatedAt).toISOString(),
      qualified_at: row.qualityQualifiedAt?.toISOString() ?? null,
      stale: !snapshot,
      metrics,
      reasons: Array.isArray(snapshot?.reasons)
        ? snapshot.reasons
        : [{ code: 'hard_gate_failed', actual: null, threshold: null }],
    });
  }
}

type DiscoveryRow = {
  id: string;
  packageId: string;
  currentReleaseId: string | null;
  priceCents: number;
  priceRevision: number;
  status: string;
  installCount: number;
  ratingCount: number;
  ratingSum: number;
  category: MarketplaceCategory;
  qualityTier: 'LISTED' | 'QUALITY' | 'FEATURED';
  qualitySnapshotId: string | null;
  qualityQualifiedAt: Date | null;
  featuredRank: number | null;
  featuredAt: Date | null;
  featuredUntil: Date | null;
  updatedAt: Date;
  package: {
    id: string;
    ownerTeamId: string;
    name: string;
    description: string;
    governanceStatus: string;
    createdAt: Date;
    updatedAt: Date;
    author: { displayName: string } | null;
  };
  currentRelease: {
    id: string;
    packageId: string;
    version: string;
    manifest: unknown;
    actionSurfaceManifest: unknown;
    sha256: string;
    sizeBytes: number;
    targetPlatform: string;
    status: string;
    marketReviewStatus: string;
    aiPolicyVersion: number;
    aiPolicyStatus: string;
    createdAt: Date;
  };
};
type DiscoveryRowWithSnapshot = DiscoveryRow & { snapshot: any | null };
type DiscoveryRowWithProjection = DiscoveryRowWithSnapshot & {
  price: ReturnType<typeof resolveMarketplacePrice>;
};

const DISCOVERY_SELECT = {
  id: true,
  packageId: true,
  currentReleaseId: true,
  priceCents: true,
  priceRevision: true,
  status: true,
  installCount: true,
  ratingCount: true,
  ratingSum: true,
  category: true,
  qualityTier: true,
  qualitySnapshotId: true,
  qualityQualifiedAt: true,
  featuredRank: true,
  featuredAt: true,
  featuredUntil: true,
  updatedAt: true,
  package: {
    select: {
      id: true,
      ownerTeamId: true,
      name: true,
      description: true,
      governanceStatus: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { displayName: true } },
    },
  },
  currentRelease: {
    select: {
      id: true,
      packageId: true,
      version: true,
      manifest: true,
      actionSurfaceManifest: true,
      sha256: true,
      sizeBytes: true,
      targetPlatform: true,
      status: true,
      marketReviewStatus: true,
      aiPolicyVersion: true,
      aiPolicyStatus: true,
      createdAt: true,
    },
  },
} as const;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function activeTier(
  row: DiscoveryRow,
  snapshot: any,
  now: Date
): 'LISTED' | 'QUALITY' | 'FEATURED' {
  if (
    row.qualityTier === 'FEATURED' &&
    row.featuredAt &&
    (!row.featuredUntil || row.featuredUntil > now)
  )
    return 'FEATURED';
  return snapshot?.autoQualified ? 'QUALITY' : 'LISTED';
}

function previewMode(runtime: string, actionSurfaceManifest: unknown): WebPluginPreviewMode {
  if (runtime === 'client')
    return process.env.CLIENT_PLUGIN_PREVIEW_ENABLED === 'false'
      ? 'STATIC_DESKTOP'
      : 'CLIENT_SANDBOX';
  if (runtime !== 'cloud' || !Array.isArray(actionSurfaceManifest)) return 'STATIC_DESKTOP';
  const previewable = actionSurfaceManifest.some((item) => {
    const action = objectValue(item);
    return (
      action.previewable === true &&
      action.cloud_capable === true &&
      (action.execution_semantics === 'read_only' || action.execution_semantics === 'idempotent')
    );
  });
  return previewable ? 'CLOUD_TRIAL' : 'STATIC_DESKTOP';
}

function maxDate(...dates: Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function popularOrder(a: DiscoveryRowWithProjection, b: DiscoveryRowWithProjection): number {
  return (
    (b.snapshot?.activeTeams30d ?? 0) - (a.snapshot?.activeTeams30d ?? 0) ||
    (b.snapshot?.installTeams30d ?? 0) - (a.snapshot?.installTeams30d ?? 0) ||
    (b.snapshot?.averageRatingTenths ?? 0) - (a.snapshot?.averageRatingTenths ?? 0) ||
    a.packageId.localeCompare(b.packageId)
  );
}

function ratingOrder(a: DiscoveryRowWithProjection, b: DiscoveryRowWithProjection): number {
  return (
    (b.snapshot?.averageRatingTenths ?? 0) - (a.snapshot?.averageRatingTenths ?? 0) ||
    (b.snapshot?.ratingTeams ?? 0) - (a.snapshot?.ratingTeams ?? 0) ||
    a.packageId.localeCompare(b.packageId)
  );
}
