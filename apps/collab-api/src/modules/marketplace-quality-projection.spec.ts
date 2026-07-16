import { describe, expect, it, vi } from 'vitest';
import { canProjectQualitySnapshot, isNewerQualitySnapshot, marketplaceQualityGateDigest, projectMarketplaceQualityGateTx } from './marketplace-quality-projection';

describe('marketplace quality projection CAS', () => {
  it('canonicalizes the full hard-gate fact set', () => {
    const facts = {
      listingStatus: 'ACTIVE', currentReleaseId: 'rel-1', currentReleaseStatus: 'PUBLISHED',
      marketReviewStatus: 'APPROVED', aiPolicyVersion: 1, aiPolicyStatus: 'PASSED',
      securityBlocked: false, pointerRevision: 2, eligibilityRevision: 3,
    };
    const digest = marketplaceQualityGateDigest(facts);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(marketplaceQualityGateDigest({ ...facts, securityBlocked: true })).not.toBe(digest);
    expect(marketplaceQualityGateDigest({ ...facts, pointerRevision: 3 })).not.toBe(digest);
  });

  it('orders snapshots by watermark then computation revision', () => {
    const current = { factWatermark: new Date('2026-07-16T00:00:00Z'), computationRevision: 2n };
    expect(isNewerQualitySnapshot({ ...current, computationRevision: 3n }, current)).toBe(true);
    expect(isNewerQualitySnapshot({ factWatermark: new Date('2026-07-15T00:00:00Z'), computationRevision: 99n }, current)).toBe(false);
  });

  it('rejects a late job after release, epoch or gate facts change', () => {
    const base = {
      expectedReleaseId: 'rel-1', expectedPointerRevision: 2, expectedEligibilityRevision: 3,
      expectedGateDigest: 'a'.repeat(64), currentReleaseId: 'rel-1', currentPointerRevision: 2,
      currentEligibilityRevision: 3, currentGateDigest: 'a'.repeat(64),
      candidate: { factWatermark: new Date('2026-07-16T00:00:00Z'), computationRevision: 2n },
      current: { factWatermark: new Date('2026-07-15T00:00:00Z'), computationRevision: 1n },
    };
    expect(canProjectQualitySnapshot(base)).toBe(true);
    expect(canProjectQualitySnapshot({ ...base, currentReleaseId: 'rel-2' })).toBe(false);
    expect(canProjectQualitySnapshot({ ...base, currentEligibilityRevision: 4 })).toBe(false);
    expect(canProjectQualitySnapshot({ ...base, currentGateDigest: 'b'.repeat(64) })).toBe(false);
  });

  it('atomically starts pointer activation and both eligibility epochs for a newly approved listing', async () => {
    const now = new Date('2026-07-16T00:00:00Z');
    let listing: any = {
      id: 'listing-1', packageId: 'package-1', status: 'ACTIVE', currentReleaseId: 'release-1',
      currentReleaseActivatedAt: null, pointerRevision: 0, eligibilityRevision: 0, eligibilityGateDigest: '',
      listingEligibleSince: null, releaseEligibleSince: null, qualityTier: 'LISTED', qualitySnapshotId: null, qualityQualifiedAt: null,
      package: { governanceStatus: 'ACTIVE' },
      currentRelease: { id: 'release-1', status: 'PUBLISHED', marketReviewStatus: 'APPROVED', aiPolicyVersion: 1, aiPolicyStatus: 'PASSED' },
    };
    const activationCreate = vi.fn(async ({ data }) => data);
    const epochCreate = vi.fn(async ({ data }) => data);
    const tx: any = {
      marketplaceListing: {
        findUnique: vi.fn(async () => listing),
        updateMany: vi.fn(async ({ data }) => { listing = { ...listing, ...data }; return { count: 1 }; }),
      },
      marketplaceListingReleaseActivation: { findFirst: vi.fn(async () => null), create: activationCreate },
      marketplaceListingEligibilityEpoch: { updateMany: vi.fn(async () => ({ count: 0 })), create: epochCreate },
    };
    const result = await projectMarketplaceQualityGateTx(tx, 'package-1', 'RELEASE_APPROVED', now);
    expect(result).toMatchObject({ hardGateEligible: true, pointerChanged: true, pointerRevision: 1, eligibilityRevision: 1 });
    expect(listing).toMatchObject({ currentReleaseActivatedAt: now, listingEligibleSince: now, releaseEligibleSince: now, pointerRevision: 1, eligibilityRevision: 1 });
    expect(activationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ releaseId: 'release-1', pointerRevision: 1, activatedAt: now }) });
    expect(epochCreate).toHaveBeenCalledTimes(2);
  });

  it('preserves the listing epoch but resets the release epoch when the current pointer changes', async () => {
    const now = new Date('2026-07-16T00:00:00Z');
    const listingSince = new Date('2026-06-01T00:00:00Z');
    let listing: any = {
      id: 'listing-1', packageId: 'package-1', status: 'ACTIVE', currentReleaseId: 'release-2',
      currentReleaseActivatedAt: new Date('2026-06-10T00:00:00Z'), pointerRevision: 2, eligibilityRevision: 4,
      eligibilityGateDigest: 'a'.repeat(64), listingEligibleSince: listingSince, releaseEligibleSince: new Date('2026-06-10T00:00:00Z'),
      qualityTier: 'QUALITY', qualitySnapshotId: 'snapshot-1', qualityQualifiedAt: new Date('2026-07-01T00:00:00Z'),
      package: { governanceStatus: 'ACTIVE' },
      currentRelease: { id: 'release-2', status: 'PUBLISHED', marketReviewStatus: 'APPROVED', aiPolicyVersion: 1, aiPolicyStatus: 'PASSED' },
    };
    const epochUpdate = vi.fn(async () => ({ count: 1 }));
    const epochCreate = vi.fn(async ({ data }) => data);
    const tx: any = {
      marketplaceListing: { findUnique: vi.fn(async () => listing), updateMany: vi.fn(async ({ data }) => { listing = { ...listing, ...data }; return { count: 1 }; }) },
      marketplaceListingReleaseActivation: { findFirst: vi.fn(async () => ({ releaseId: 'release-1', pointerRevision: 2 })), create: vi.fn(async ({ data }) => data) },
      marketplaceListingEligibilityEpoch: { updateMany: epochUpdate, create: epochCreate },
    };
    await projectMarketplaceQualityGateTx(tx, 'package-1', 'RELEASE_APPROVED', now);
    expect(listing).toMatchObject({ pointerRevision: 3, eligibilityRevision: 5, listingEligibleSince: listingSince, releaseEligibleSince: now, qualityTier: 'LISTED', qualitySnapshotId: null });
    expect(epochUpdate).toHaveBeenCalledTimes(1);
    expect(epochUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ kind: 'RELEASE' }) }));
    expect(epochCreate).toHaveBeenCalledTimes(1);
  });

  it('closes both epochs and clears the active quality projection when a hard gate fails', async () => {
    const now = new Date('2026-07-16T00:00:00Z');
    let listing: any = {
      id: 'listing-1', packageId: 'package-1', status: 'DELISTED', currentReleaseId: 'release-1',
      currentReleaseActivatedAt: new Date('2026-06-01T00:00:00Z'), pointerRevision: 1, eligibilityRevision: 1,
      eligibilityGateDigest: 'a'.repeat(64), listingEligibleSince: new Date('2026-06-01T00:00:00Z'), releaseEligibleSince: new Date('2026-06-01T00:00:00Z'),
      qualityTier: 'FEATURED', qualitySnapshotId: 'snapshot-1', qualityQualifiedAt: new Date('2026-07-01T00:00:00Z'),
      package: { governanceStatus: 'ACTIVE' },
      currentRelease: { id: 'release-1', status: 'PUBLISHED', marketReviewStatus: 'APPROVED', aiPolicyVersion: 1, aiPolicyStatus: 'PASSED' },
    };
    const epochUpdate = vi.fn(async () => ({ count: 1 }));
    const tx: any = {
      marketplaceListing: { findUnique: vi.fn(async () => listing), updateMany: vi.fn(async ({ data }) => { listing = { ...listing, ...data }; return { count: 1 }; }) },
      marketplaceListingReleaseActivation: { findFirst: vi.fn(async () => ({ releaseId: 'release-1', pointerRevision: 1 })), create: vi.fn() },
      marketplaceListingEligibilityEpoch: { updateMany: epochUpdate, create: vi.fn() },
    };
    await projectMarketplaceQualityGateTx(tx, 'package-1', 'LISTING_DELISTED', now);
    expect(listing).toMatchObject({ eligibilityRevision: 2, listingEligibleSince: null, releaseEligibleSince: null, qualityTier: 'LISTED', qualitySnapshotId: null, qualityQualifiedAt: null });
    expect(epochUpdate).toHaveBeenCalledTimes(2);
  });
});
