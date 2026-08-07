import {
  MARKETPLACE_QUALITY_POLICY_V1,
  type MarketplaceQualityMetricSummary,
  type MarketplaceQualityReasonDetail,
  type MarketplaceRefundMetricState,
} from '@lingfang/contract';

const DAY_MS = 24 * 60 * 60 * 1000;

export type MarketplaceQualityEvaluationInput = {
  factWatermark: Date;
  hardGateEligible: boolean;
  listingEligibleSince: Date | null;
  releaseEligibleSince: Date | null;
  currentReleaseActivatedAt: Date | null;
  activeTeams30d: number;
  installTeams30d: number;
  observedRuns30d: number;
  failedRuns30d: number;
  ratingTeams: number;
  ratingSum: number;
  paid: boolean;
  refundMetricState: MarketplaceRefundMetricState;
  maturedPaidOrders90d: number;
  approvedRefunds90d: number;
  securityIncidents90d: number;
  anomalyReviewRequired: boolean;
  qualityBlocked: boolean;
};

export type MarketplaceQualityEvaluation = {
  tier: 'LISTED' | 'QUALITY';
  autoQualified: boolean;
  metrics: MarketplaceQualityMetricSummary;
  reasons: MarketplaceQualityReasonDetail[];
};

function nonnegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`marketplace_quality_invalid_${name}`);
  return value;
}

function elapsedDays(since: Date | null, watermark: Date): number {
  if (!since || Number.isNaN(since.getTime()) || since > watermark) return 0;
  return Math.floor((watermark.getTime() - since.getTime()) / DAY_MS);
}

function laterDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function evaluateMarketplaceQualityV1(
  input: MarketplaceQualityEvaluationInput
): MarketplaceQualityEvaluation {
  if (Number.isNaN(input.factWatermark.getTime()))
    throw new Error('marketplace_quality_invalid_watermark');
  const activeTeams = nonnegativeInteger('active_teams', input.activeTeams30d);
  const installTeams = nonnegativeInteger('install_teams', input.installTeams30d);
  const observedRuns = nonnegativeInteger('observed_runs', input.observedRuns30d);
  const failedRuns = nonnegativeInteger('failed_runs', input.failedRuns30d);
  const ratingTeams = nonnegativeInteger('rating_teams', input.ratingTeams);
  const ratingSum = nonnegativeInteger('rating_sum', input.ratingSum);
  const maturedOrders = nonnegativeInteger('matured_orders', input.maturedPaidOrders90d);
  const approvedRefunds = nonnegativeInteger('approved_refunds', input.approvedRefunds90d);
  const securityIncidents = nonnegativeInteger('security_incidents', input.securityIncidents90d);
  if (failedRuns > observedRuns || approvedRefunds > maturedOrders || ratingSum > ratingTeams * 5)
    throw new Error('marketplace_quality_inconsistent_counts');
  if (
    (input.paid && input.refundMetricState === 'NOT_APPLICABLE') ||
    (!input.paid && input.refundMetricState !== 'NOT_APPLICABLE')
  ) {
    throw new Error('marketplace_quality_invalid_refund_state');
  }

  const policy = MARKETPLACE_QUALITY_POLICY_V1;
  const listingAgeDays = elapsedDays(input.listingEligibleSince, input.factWatermark);
  const releaseAgeDays = elapsedDays(
    laterDate(input.releaseEligibleSince, input.currentReleaseActivatedAt),
    input.factWatermark
  );
  const failureRateBps = observedRuns > 0 ? Math.floor((failedRuns * 10_000) / observedRuns) : null;
  const averageRatingTenths = ratingTeams > 0 ? Math.floor((ratingSum * 10) / ratingTeams) : null;
  const refundRateBps =
    input.paid &&
    input.refundMetricState === 'AVAILABLE' &&
    maturedOrders >= policy.matured_paid_orders_90d
      ? Math.floor((approvedRefunds * 10_000) / maturedOrders)
      : null;
  const reasons: MarketplaceQualityReasonDetail[] = [];
  const reason = (
    code: MarketplaceQualityReasonDetail['code'],
    actual: number | null,
    threshold: number | null
  ) => reasons.push({ code, actual, threshold });

  if (!input.hardGateEligible) reason('hard_gate_failed', null, null);
  if (listingAgeDays < policy.listing_age_days)
    reason('listing_age_insufficient', listingAgeDays, policy.listing_age_days);
  if (releaseAgeDays < policy.current_release_activation_age_days)
    reason('release_age_insufficient', releaseAgeDays, policy.current_release_activation_age_days);
  if (activeTeams < policy.active_teams_30d)
    reason('insufficient_active_teams', activeTeams, policy.active_teams_30d);
  if (observedRuns < policy.observed_runs_30d)
    reason('insufficient_observed_runs', observedRuns, policy.observed_runs_30d);
  else if (failureRateBps !== null && failureRateBps > policy.max_failure_rate_bps)
    reason('failure_rate_high', failureRateBps, policy.max_failure_rate_bps);
  if (ratingTeams < policy.rating_teams)
    reason('insufficient_rating_teams', ratingTeams, policy.rating_teams);
  else if (averageRatingTenths !== null && averageRatingTenths < policy.min_average_rating_tenths)
    reason('average_rating_low', averageRatingTenths, policy.min_average_rating_tenths);
  if (input.paid) {
    if (input.refundMetricState === 'DATA_UNAVAILABLE')
      reason('refund_data_unavailable', null, null);
    else if (
      input.refundMetricState === 'INSUFFICIENT_SAMPLE' ||
      maturedOrders < policy.matured_paid_orders_90d
    )
      reason('insufficient_matured_paid_orders', maturedOrders, policy.matured_paid_orders_90d);
    else if (refundRateBps !== null && refundRateBps > policy.max_refund_rate_bps)
      reason('refund_rate_high', refundRateBps, policy.max_refund_rate_bps);
  }
  if (securityIncidents > 0) reason('security_blocked', securityIncidents, 0);
  if (input.anomalyReviewRequired) reason('anomaly_review_required', null, null);
  if (input.qualityBlocked) reason('quality_blocked', null, null);

  const metrics: MarketplaceQualityMetricSummary = {
    listing_age_days: listingAgeDays,
    current_release_age_days: releaseAgeDays,
    active_teams_30d: activeTeams,
    install_teams_30d: installTeams,
    observed_runs_30d: observedRuns,
    failed_runs_30d: failedRuns,
    failure_rate_bps: failureRateBps,
    rating_teams: ratingTeams,
    rating_sum: ratingSum,
    average_rating_tenths: averageRatingTenths,
    refund_metric_state: input.refundMetricState,
    matured_paid_orders_90d: maturedOrders,
    approved_refunds_90d: approvedRefunds,
    refund_rate_bps: refundRateBps,
    security_incidents_90d: securityIncidents,
  };
  return {
    tier: reasons.length === 0 ? 'QUALITY' : 'LISTED',
    autoQualified: reasons.length === 0,
    metrics,
    reasons,
  };
}
