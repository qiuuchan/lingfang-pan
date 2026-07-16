import { describe, expect, it, vi } from 'vitest';
import { MarketplaceDiscoveryService } from './marketplace-discovery.service';

const now = new Date('2026-07-16T00:00:00Z');
const IDS = {
  legacy: { package: '11111111-1111-4111-8111-111111111111', listing: '11111111-1111-4111-8111-111111111112', release: '11111111-1111-4111-8111-111111111113' },
  quality: { package: '22222222-2222-4222-8222-222222222221', listing: '22222222-2222-4222-8222-222222222222', release: '22222222-2222-4222-8222-222222222223' },
};

function row(identity: typeof IDS.legacy, legacyInstallCount: number) {
  const packageId = identity.package;
  return {
    id: identity.listing, packageId, currentReleaseId: identity.release,
    priceCents: 0, priceRevision: 1, status: 'ACTIVE', installCount: legacyInstallCount,
    ratingCount: legacyInstallCount, ratingSum: legacyInstallCount * 5, category: 'AI', qualityTier: 'QUALITY',
    qualitySnapshotId: `snapshot-${packageId}`, qualityQualifiedAt: new Date('2026-07-15T00:00:00Z'),
    featuredRank: null, featuredAt: null, featuredUntil: null, updatedAt: now,
    package: { id: packageId, ownerTeamId: `owner-${packageId}`, name: packageId, description: '', governanceStatus: 'ACTIVE', updatedAt: now, author: null },
    currentRelease: {
      id: identity.release, packageId, version: '1.0.0', manifest: { runtime_type: 'client', capabilities: [] }, actionSurfaceManifest: [],
      sha256: 'a'.repeat(64), sizeBytes: 1, targetPlatform: 'any', status: 'PUBLISHED', marketReviewStatus: 'APPROVED', aiPolicyVersion: 1, aiPolicyStatus: 'PASSED', createdAt: now,
    },
  };
}

function snapshot(packageId: string, activeTeams: number, installTeams: number, rating: number) {
  return {
    id: `snapshot-${packageId}`, policyVersion: 1, factWatermark: now, computedAt: now, autoQualified: true,
    listingAgeDays: 20, currentReleaseAgeDays: 10, activeTeams30d: activeTeams, installTeams30d: installTeams,
    observedRuns30d: 50, failedRuns30d: 0, failureRateBps: 0, ratingTeams: 10, ratingSum: 45,
    averageRatingTenths: rating, refundMetricState: 'NOT_APPLICABLE', maturedPaidOrders90d: 0,
    approvedRefunds90d: 0, refundRateBps: null, securityIncidents90d: 0, reasons: [],
  };
}

describe('MarketplaceDiscoveryService quality ordering', () => {
  it('orders category popular by immutable snapshot facts and never legacy counters', async () => {
    const findMany = vi.fn().mockResolvedValue([row(IDS.legacy, 9999), row(IDS.quality, 0)]);
    const prisma = {
      marketplaceListing: { findMany, count: vi.fn().mockResolvedValue(2) },
      marketplaceQualitySnapshot: { findMany: vi.fn().mockResolvedValue([
        snapshot(IDS.legacy.package, 1, 1, 50),
        snapshot(IDS.quality.package, 30, 20, 43),
      ]) },
      marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new MarketplaceDiscoveryService(prisma as never, {} as never);
    const result = await service.page({ section: 'CATEGORY_POPULAR', category: 'AI', page: 1, pageSize: 20 });
    expect(result.items.map((item) => item.package_id)).toEqual([IDS.quality.package, IDS.legacy.package]);
    const orderBy = findMany.mock.calls[0][0].orderBy;
    expect(JSON.stringify(orderBy)).not.toContain('installCount');
    expect(JSON.stringify(orderBy)).not.toContain('ratingSum');
    expect(JSON.stringify(orderBy)).not.toContain('ratingCount');
  });
});
