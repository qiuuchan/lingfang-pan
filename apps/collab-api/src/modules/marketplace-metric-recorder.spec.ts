import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  MarketplaceMetricRecorder,
  PrismaMarketplaceMetricRepository,
} from './marketplace-metric-recorder';

describe('MarketplaceMetricRecorder', () => {
  it('owns occurredAt and forwards one idempotent fact to the repository', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    const append = vi.fn(async (fact) => ({ metric: { id: 'metric-1', ...fact }, created: true }));
    const recorder = new MarketplaceMetricRecorder({ append });
    const result = await recorder.record(
      {
        idempotencyKey: 'workflow-attempt:1',
        kind: 'RUN_SUCCEEDED',
        source: 'WORKFLOW_RUNTIME',
        packageId: 'pkg-1',
        releaseId: 'rel-1',
        sourceRecordId: 'attempt-1',
        teamId: 'team-1',
      },
      now
    );
    expect(result.created).toBe(true);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: now }));
  });

  it('rejects kind/source mismatches and caller-supplied numeric payloads', async () => {
    const recorder = new MarketplaceMetricRecorder({ append: vi.fn() });
    await expect(
      recorder.record({
        idempotencyKey: 'purchase:1',
        kind: 'PURCHASED',
        source: 'DESKTOP_HOST',
        packageId: 'pkg-1',
        releaseId: 'rel-1',
        sourceRecordId: 'purchase-1',
      })
    ).rejects.toThrow('marketplace_metric_source_mismatch');
    await expect(
      recorder.record({
        idempotencyKey: 'run:1',
        kind: 'RUN_SUCCEEDED',
        source: 'CLOUD_RUNTIME',
        packageId: 'pkg-1',
        releaseId: 'rel-1',
        sourceRecordId: 'run-1',
        value: 100,
      })
    ).rejects.toThrow('marketplace_metric_unexpected_value');
  });

  it('accepts only bounded integer ratings', async () => {
    const recorder = new MarketplaceMetricRecorder({ append: vi.fn() });
    await expect(
      recorder.record({
        idempotencyKey: 'rating:1',
        kind: 'RATING_CHANGED',
        source: 'REGISTRY',
        packageId: 'pkg-1',
        releaseId: 'rel-1',
        sourceRecordId: 'rating-revision-1',
        value: 6,
      })
    ).rejects.toThrow('marketplace_metric_invalid_rating');
  });
});

describe('PrismaMarketplaceMetricRepository', () => {
  it('persists the canonical event and returns the server row', async () => {
    const create = vi.fn(async ({ data }) => ({
      id: 'metric-1',
      ...data,
      teamId: data.teamId ?? null,
      value: data.value ?? null,
    }));
    const repository = new PrismaMarketplaceMetricRepository({
      marketplaceMetricEvent: { create },
    } as never);
    const occurredAt = new Date('2026-07-16T00:00:00.000Z');
    const result = await repository.append({
      idempotencyKey: 'cloud-run:1',
      kind: 'RUN_SUCCEEDED',
      source: 'CLOUD_RUNTIME',
      packageId: 'pkg-1',
      releaseId: 'rel-1',
      teamId: 'team-1',
      sourceRecordId: 'run-1',
      occurredAt,
    });
    expect(result.created).toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ occurredAt, sourceRecordId: 'run-1' }),
    });
  });

  it('returns an identical existing event after a unique-key race and rejects conflicting replay', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: '7.8.0',
    });
    const base = {
      id: 'metric-1',
      idempotencyKey: 'workflow:1',
      kind: 'RUN_FAILED' as const,
      source: 'WORKFLOW_RUNTIME' as const,
      packageId: 'pkg-1',
      releaseId: 'rel-1',
      teamId: 'team-1',
      sourceRecordId: 'attempt-1',
      value: null,
      occurredAt: new Date('2026-07-16T00:00:00.000Z'),
    };
    const findUnique = vi.fn(async () => base);
    const repository = new PrismaMarketplaceMetricRepository({
      marketplaceMetricEvent: {
        create: vi.fn(async () => {
          throw duplicate;
        }),
        findUnique,
      },
    } as never);
    const fact = {
      idempotencyKey: base.idempotencyKey,
      kind: base.kind,
      source: base.source,
      packageId: base.packageId,
      releaseId: base.releaseId,
      teamId: base.teamId,
      sourceRecordId: base.sourceRecordId,
      occurredAt: base.occurredAt,
    };
    await expect(repository.append(fact)).resolves.toMatchObject({ created: false });
    findUnique.mockResolvedValueOnce({ ...base, releaseId: 'rel-other' });
    await expect(repository.append(fact)).rejects.toThrow(
      'marketplace_metric_idempotency_conflict'
    );
  });

  it('commits a security fact and closes quality eligibility epochs in the same transaction', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    let listing: any = {
      id: 'listing-1',
      packageId: 'pkg-1',
      status: 'ACTIVE',
      currentReleaseId: 'rel-1',
      currentReleaseActivatedAt: new Date('2026-06-01T00:00:00Z'),
      pointerRevision: 1,
      eligibilityRevision: 1,
      eligibilityGateDigest: 'a'.repeat(64),
      listingEligibleSince: new Date('2026-06-01T00:00:00Z'),
      releaseEligibleSince: new Date('2026-06-01T00:00:00Z'),
      qualityTier: 'QUALITY',
      qualitySnapshotId: 'snapshot-1',
      qualityQualifiedAt: new Date('2026-07-01T00:00:00Z'),
      package: { governanceStatus: 'ACTIVE' },
      currentRelease: {
        id: 'rel-1',
        status: 'PUBLISHED',
        marketReviewStatus: 'APPROVED',
        aiPolicyVersion: 1,
        aiPolicyStatus: 'PASSED',
      },
    };
    const epochUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx: any = {
      marketplaceMetricEvent: {
        create: vi.fn(async ({ data }) => ({ id: 'metric-security', ...data })),
        findMany: vi
          .fn()
          .mockResolvedValue([{ kind: 'SECURITY_BLOCKED', sourceRecordId: 'incident-1' }]),
      },
      marketplaceListing: {
        findUnique: vi.fn().mockImplementation(async () => listing),
        updateMany: vi.fn(async ({ data }) => {
          listing = { ...listing, ...data };
          return { count: 1 };
        }),
      },
      marketplaceListingReleaseActivation: {
        findFirst: vi.fn().mockResolvedValue({ releaseId: 'rel-1', pointerRevision: 1 }),
        create: vi.fn(),
      },
      marketplaceListingEligibilityEpoch: { updateMany: epochUpdate, create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((operation) => operation(tx)),
      marketplaceMetricEvent: { findUnique: vi.fn() },
    };
    const repository = new PrismaMarketplaceMetricRepository(prisma as never);
    await repository.append({
      idempotencyKey: 'security:incident-1:block',
      kind: 'SECURITY_BLOCKED',
      source: 'SECURITY',
      packageId: 'pkg-1',
      releaseId: 'rel-1',
      sourceRecordId: 'incident-1',
      occurredAt: now,
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(listing).toMatchObject({
      listingEligibleSince: null,
      releaseEligibleSince: null,
      qualityTier: 'LISTED',
      qualitySnapshotId: null,
    });
    expect(epochUpdate).toHaveBeenCalledTimes(2);
  });
});
