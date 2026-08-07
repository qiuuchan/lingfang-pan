import type { MarketplaceCategory, MarketplaceQualityTier } from '@lingfang/contract';

export type MarketplaceRecommendationCandidate = {
  packageId: string;
  category: MarketplaceCategory;
  tier: MarketplaceQualityTier;
  activeTeams30d: number;
  installTeams30d: number;
  ratingAverageTenths: number;
  featuredRank: number | null;
  featuredAt: Date | null;
  featuredUntil: Date | null;
  qualityQualifiedAt: Date | null;
};

const packageOrder = (
  a: MarketplaceRecommendationCandidate,
  b: MarketplaceRecommendationCandidate
) => a.packageId.localeCompare(b.packageId);

export function featuredRecommendations(
  candidates: readonly MarketplaceRecommendationCandidate[],
  now: Date
): MarketplaceRecommendationCandidate[] {
  return candidates
    .filter(
      (item) =>
        item.tier === 'FEATURED' &&
        item.featuredAt &&
        (!item.featuredUntil || item.featuredUntil > now)
    )
    .sort(
      (a, b) =>
        (a.featuredRank ?? Number.MAX_SAFE_INTEGER) - (b.featuredRank ?? Number.MAX_SAFE_INTEGER) ||
        (b.featuredAt?.getTime() ?? 0) - (a.featuredAt?.getTime() ?? 0) ||
        packageOrder(a, b)
    );
}

export function categoryPopularRecommendations(
  candidates: readonly MarketplaceRecommendationCandidate[],
  category: MarketplaceCategory
): MarketplaceRecommendationCandidate[] {
  return candidates
    .filter((item) => item.category === category)
    .sort(
      (a, b) =>
        b.activeTeams30d - a.activeTeams30d ||
        b.installTeams30d - a.installTeams30d ||
        b.ratingAverageTenths - a.ratingAverageTenths ||
        packageOrder(a, b)
    );
}

export function recentQualityRecommendations(
  candidates: readonly MarketplaceRecommendationCandidate[],
  now: Date
): MarketplaceRecommendationCandidate[] {
  const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  return candidates
    .filter(
      (item) =>
        (item.tier === 'QUALITY' || item.tier === 'FEATURED') &&
        (item.qualityQualifiedAt?.getTime() ?? 0) >= cutoff
    )
    .sort(
      (a, b) =>
        (b.qualityQualifiedAt?.getTime() ?? 0) - (a.qualityQualifiedAt?.getTime() ?? 0) ||
        packageOrder(a, b)
    );
}
