import { describe, expect, it, vi } from 'vitest';
import { MarketplaceQualityComputationService, type MarketplaceQualityComputationRepository, type MarketplaceQualityComputeRequest } from './marketplace-quality-computation.service';

const watermark = new Date('2026-07-16T00:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

function request(overrides: Partial<MarketplaceQualityComputeRequest> = {}): MarketplaceQualityComputeRequest {
  return {
    jobKey: 'quality:v1:daily:2026-07-16:pkg-1:p2:e3', kind: 'DAILY', factWatermark: watermark,
    scope: {
      listingId: 'listing-1', packageId: 'pkg-1', releaseId: 'rel-1',
      currentReleaseActivatedAt: new Date(watermark.getTime() - 8 * day), pointerRevision: 2,
      eligibilityRevision: 3, eligibilityGateDigest: 'a'.repeat(64),
      listingEligibleSince: new Date(watermark.getTime() - 15 * day),
      releaseEligibleSince: new Date(watermark.getTime() - 8 * day),
    },
    facts: {
      hardGateEligible: true, activeTeams30d: 20, installTeams30d: 20,
      observedRuns30d: 50, failedRuns30d: 1, ratingTeams: 10, ratingSum: 43,
      paid: false, refundMetricState: 'NOT_APPLICABLE', maturedPaidOrders90d: 0,
      approvedRefunds90d: 0, securityIncidents90d: 0, anomalyReviewRequired: false, qualityBlocked: false,
    },
    ...overrides,
  };
}

function repository(overrides: Partial<MarketplaceQualityComputationRepository> = {}): MarketplaceQualityComputationRepository {
  return {
    claim: vi.fn(async () => ({ id: 'computation-1', status: 'RUNNING', snapshotId: null, created: true })),
    commit: vi.fn(async () => ({ snapshotId: 'snapshot-1', projected: true })),
    fail: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('MarketplaceQualityComputationService', () => {
  it('uses policy/pointer/eligibility in daily keys and evaluates before commit', async () => {
    const repo = repository();
    const service = new MarketplaceQualityComputationService(repo);
    const input = request();
    expect(service.dailyJobKey(input.scope, watermark)).toBe(input.jobKey);
    const result = await service.compute(input);
    expect(result).toEqual({ computationId: 'computation-1', snapshotId: 'snapshot-1', reused: false, projected: true });
    expect(repo.commit).toHaveBeenCalledWith(input, 'computation-1', expect.objectContaining({ autoQualified: true, tier: 'QUALITY' }));
  });

  it('reuses a terminal computation for the same jobKey without creating another snapshot revision', async () => {
    const commit = vi.fn();
    const service = new MarketplaceQualityComputationService(repository({
      claim: vi.fn(async () => ({ id: 'computation-1', status: 'SUCCEEDED', snapshotId: 'snapshot-1', created: false })), commit,
    }));
    await expect(service.compute(request())).resolves.toEqual({
      computationId: 'computation-1', snapshotId: 'snapshot-1', reused: true, projected: false,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('records a failed job and preserves the previous listing projection', async () => {
    const fail = vi.fn(async () => undefined);
    const service = new MarketplaceQualityComputationService(repository({
      commit: vi.fn(async () => { throw new Error('commerce_facts_unavailable'); }), fail,
    }));
    await expect(service.compute(request())).rejects.toThrow('commerce_facts_unavailable');
    expect(fail).toHaveBeenCalledWith('computation-1', 'commerce_facts_unavailable', expect.any(Date));
  });

  it('gives independent manual requests independent job identities', () => {
    const service = new MarketplaceQualityComputationService(repository());
    const scope = request().scope;
    expect(service.manualJobKey(scope, 'request-a')).not.toBe(service.manualJobKey(scope, 'request-b'));
  });
});

