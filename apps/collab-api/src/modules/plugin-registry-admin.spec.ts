import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY } from './auth.decorators';
import { AdminPluginPackageListQueryDto } from './dto/plugin-registry.dto';
import {
  ADMIN_PACKAGE_LIST_SELECT,
  ADMIN_RELEASE_CORE_SELECT,
  ADMIN_RELEASE_SUMMARY_SELECT,
} from './plugin-registry-admin';
import { AdminPluginRegistryController } from './plugin-registry.controller';
import { PluginRegistryService } from './plugin-registry.service';

const now = new Date('2026-07-12T00:00:00.000Z');
const packageId = '11111111-1111-4111-8111-111111111111';

function registry(prisma: Record<string, unknown>) {
  return new PluginRegistryService(
    prisma as never,
    { ensurePlatformAdmin: vi.fn().mockResolvedValue({}) } as never,
    {} as never,
  );
}

function packageListRow() {
  return {
    id: packageId,
    manifestId: 'team.demo',
    name: 'Demo',
    description: 'A demo plugin',
    governanceStatus: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
    ownerTeam: { id: 'team-1', name: 'Team One', slug: 'team-one' },
    listing: { status: 'ACTIVE', priceCents: 0, currentReleaseId: 'release-19' },
  };
}

function releaseSummary(version: string, id: string) {
  return {
    id,
    packageId,
    version,
    targetPlatform: 'windows-x64',
    sizeBytes: 1024,
    status: 'PUBLISHED',
    marketReviewStatus: 'APPROVED',
    sourceKind: version === '1.10.0' ? 'EXTERNAL_TOOL' : 'API',
    sourceLabel: version === '1.10.0' ? 'Cursor' : '',
    ingestChannel: version === '1.10.0' ? 'DESKTOP' : 'API',
    aiPolicyVersion: 1,
    aiPolicyStatus: 'PASSED',
    aiPolicyReason: '',
    createdAt: now,
  };
}

describe('PluginRegistryService admin governance', () => {
  it('validates source filters against the release provenance enum', async () => {
    const valid = Object.assign(new AdminPluginPackageListQueryDto(), { sourceKind: 'EXTERNAL_TOOL' });
    const invalid = Object.assign(new AdminPluginPackageListQueryDto(), { sourceKind: 'CURSOR' });

    await expect(validate(valid)).resolves.toHaveLength(0);
    await expect(validate(invalid)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ property: 'sourceKind' }),
    ]));
  });

  it('uses lightweight package/release selects and picks 1.10.0 over 1.9.0', async () => {
    const packageFindMany = vi.fn().mockResolvedValue([packageListRow()]);
    const releaseFindMany = vi.fn().mockResolvedValue([
      releaseSummary('1.9.0', 'release-19'),
      releaseSummary('1.10.0', 'release-110'),
    ]);
    const service = registry({
      pluginPackage: { findMany: packageFindMany, count: vi.fn().mockResolvedValue(1) },
      pluginRelease: { findMany: releaseFindMany },
    });

    const result = await service.adminPackages('admin', {
      page: 2,
      pageSize: 10,
      search: 'demo',
      status: 'ACTIVE',
      reviewStatus: 'APPROVED',
      sourceKind: 'EXTERNAL_TOOL',
    });

    expect(result).toMatchObject({
      total: 1,
      page: 2,
      pageSize: 10,
      items: [{
        latestRelease: {
          id: 'release-110',
          version: '1.10.0',
          sourceKind: 'EXTERNAL_TOOL',
          sourceLabel: 'Cursor',
          ingestChannel: 'DESKTOP',
        },
        marketplaceCurrentVersion: '1.9.0',
        releaseCount: 2,
      }],
    });
    expect(packageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        governanceStatus: 'ACTIVE',
        releases: { some: { marketReviewStatus: 'APPROVED', sourceKind: 'EXTERNAL_TOOL' } },
      }),
      select: ADMIN_PACKAGE_LIST_SELECT,
      skip: 10,
      take: 10,
    }));
    expect(releaseFindMany).toHaveBeenCalledWith({
      where: { packageId: { in: [packageId] } },
      select: ADMIN_RELEASE_SUMMARY_SELECT,
    });
    for (const field of ['manifest', 'fileManifest', 'artifactKey', 'reviews']) {
      expect(ADMIN_RELEASE_SUMMARY_SELECT).not.toHaveProperty(field);
    }
    expect(ADMIN_RELEASE_SUMMARY_SELECT).toMatchObject({
      sourceKind: true,
      sourceLabel: true,
      ingestChannel: true,
    });
  });

  it('allows list and review permissions to read deferred release details', () => {
    for (const method of ['detail', 'manifest', 'files', 'reviews'] as const) {
      expect(Reflect.getMetadata(
        PERMISSIONS_KEY,
        AdminPluginRegistryController.prototype[method],
      )).toEqual(['platform.plugin.list_all', 'platform.plugin.review']);
    }
    expect(Reflect.getMetadata(
      PERMISSIONS_KEY,
      AdminPluginRegistryController.prototype.artifact,
    )).toEqual(['platform.plugin.review']);
  });

  it('keeps the DELISTED release pointer without marking it marketplace-current', async () => {
    const release = {
      ...releaseSummary('1.10.0', 'release-110'),
      sha256: 'a'.repeat(64),
      sourceKind: 'API',
      sourceLabel: '',
      ingestChannel: 'API',
      reviewReason: '',
      reviewedById: 'admin',
      reviewedAt: now,
      createdById: 'creator',
      package: {
        listing: {
          status: 'DELISTED',
          priceCents: 0,
          currentReleaseId: 'release-110',
          delistedBy: 'PLATFORM',
          delistReason: 'policy',
          delistedAt: now,
          delistedByUserId: 'admin',
        },
      },
    };
    const findUnique = vi.fn().mockResolvedValue(release);
    const service = registry({ pluginRelease: { findUnique } });

    await expect(service.adminReleaseCore('admin', 'release-110')).resolves.toMatchObject({
      release: { id: 'release-110' },
      listing: {
        status: 'DELISTED',
        currentReleaseId: 'release-110',
        delistedBy: 'PLATFORM',
        delistReason: 'policy',
        delistedAt: now.toISOString(),
        delistedByUserId: 'admin',
      },
      isMarketplaceCurrent: false,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'release-110' },
      select: ADMIN_RELEASE_CORE_SELECT,
    });
    for (const field of ['manifest', 'fileManifest', 'artifactKey', 'reviews']) {
      expect(ADMIN_RELEASE_CORE_SELECT).not.toHaveProperty(field);
    }
  });

  it('allows only one terminal review when approve and reject race', async () => {
    let terminalClaimed = false;
    const updateMany = vi.fn(async () => {
      await Promise.resolve();
      if (terminalClaimed) return { count: 0 };
      terminalClaimed = true;
      return { count: 1 };
    });
    const reviewCreate = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = {
      pluginPackage: { findUnique: vi.fn().mockResolvedValue({ governanceStatus: 'ACTIVE' }) },
      pluginRelease: {
        updateMany,
        findMany: vi.fn().mockResolvedValue([{ id: 'release-race', version: '1.0.0' }]),
        findUnique: vi.fn().mockResolvedValue({
          ...releaseSummary('1.0.0', 'release-race'),
          manifest: {},
          sha256: 'a'.repeat(64),
          sourceKind: 'API',
          sourceLabel: '',
          ingestChannel: 'API',
          reviewReason: '',
        }),
      },
      marketplaceListing: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
      pluginReleaseReview: { create: reviewCreate },
      auditLog: { create: auditCreate },
    };
    const transaction = vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx));
    const service = registry({
      pluginRelease: {
        findUnique: vi.fn().mockResolvedValue({
          ...releaseSummary('1.0.0', 'release-race'),
          marketReviewStatus: 'PENDING',
          package: { id: packageId, governanceStatus: 'ACTIVE' },
        }),
      },
      $transaction: transaction,
    });

    const results = await Promise.allSettled([
      service.approveRelease('admin', 'release-race'),
      service.rejectRelease('admin', 'release-race', 'policy'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'conflict' });
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(reviewCreate).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledOnce();
    expect(transaction.mock.calls.some((call) => call[1]?.isolationLevel === Prisma.TransactionIsolationLevel.Serializable)).toBe(true);
  });

  it('package delist preserves the current release id and rejects an empty reason', async () => {
    const activeListing = {
      id: 'listing-1',
      packageId,
      status: 'ACTIVE',
      priceCents: 0,
      currentReleaseId: 'release-current',
      delistedBy: null,
      delistReason: '',
      delistedAt: null,
      delistedByUserId: null,
    };
    const delistedListing = {
      ...activeListing,
      status: 'DELISTED',
      delistedBy: 'PLATFORM',
      delistReason: 'policy',
      delistedAt: now,
      delistedByUserId: 'admin',
    };
    const listingFindUnique = vi.fn()
      .mockResolvedValueOnce(activeListing)
      .mockResolvedValueOnce(delistedListing);
    const listingUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      marketplaceListing: { findUnique: listingFindUnique, updateMany: listingUpdateMany },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = registry({
      pluginPackage: { findUnique: vi.fn().mockResolvedValue({ id: packageId }) },
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    });

    await expect(service.delistPackage('admin', packageId, ' policy ')).resolves.toMatchObject({
      packageId,
      listing: {
        status: 'DELISTED',
        currentReleaseId: 'release-current',
        delistedBy: 'PLATFORM',
        delistReason: 'policy',
      },
    });
    const updateData = listingUpdateMany.mock.calls[0]?.[0]?.data;
    expect(updateData).not.toHaveProperty('currentReleaseId');
    await expect(service.delistPackage('admin', packageId, '   ')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('exact-current release delist rejects an empty reason before reading registry state', async () => {
    const findUnique = vi.fn();
    const service = registry({ pluginRelease: { findUnique } });

    await expect(service.delistRelease('admin', 'release-current', '   ')).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('sorts and slices file manifests while review history uses database pagination', async () => {
    const releaseFindUnique = vi.fn()
      .mockResolvedValueOnce({
        id: 'release-files',
        fileManifest: [
          { path: 'z.ts', sizeBytes: 3 },
          { path: 'a.ts', sizeBytes: 1 },
          { path: 'm.ts', sizeBytes: 2 },
        ],
      })
      .mockResolvedValueOnce({ id: 'release-files' });
    const reviewFindMany = vi.fn().mockResolvedValue([{
      id: 'review-2',
      releaseId: 'release-files',
      status: 'REJECTED',
      reason: 'policy',
      createdAt: now,
      reviewer: { id: 'admin', displayName: 'Admin', email: 'admin@example.com' },
    }]);
    const service = registry({
      pluginRelease: { findUnique: releaseFindUnique },
      pluginReleaseReview: { findMany: reviewFindMany, count: vi.fn().mockResolvedValue(3) },
    });

    await expect(service.adminReleaseFiles('admin', 'release-files', { page: 2, pageSize: 2 })).resolves.toEqual({
      items: [{ path: 'z.ts', sizeBytes: 3 }],
      total: 3,
      page: 2,
      pageSize: 2,
    });
    await expect(service.adminReleaseReviews('admin', 'release-files', { page: 2, pageSize: 1 })).resolves.toMatchObject({
      items: [{ reviewer: { id: 'admin', displayName: 'Admin', email: 'admin@example.com' } }],
      total: 3,
      page: 2,
      pageSize: 1,
    });
    expect(reviewFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 1, take: 1 }));
  });
});
