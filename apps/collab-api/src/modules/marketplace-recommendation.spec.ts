import { describe, expect, it } from 'vitest';
import {
  categoryPopularRecommendations,
  featuredRecommendations,
  recentQualityRecommendations,
  type MarketplaceRecommendationCandidate,
} from './marketplace-recommendation';

const now = new Date('2026-07-16T00:00:00.000Z');
function candidate(packageId: string, overrides: Partial<MarketplaceRecommendationCandidate> = {}): MarketplaceRecommendationCandidate {
  return {
    packageId, category: 'DEV', tier: 'LISTED', activeTeams30d: 0, installTeams30d: 0,
    ratingAverageTenths: 0, featuredRank: null, featuredAt: null, featuredUntil: null, qualityQualifiedAt: null,
    ...overrides,
  };
}

describe('marketplace recommendation ordering', () => {
  it('orders active featured entries by explicit rank, time and stable package ID', () => {
    const items = [
      candidate('b', { tier: 'FEATURED', featuredRank: 2, featuredAt: new Date('2026-07-15T00:00:00Z') }),
      candidate('c', { tier: 'FEATURED', featuredRank: 1, featuredAt: new Date('2026-07-14T00:00:00Z') }),
      candidate('a', { tier: 'FEATURED', featuredRank: 1, featuredAt: new Date('2026-07-15T00:00:00Z') }),
      candidate('expired', { tier: 'FEATURED', featuredRank: 0, featuredAt: new Date('2026-07-01T00:00:00Z'), featuredUntil: now }),
    ];
    expect(featuredRecommendations(items, now).map((item) => item.packageId)).toEqual(['a', 'c', 'b']);
  });

  it('orders category popular only by public usage/rating fields and stable package ID', () => {
    const items = [
      candidate('d', { activeTeams30d: 20, installTeams30d: 2, ratingAverageTenths: 50 }),
      candidate('c', { activeTeams30d: 20, installTeams30d: 3, ratingAverageTenths: 40 }),
      candidate('b', { activeTeams30d: 20, installTeams30d: 3, ratingAverageTenths: 45 }),
      candidate('a', { activeTeams30d: 20, installTeams30d: 3, ratingAverageTenths: 45 }),
      candidate('media', { category: 'MEDIA', activeTeams30d: 999 }),
    ];
    expect(categoryPopularRecommendations(items, 'DEV').map((item) => item.packageId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('recent quality uses the 30-day qualification instant and excludes listed entries', () => {
    const items = [
      candidate('new', { tier: 'QUALITY', qualityQualifiedAt: new Date('2026-07-15T00:00:00Z') }),
      candidate('featured', { tier: 'FEATURED', qualityQualifiedAt: new Date('2026-07-14T00:00:00Z') }),
      candidate('old', { tier: 'QUALITY', qualityQualifiedAt: new Date('2026-06-15T23:59:59Z') }),
      candidate('listed', { tier: 'LISTED', qualityQualifiedAt: new Date('2026-07-16T00:00:00Z') }),
    ];
    expect(recentQualityRecommendations(items, now).map((item) => item.packageId)).toEqual(['new', 'featured']);
  });
});
