import { describe, expect, it } from 'vitest';
import {
  evaluateMarketplaceQualityV1,
  type MarketplaceQualityEvaluationInput,
} from './marketplace-quality-evaluator';

const DAY = 24 * 60 * 60 * 1000;
const watermark = new Date('2026-07-16T00:00:00.000Z');

function eligible(
  overrides: Partial<MarketplaceQualityEvaluationInput> = {}
): MarketplaceQualityEvaluationInput {
  return {
    factWatermark: watermark,
    hardGateEligible: true,
    listingEligibleSince: new Date(watermark.getTime() - 14 * DAY),
    releaseEligibleSince: new Date(watermark.getTime() - 7 * DAY),
    currentReleaseActivatedAt: new Date(watermark.getTime() - 7 * DAY),
    activeTeams30d: 20,
    installTeams30d: 3,
    observedRuns30d: 50,
    failedRuns30d: 1,
    ratingTeams: 10,
    ratingSum: 43,
    paid: false,
    refundMetricState: 'NOT_APPLICABLE',
    maturedPaidOrders90d: 0,
    approvedRefunds90d: 0,
    securityIncidents90d: 0,
    anomalyReviewRequired: false,
    qualityBlocked: false,
    ...overrides,
  };
}

describe('evaluateMarketplaceQualityV1', () => {
  it('qualifies at every exact free-plugin threshold using integer rates', () => {
    const result = evaluateMarketplaceQualityV1(eligible());
    expect(result).toMatchObject({ tier: 'QUALITY', autoQualified: true, reasons: [] });
    expect(result.metrics).toMatchObject({
      failure_rate_bps: 200,
      average_rating_tenths: 43,
      refund_metric_state: 'NOT_APPLICABLE',
    });
  });

  it('reports each insufficient sample instead of treating empty denominators as zero success', () => {
    const result = evaluateMarketplaceQualityV1(
      eligible({
        listingEligibleSince: new Date(watermark.getTime() - 14 * DAY + 1),
        releaseEligibleSince: new Date(watermark.getTime() - 7 * DAY + 1),
        activeTeams30d: 0,
        observedRuns30d: 0,
        failedRuns30d: 0,
        ratingTeams: 0,
        ratingSum: 0,
      })
    );
    expect(result.tier).toBe('LISTED');
    expect(result.metrics.failure_rate_bps).toBeNull();
    expect(result.metrics.average_rating_tenths).toBeNull();
    expect(result.reasons.map((item) => item.code)).toEqual([
      'listing_age_insufficient',
      'release_age_insufficient',
      'insufficient_active_teams',
      'insufficient_observed_runs',
      'insufficient_rating_teams',
    ]);
  });

  it('uses the later release activation/eligibility epoch and enforces failure/rating boundaries', () => {
    const result = evaluateMarketplaceQualityV1(
      eligible({
        currentReleaseActivatedAt: new Date(watermark.getTime() - 30 * DAY),
        releaseEligibleSince: new Date(watermark.getTime() - 6 * DAY),
        failedRuns30d: 2,
        ratingSum: 42,
      })
    );
    expect(result.reasons.map((item) => item.code)).toEqual([
      'release_age_insufficient',
      'failure_rate_high',
      'average_rating_low',
    ]);
  });

  it('requires paid refund facts and accepts exactly five percent only with a mature cohort', () => {
    const exact = evaluateMarketplaceQualityV1(
      eligible({
        paid: true,
        refundMetricState: 'AVAILABLE',
        maturedPaidOrders90d: 20,
        approvedRefunds90d: 1,
      })
    );
    expect(exact.tier).toBe('QUALITY');
    expect(exact.metrics.refund_rate_bps).toBe(500);

    const high = evaluateMarketplaceQualityV1(
      eligible({
        paid: true,
        refundMetricState: 'AVAILABLE',
        maturedPaidOrders90d: 20,
        approvedRefunds90d: 2,
      })
    );
    expect(high.reasons.map((item) => item.code)).toContain('refund_rate_high');

    const unavailable = evaluateMarketplaceQualityV1(
      eligible({
        paid: true,
        refundMetricState: 'DATA_UNAVAILABLE',
        maturedPaidOrders90d: 0,
        approvedRefunds90d: 0,
      })
    );
    expect(unavailable.reasons.map((item) => item.code)).toContain('refund_data_unavailable');
  });

  it('keeps hard gates, security, anomaly review and manual block independent from metrics', () => {
    const result = evaluateMarketplaceQualityV1(
      eligible({
        hardGateEligible: false,
        securityIncidents90d: 1,
        anomalyReviewRequired: true,
        qualityBlocked: true,
      })
    );
    expect(result.reasons.map((item) => item.code)).toEqual([
      'hard_gate_failed',
      'security_blocked',
      'anomaly_review_required',
      'quality_blocked',
    ]);
  });

  it('rejects inconsistent aggregate facts', () => {
    expect(() => evaluateMarketplaceQualityV1(eligible({ failedRuns30d: 51 }))).toThrow(
      'inconsistent_counts'
    );
    expect(() => evaluateMarketplaceQualityV1(eligible({ ratingSum: 51 }))).toThrow(
      'inconsistent_counts'
    );
    expect(() =>
      evaluateMarketplaceQualityV1(eligible({ paid: true, refundMetricState: 'NOT_APPLICABLE' }))
    ).toThrow('invalid_refund_state');
  });
});
