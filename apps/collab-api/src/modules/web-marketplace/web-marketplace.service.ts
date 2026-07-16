import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  PublicPluginCatalogPage,
  PublicPluginDetail,
  RuntimeType,
  WebCloudPreviewAction,
  WebPluginCatalogQuery,
  inferMarketplaceCategory,
  type PublicPluginCard,
  type WebPluginCatalogQuery as WebPluginCatalogQueryType,
  type WebPluginPreviewMode,
} from '@lingfang/contract';
import { notFound } from '../../common';
import { PrismaService } from '../../prisma.service';
import { PLUGIN_AI_POLICY_VERSION } from '../plugin-ai-policy';
import { MarketplaceDiscoveryService } from '../marketplace-discovery.service';
import { resolveMarketplacePrice } from '../marketplace-commerce-calculator';

type PublicListingRow = {
  id: string;
  packageId: string;
  currentReleaseId: string | null;
  priceCents: number;
  priceRevision: number;
  status: string;
  category?: 'AI' | 'PRODUCTIVITY' | 'DEV' | 'DATA' | 'MEDIA' | 'FILES' | 'NETWORK' | 'SYSTEM' | 'OTHER';
  qualityTier?: 'LISTED' | 'QUALITY' | 'FEATURED';
  qualityQualifiedAt?: Date | null;
  installCount: number;
  ratingCount: number;
  ratingSum: number;
  updatedAt: Date;
  package: {
    id: string;
    name: string;
    description: string;
    governanceStatus: string;
    updatedAt: Date;
    author: { displayName: string } | null;
  };
  currentRelease: {
    id: string;
    version: string;
    manifest: unknown;
    actionSurfaceManifest: unknown;
    readmeMarkdown?: string;
    sha256: string;
    targetPlatform: string;
    status: string;
    marketReviewStatus: string;
    aiPolicyVersion: number;
    aiPolicyStatus: string;
    createdAt: Date;
  } | null;
};

const PUBLIC_LISTING_SELECT = {
  id: true,
  packageId: true,
  currentReleaseId: true,
  priceCents: true,
  priceRevision: true,
  status: true,
  category: true,
  qualityTier: true,
  qualityQualifiedAt: true,
  installCount: true,
  ratingCount: true,
  ratingSum: true,
  updatedAt: true,
  package: {
    select: {
      id: true,
      name: true,
      description: true,
      governanceStatus: true,
      updatedAt: true,
      author: { select: { displayName: true } },
    },
  },
  currentRelease: {
    select: {
      id: true,
      version: true,
      manifest: true,
      actionSurfaceManifest: true,
      sha256: true,
      targetPlatform: true,
      status: true,
      marketReviewStatus: true,
      aiPolicyVersion: true,
      aiPolicyStatus: true,
      createdAt: true,
    },
  },
} as const;

const PUBLIC_DETAIL_SELECT = {
  ...PUBLIC_LISTING_SELECT,
  currentRelease: {
    select: {
      ...PUBLIC_LISTING_SELECT.currentRelease.select,
      readmeMarkdown: true,
    },
  },
} as const;

@Injectable()
export class WebMarketplaceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(MarketplaceDiscoveryService) private readonly discovery?: MarketplaceDiscoveryService,
  ) {}

  async catalog(input: unknown) {
    if (this.discovery) return this.discovery.catalog(input);
    const query = WebPluginCatalogQuery.parse(input);
    const rows = await this.prisma.marketplaceListing.findMany({
      where: { status: 'ACTIVE', currentReleaseId: { not: null } },
      select: PUBLIC_LISTING_SELECT,
    });
    const now = new Date();
    const discounts = await this.priceDiscounts(rows.map((row) => row.packageId), now);
    const cards = (rows as PublicListingRow[])
      .filter(isPublicListing)
      .map((row) => publicCard(row, discounts.get(row.packageId) ?? null, now))
      .filter((card) => matchesQuery(card, query));
    cards.sort(cardComparator(query.sort));
    const start = (query.page - 1) * query.page_size;
    return PublicPluginCatalogPage.parse({
      items: cards.slice(start, start + query.page_size),
      total: cards.length,
      page: query.page,
      page_size: query.page_size,
    });
  }

  async home(category?: string) {
    if (this.discovery) return this.discovery.home((category || null) as any);
    return {
      policy: undefined,
      generated_at: new Date().toISOString(),
      category: category || null,
      featured: [],
      category_popular: [],
      recent_quality: [],
    };
  }

  async detail(packageId: string) {
    const now = new Date();
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { packageId },
      select: PUBLIC_DETAIL_SELECT,
    });
    if (!listing || !isPublicListing(listing as PublicListingRow)) {
      throw notFound('市场插件不存在或未上架');
    }
    const row = listing as PublicListingRow;
    if (!isPublicListing(row)) throw notFound('市场插件不存在或未上架');
    const discounts = await this.priceDiscounts([packageId], now);
    const card = publicCard(row, discounts.get(packageId) ?? null, now);
    return PublicPluginDetail.parse({
      ...card,
      readme_markdown: row.currentRelease?.readmeMarkdown ?? '',
      release_sha256: row.currentRelease!.sha256,
      compatibility: {
        runtime_type: card.runtime_type,
        desktop_platforms: [row.currentRelease!.targetPlatform],
        minimum_desktop_version: null,
        web_compatible: card.preview_mode !== 'STATIC_DESKTOP',
      },
      preview_actions: publicPreviewActions(row.currentRelease!.actionSurfaceManifest),
    });
  }

  private async priceDiscounts(packageIds: string[], now: Date) {
    const state = await this.prisma.marketplaceCommerceState.findUnique({ where: { id: 'singleton' } });
    if (state?.writerMode !== 'SETTLEMENT_V2' || !state.settlementV2ActivatedAt || packageIds.length === 0) return new Map();
    const rows = await this.prisma.marketplaceDiscount.findMany({
      where: { packageId: { in: packageIds }, canceledAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
      orderBy: [{ startsAt: 'asc' }, { revision: 'desc' }],
    });
    return new Map(rows.map((row: { packageId: string }) => [row.packageId, row]));
  }
}

function publicPreviewActions(actionSurfaceManifest: unknown) {
  if (!Array.isArray(actionSurfaceManifest)) return [];
  return actionSurfaceManifest.flatMap((item) => {
    const action = objectValue(item);
    const semantics = action.execution_semantics;
    if (action.previewable !== true
      || action.cloud_capable !== true
      || semantics !== 'read_only' && semantics !== 'idempotent') return [];
    const parsed = WebCloudPreviewAction.safeParse({
      action_id: action.action_id,
      name: action.name,
      description: action.description ?? '',
      action_contract_version: action.action_contract_version,
      action_surface_sha256: action.action_surface_sha256,
      input_schema: action.input_schema,
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function isPublicListing(row: PublicListingRow): row is PublicListingRow & { currentRelease: NonNullable<PublicListingRow['currentRelease']> } {
  return row.status === 'ACTIVE'
    && row.package.governanceStatus === 'ACTIVE'
    && row.currentReleaseId !== null
    && row.currentRelease !== null
    && row.currentRelease.id === row.currentReleaseId
    && row.currentRelease.status === 'PUBLISHED'
    && row.currentRelease.marketReviewStatus === 'APPROVED'
    && row.currentRelease.aiPolicyVersion === PLUGIN_AI_POLICY_VERSION
    && row.currentRelease.aiPolicyStatus === 'PASSED';
}

function publicCard(
  row: PublicListingRow & { currentRelease: NonNullable<PublicListingRow['currentRelease']> },
  discount: Parameters<typeof resolveMarketplacePrice>[0]['discount'],
  now: Date,
): PublicPluginCard {
  const manifest = objectValue(row.currentRelease.manifest);
  const runtime = RuntimeType.safeParse(manifest.runtime_type).success
    ? RuntimeType.parse(manifest.runtime_type)
    : 'client';
  const capabilities = Array.isArray(manifest.capabilities)
    ? manifest.capabilities.flatMap((capability) => {
      if (typeof capability === 'string') return [capability];
      const kind = objectValue(capability).kind;
      return typeof kind === 'string' ? [kind] : [];
    })
    : [];
  const price = resolveMarketplacePrice({ listPriceCents: row.priceCents, priceRevision: row.priceRevision, discount, now });
  return {
    package_id: row.package.id,
    listing_id: row.id,
    release_id: row.currentRelease.id,
    name: row.package.name,
    summary: row.package.description,
    author_display_name: row.package.author?.displayName ?? null,
    category: row.category ?? inferMarketplaceCategory({
      name: row.package.name,
      description: row.package.description,
      capabilities,
    }),
    runtime_type: runtime,
    quality_tier: row.qualityTier === 'FEATURED' || row.qualityTier === 'QUALITY' ? row.qualityTier : 'LISTED',
    version: row.currentRelease.version,
    install_count: row.installCount,
    rating_count: row.ratingCount,
    average_rating_tenths: row.ratingCount > 0
      ? Math.max(0, Math.min(50, Math.round((row.ratingSum / row.ratingCount) * 10)))
      : 0,
    base_price_cents: row.priceCents,
    discount_amount_cents: price.discount_amount_cents,
    effective_price_cents: price.price_cents,
    price_version: price.price_version,
    preview_mode: previewMode(runtime, row.currentRelease.actionSurfaceManifest),
    updated_at: maxDate(row.updatedAt, row.package.updatedAt, row.currentRelease.createdAt).toISOString(),
  };
}

function previewMode(runtime: string, actionSurfaceManifest: unknown): WebPluginPreviewMode {
  if (runtime === 'client') return process.env.CLIENT_PLUGIN_PREVIEW_ENABLED === 'false' ? 'STATIC_DESKTOP' : 'CLIENT_SANDBOX';
  if (runtime !== 'cloud' || !Array.isArray(actionSurfaceManifest)) return 'STATIC_DESKTOP';
  const previewable = actionSurfaceManifest.some((item) => {
    const action = objectValue(item);
    return action.previewable === true
      && action.cloud_capable === true
      && (action.execution_semantics === 'read_only' || action.execution_semantics === 'idempotent');
  });
  return previewable ? 'CLOUD_TRIAL' : 'STATIC_DESKTOP';
}

function matchesQuery(card: PublicPluginCard, query: WebPluginCatalogQueryType): boolean {
  const keyword = query.q.toLocaleLowerCase();
  if (keyword && !`${card.name} ${card.summary} ${card.author_display_name ?? ''}`.toLocaleLowerCase().includes(keyword)) return false;
  if (query.category && card.category !== query.category) return false;
  if (query.runtime_type && card.runtime_type !== query.runtime_type) return false;
  if (query.quality_tier && card.quality_tier !== query.quality_tier) return false;
  if (query.price === 'FREE' && card.base_price_cents !== 0) return false;
  if (query.price === 'PAID' && card.base_price_cents === 0) return false;
  if (query.compatibility === 'WEB' && card.preview_mode === 'STATIC_DESKTOP') return false;
  if (query.compatibility === 'DESKTOP' && card.preview_mode !== 'STATIC_DESKTOP') return false;
  return true;
}

function cardComparator(sort: WebPluginCatalogQueryType['sort']) {
  return (left: PublicPluginCard, right: PublicPluginCard) => {
    let primary = 0;
    if (sort === 'RECENT') primary = right.updated_at.localeCompare(left.updated_at);
    if (sort === 'POPULAR') primary = right.install_count - left.install_count;
    if (sort === 'RATING') primary = right.average_rating_tenths - left.average_rating_tenths || right.rating_count - left.rating_count;
    if (sort === 'NAME') primary = left.name.localeCompare(right.name);
    return primary || left.package_id.localeCompare(right.package_id);
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function maxDate(...dates: Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}
