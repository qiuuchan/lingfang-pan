import { describe, expect, it, vi } from 'vitest';
import { MarketplaceQualityService } from './marketplace-quality.service';
import { marketplaceQualityGateDigest } from './marketplace-quality-projection';

const ids = {
  package: '11111111-1111-4111-8111-111111111111',
  release: '22222222-2222-4222-8222-222222222222',
  team: '33333333-3333-4333-8333-333333333333',
  owner: '44444444-4444-4444-8444-444444444444',
  user: '55555555-5555-4555-8555-555555555555',
  rating: '66666666-6666-4666-8666-666666666666',
};

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: '77777777-7777-4777-8777-777777777777', packageId: ids.package, currentReleaseId: ids.release,
    currentReleaseActivatedAt: new Date('2026-06-01T00:00:00Z'), pointerRevision: 1, eligibilityRevision: 1,
    eligibilityGateDigest: 'a'.repeat(64), listingEligibleSince: new Date('2026-06-01T00:00:00Z'), releaseEligibleSince: new Date('2026-06-01T00:00:00Z'),
    status: 'ACTIVE', priceCents: 100, qualityBlockedAt: null, qualitySnapshotId: null,
    package: { id: ids.package, ownerTeamId: ids.owner, governanceStatus: 'ACTIVE', name: '插件' },
    currentRelease: { id: ids.release, status: 'PUBLISHED', marketReviewStatus: 'APPROVED', aiPolicyVersion: 1, aiPolicyStatus: 'PASSED' },
    ...overrides,
  };
}

function setup(overrides: Record<string, any> = {}) {
  const created = { id: ids.rating, score: 5, comment: '好用', revision: 1, createdAt: new Date(), updatedAt: new Date() };
  const tx = {
    marketplaceRating: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(created), update: vi.fn() },
    marketplaceRatingRevision: { create: vi.fn().mockResolvedValue({ id: 'revision-1' }) },
    marketplaceMetricEvent: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    marketplaceListing: { findUnique: vi.fn().mockResolvedValue(listing()) },
    pluginEntitlement: { findFirst: vi.fn().mockResolvedValue({ id: 'entitlement-1' }) },
    marketplaceMetricEvent: { findFirst: vi.fn().mockResolvedValue({ id: 'run-1' }), findMany: vi.fn().mockResolvedValue([]) },
    marketplaceRating: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    pluginPackage: { findUnique: vi.fn() },
    marketplaceQualitySnapshot: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn().mockImplementation((fn) => fn(tx)),
    ...overrides,
  };
  const auth = { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: ids.team }), ensurePlatformAdmin: vi.fn().mockResolvedValue({ id: ids.user }) };
  const computations = { manualJobKey: vi.fn().mockReturnValue('job-1'), dailyJobKey: vi.fn().mockReturnValue('daily-job-1'), compute: vi.fn().mockResolvedValue({ computationId: 'c1', snapshotId: 's1', projected: true }) };
  const tickets = { create: vi.fn().mockResolvedValue({ ticket: { id: 'ticket-1' } }) };
  const facts = { load: vi.fn().mockResolvedValue({
    scope: {
      listingId: listing().id, packageId: ids.package, releaseId: ids.release,
      currentReleaseActivatedAt: listing().currentReleaseActivatedAt, pointerRevision: 1,
      eligibilityRevision: 1, eligibilityGateDigest: 'a'.repeat(64),
      listingEligibleSince: listing().listingEligibleSince, releaseEligibleSince: listing().releaseEligibleSince,
    },
    facts: {
      hardGateEligible: true, activeTeams30d: 1, installTeams30d: 0,
      observedRuns30d: 2, failedRuns30d: 1, ratingTeams: 0, ratingSum: 0,
      paid: true, refundMetricState: 'DATA_UNAVAILABLE', maturedPaidOrders90d: 0,
      approvedRefunds90d: 0, securityIncidents90d: 0, anomalyReviewRequired: false, qualityBlocked: false,
    },
  }) };
  return { prisma, auth, computations, tickets, facts, tx, service: new MarketplaceQualityService(prisma as never, auth as never, computations as never, tickets as never, facts as never) };
}

describe('MarketplaceQualityService', () => {
  it('writes the current rating, immutable revision and trusted metric in one transaction', async () => {
    const { service, tx } = setup();
    const result = await service.rate(ids.user, ids.package, { score: 5, comment: '好用' });
    expect(result).toMatchObject({ score: 5, revision: 1 });
    expect(tx.marketplaceRatingRevision.create).toHaveBeenCalledWith({ data: expect.objectContaining({ packageId: ids.package, teamId: ids.team, revision: 1, score: 5 }) });
    expect(tx.marketplaceMetricEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'RATING_CHANGED', source: 'REGISTRY', releaseId: ids.release }) });
  });

  it('rejects author-team ratings before writing any projection', async () => {
    const { service, prisma } = setup({ marketplaceListing: { findUnique: vi.fn().mockResolvedValue(listing({ package: { id: ids.package, ownerTeamId: ids.team, governanceStatus: 'ACTIVE', name: '插件' } })) } });
    await expect(service.rate(ids.user, ids.package, { score: 5 })).rejects.toMatchObject({ status: 403 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires a successful trusted run before rating a free package', async () => {
    const { service } = setup({
      marketplaceListing: { findUnique: vi.fn().mockResolvedValue(listing({ priceCents: 0 })) },
      marketplaceMetricEvent: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn() },
    });
    await expect(service.rate(ids.user, ids.package, { score: 4 })).rejects.toMatchObject({ status: 403 });
  });

  it('feeds persisted terminal facts into a manual computation and records the admin action', async () => {
    const { service, computations, prisma, facts } = setup();
    await service.recompute(ids.user, ids.package, 'request-1');
    expect(computations.compute).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.objectContaining({ activeTeams30d: 1, observedRuns30d: 2, failedRuns30d: 1 }) }));
    expect(facts.load).toHaveBeenCalledWith(ids.package, expect.any(Date));
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'admin.marketplace.quality.recomputed' }) });
  });

  it('uses one fixed watermark for a paged daily quality pass', async () => {
    const firstPage = vi.fn()
      .mockResolvedValueOnce([{ packageId: ids.package }])
      .mockResolvedValueOnce([]);
    const { service, facts, computations } = setup({ marketplaceListing: { findMany: firstPage, findUnique: vi.fn().mockResolvedValue(listing()) } });
    const watermark = new Date('2026-07-16T02:00:00Z');
    const result = await service.runDaily(watermark, 1);
    expect(result).toMatchObject({ factWatermark: watermark, processed: 1, succeeded: 1, failed: 0 });
    expect(facts.load).toHaveBeenCalledWith(ids.package, watermark);
    expect(computations.dailyJobKey).toHaveBeenCalledWith(expect.anything(), watermark);
  });

  it('sets featured state only through a hard-gated CAS and writes its audit reason', async () => {
    const base = listing();
    const current = { ...base, eligibilityGateDigest: marketplaceQualityGateDigest({
      listingStatus: base.status, currentReleaseId: base.currentReleaseId, currentReleaseStatus: base.currentRelease.status,
      marketReviewStatus: base.currentRelease.marketReviewStatus, aiPolicyVersion: base.currentRelease.aiPolicyVersion,
      aiPolicyStatus: base.currentRelease.aiPolicyStatus, securityBlocked: false, pointerRevision: base.pointerRevision,
      eligibilityRevision: base.eligibilityRevision,
    }), updatedAt: new Date('2026-07-16T00:00:00Z') };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const auditCreate = vi.fn().mockResolvedValue({});
    const marketTx = {
      marketplaceListing: { findUnique: vi.fn().mockResolvedValue(current), updateMany },
      auditLog: { create: auditCreate },
    };
    const { service } = setup({ $transaction: vi.fn((operation) => operation(marketTx)) });
    await expect(service.feature(ids.user, ids.package, { reason: '编辑推荐', rank: 2, until: '2099-01-01T00:00:00.000Z' })).resolves.toMatchObject({ tier: 'FEATURED', rank: 2 });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: current.id, updatedAt: current.updatedAt },
      data: expect.objectContaining({ qualityTier: 'FEATURED', featuredReason: '编辑推荐', featuredRank: 2 }),
    }));
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'admin.marketplace.quality.featured' }) });
  });

  it('blocks automatic quality without discarding an active manual feature', async () => {
    const current = { ...listing(), updatedAt: new Date('2026-07-16T00:00:00Z'), featuredAt: new Date(), featuredUntil: null, qualityTier: 'FEATURED' };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const marketTx = {
      marketplaceListing: { findUnique: vi.fn().mockResolvedValue(current), updateMany },
      marketplaceQualitySnapshot: { findUnique: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const { service } = setup({ $transaction: vi.fn((operation) => operation(marketTx)) });
    await expect(service.setQualityBlocked(ids.user, ids.package, true, '异常复核')).resolves.toMatchObject({ blocked: true, tier: 'FEATURED' });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ qualityTier: 'FEATURED', qualityBlockedReason: '异常复核' }) }));
  });
});
