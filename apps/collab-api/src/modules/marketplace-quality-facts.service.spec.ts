import { describe, expect, it, vi } from 'vitest';
import { MarketplaceQualityFactsService, PrismaMarketplaceCommerceFactsAdapter } from './marketplace-quality-facts.service';

const watermark = new Date('2026-07-16T00:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

describe('PrismaMarketplaceCommerceFactsAdapter', () => {
  it('returns DATA_UNAVAILABLE before persistent SETTLEMENT_V2 activation without reading orders', async () => {
    const findMany = vi.fn();
    const adapter = new PrismaMarketplaceCommerceFactsAdapter({
      marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue({ writerMode: 'DRAINING', settlementV2ActivatedAt: null }) },
      purchase: { findMany },
    } as never);
    await expect(adapter.read('package-1', watermark)).resolves.toMatchObject({ refundMetricState: 'DATA_UNAVAILABLE', maturedPaidOrders90d: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('restores a mature V2 cohort while the writer is PAUSED', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      buyerTeamId: `team-${index}`,
      settlementVersion: 'SETTLEMENT_V2',
      status: index === 0 ? 'REFUNDED' : 'SETTLED',
      createdAt: new Date(watermark.getTime() - 30 * day),
      refundableUntil: new Date(watermark.getTime() - 20 * day),
      refundedAt: index === 0 ? new Date(watermark.getTime() - 10 * day) : null,
    }));
    const adapter = new PrismaMarketplaceCommerceFactsAdapter({
      marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue({ writerMode: 'PAUSED', settlementV2ActivatedAt: new Date('2026-01-01T00:00:00Z') }) },
      purchase: { findMany: vi.fn().mockResolvedValue(rows) },
    } as never);
    const result = await adapter.read('package-1', watermark);
    expect(result).toMatchObject({ refundMetricState: 'AVAILABLE', maturedPaidOrders90d: 10, approvedRefunds90d: 1 });
    expect(result.eligibleBuyerTeamIds.has('team-0')).toBe(false);
    expect(result.eligibleBuyerTeamIds.has('team-1')).toBe(true);
  });

  it.each([
    [{ settlementVersion: 'LEGACY_V1', status: 'SETTLED' }, 'legacy order'],
    [{ settlementVersion: 'SETTLEMENT_V2', status: 'REFUND_REQUESTED' }, 'unresolved refund'],
  ])('marks the cohort unavailable for %s', async (override) => {
    const adapter = new PrismaMarketplaceCommerceFactsAdapter({
      marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue({ writerMode: 'SETTLEMENT_V2', settlementV2ActivatedAt: new Date('2026-01-01T00:00:00Z') }) },
      purchase: { findMany: vi.fn().mockResolvedValue([{
        buyerTeamId: 'team-1', settlementVersion: 'SETTLEMENT_V2', status: 'SETTLED',
        createdAt: new Date(watermark.getTime() - 20 * day), refundableUntil: new Date(watermark.getTime() - 10 * day), refundedAt: null,
        ...override,
      }]) },
    } as never);
    await expect(adapter.read('package-1', watermark)).resolves.toMatchObject({ refundMetricState: 'DATA_UNAVAILABLE' });
  });
});

describe('MarketplaceQualityFactsService', () => {
  it('replays append-only ratings and metric facts at one watermark, including security and anomaly signals', async () => {
    const occurredAt = new Date(watermark.getTime() - day);
    const event = (id: string, kind: string, teamId: string | null, metadata: Record<string, unknown> = {}, sourceRecordId = id) => ({
      id, packageId: 'package-1', releaseId: 'release-1', teamId, kind, source: 'WORKFLOW_RUNTIME', sourceRecordId,
      value: null, metadata, occurredAt, recordedAt: occurredAt,
    });
    const events = [
      event('run-1', 'RUN_SUCCEEDED', 'team-1', { control_principal_hash: 'same-control' }),
      event('run-2', 'RUN_SUCCEEDED', 'team-2', { control_principal_hash: 'same-control' }),
      event('run-3', 'RUN_SUCCEEDED', 'team-3', { control_principal_hash: 'same-control' }),
      event('failed-plugin', 'RUN_FAILED', 'team-1', { failure_class: 'PLUGIN' }),
      event('failed-platform', 'RUN_FAILED', 'team-1', { failure_class: 'PLATFORM' }),
      event('install-1', 'INSTALL_SUCCEEDED', 'team-1'),
      event('security-open', 'SECURITY_BLOCKED', null, {}, 'incident-open'),
      event('security-cleared-block', 'SECURITY_BLOCKED', null, {}, 'incident-cleared'),
      event('security-cleared', 'SECURITY_CLEARED', null, {}, 'incident-cleared'),
    ];
    const ratingFindMany = vi.fn().mockResolvedValue([
      { teamId: 'team-1', score: 5, revision: 2, recordedAt: new Date(watermark.getTime() - day) },
      { teamId: 'team-1', score: 1, revision: 1, recordedAt: new Date(watermark.getTime() - 2 * day) },
      { teamId: 'team-2', score: 4, revision: 1, recordedAt: new Date(watermark.getTime() - day) },
      { teamId: 'owner-team', score: 5, revision: 1, recordedAt: new Date(watermark.getTime() - day) },
    ]);
    const metricFindMany = vi.fn().mockResolvedValue(events);
    const prisma = {
      marketplaceListing: { findUnique: vi.fn().mockResolvedValue({
        id: 'listing-1', packageId: 'package-1', currentReleaseId: 'release-1', priceCents: 0,
        currentReleaseActivatedAt: new Date(watermark.getTime() - 10 * day), pointerRevision: 2,
        eligibilityRevision: 3, eligibilityGateDigest: 'a'.repeat(64),
        listingEligibleSince: new Date(watermark.getTime() - 20 * day), releaseEligibleSince: new Date(watermark.getTime() - 10 * day),
        status: 'ACTIVE', qualityBlockedAt: null,
        package: { ownerTeamId: 'owner-team', governanceStatus: 'ACTIVE' },
        currentRelease: { id: 'release-1', status: 'PUBLISHED', marketReviewStatus: 'APPROVED', aiPolicyVersion: 1, aiPolicyStatus: 'PASSED' },
      }) },
      marketplaceMetricEvent: { findMany: metricFindMany },
      marketplaceRatingRevision: { findMany: ratingFindMany },
      team: { findMany: vi.fn().mockResolvedValue([{ id: 'team-1' }, { id: 'team-2' }, { id: 'team-3' }, { id: 'owner-team' }]) },
    };
    const commerce = { read: vi.fn() };
    const service = new MarketplaceQualityFactsService(prisma as never, commerce as never);
    const result = await service.load('package-1', watermark);
    expect(metricFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ recordedAt: { lte: watermark } }) }));
    expect(ratingFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { packageId: 'package-1', recordedAt: { lte: watermark } } }));
    expect(result.facts).toMatchObject({
      activeTeams30d: 3,
      observedRuns30d: 4,
      failedRuns30d: 1,
      ratingTeams: 2,
      ratingSum: 9,
      securityIncidents90d: 1,
      hardGateEligible: false,
      anomalyReviewRequired: true,
      refundMetricState: 'NOT_APPLICABLE',
    });
    expect(commerce.read).not.toHaveBeenCalled();
  });
});

