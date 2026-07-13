import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { PluginRegistryService } from './plugin-registry.service';

const now = new Date('2026-07-11T00:00:00.000Z');

function packageRow(releases: Array<Record<string, unknown>> = []) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ownerTeamId: '22222222-2222-4222-8222-222222222222',
    authorUserId: '33333333-3333-4333-8333-333333333333',
    manifestId: 'team.demo',
    name: 'Demo',
    description: '',
    governanceStatus: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
    releases,
  };
}

function releaseRow(version: string, id = version) {
  return {
    id,
    packageId: '11111111-1111-4111-8111-111111111111',
    version,
    manifest: {},
    sha256: 'a'.repeat(64),
    sizeBytes: 10,
    status: 'PUBLISHED',
    marketReviewStatus: 'PENDING',
    targetPlatform: 'windows-x64',
    sourceKind: 'UNKNOWN',
    sourceLabel: '',
    ingestChannel: 'API',
    aiPolicyVersion: 1,
    aiPolicyStatus: 'PASSED',
    aiPolicyReason: '',
    reviewReason: '',
    createdAt: now,
  };
}

function service(prisma: Record<string, unknown>, auth: Record<string, unknown>, artifacts: Record<string, unknown> = {}) {
  return new PluginRegistryService(prisma as never, auth as never, artifacts as never);
}

function marketplaceListing(priceCents = 1200) {
  const currentRelease = {
    ...releaseRow('1.0.0', 'release-1'),
    marketReviewStatus: 'APPROVED',
  };
  return {
    id: 'listing-1',
    packageId: packageRow().id,
    currentReleaseId: 'release-1',
    priceCents,
    status: 'ACTIVE',
    currentRelease,
    package: {
      ...packageRow(),
      ownerTeamId: 'seller-team',
      authorUserId: 'seller-user',
    },
  };
}

const buyerMembership = {
  teamId: 'buyer-team',
  userId: 'buyer-user',
  role: 'MEMBER',
};

describe('PluginRegistryService', () => {
  it('selects the team catalog latest release by SemVer rather than publish time', async () => {
    const findMany = vi.fn().mockResolvedValue([
      packageRow([releaseRow('1.9.0'), releaseRow('2.0.0-rc.1'), releaseRow('2.0.0')]),
    ]);
    const registry = service(
      { pluginPackage: { findMany } },
      { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: '22222222-2222-4222-8222-222222222222' }) },
    );
    const result = await registry.teamCatalog('user');
    expect(result.items[0]?.latestRelease.version).toBe('2.0.0');
  });

  it('projects release provenance through both team and management catalogs', async () => {
    const externalRelease = {
      ...releaseRow('2.0.0', 'external-release'),
      sourceKind: 'EXTERNAL_TOOL',
      sourceLabel: 'Cursor workspace',
      ingestChannel: 'DESKTOP',
    };
    const listing = {
      id: 'listing-1',
      packageId: packageRow().id,
      priceCents: 0,
      status: 'DELISTED',
      currentReleaseId: 'external-release',
      delistedBy: 'OWNER',
      delistReason: 'maintenance',
      delistedAt: now,
      delistedByUserId: 'owner-user',
    };
    const findMany = vi.fn()
      .mockResolvedValueOnce([packageRow([externalRelease])])
      .mockResolvedValueOnce([{ ...packageRow([externalRelease]), governanceStatus: 'ARCHIVED', listing }]);
    const registry = service(
      { pluginPackage: { findMany } },
      { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: packageRow().ownerTeamId }) },
    );

    await expect(registry.teamCatalog('owner-user')).resolves.toMatchObject({
      items: [{
        latestRelease: {
          id: 'external-release',
          sourceKind: 'EXTERNAL_TOOL',
          sourceLabel: 'Cursor workspace',
          ingestChannel: 'DESKTOP',
        },
      }],
    });
    await expect(registry.managementCatalog('owner-user')).resolves.toMatchObject({
      items: [{
        package: { governanceStatus: 'ARCHIVED' },
        latestRelease: {
          id: 'external-release',
          sourceKind: 'EXTERNAL_TOOL',
          sourceLabel: 'Cursor workspace',
          ingestChannel: 'DESKTOP',
        },
        releaseCount: 1,
        pendingReviewCount: 1,
        listing: { status: 'DELISTED', delistedBy: 'OWNER', delistedAt: now.toISOString() },
      }],
    });
    expect(findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { ownerTeamId: packageRow().ownerTeamId, governanceStatus: 'ACTIVE' },
    }));
    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { ownerTeamId: packageRow().ownerTeamId },
      include: { releases: true, listing: true },
    }));
  });

  it('denies a team runtime when the current user has an explicit deny grant', async () => {
    const auditCreate = vi.fn().mockResolvedValue({});
    const registry = service(
      {
        pluginPackage: { findUnique: vi.fn().mockResolvedValue({ ...packageRow(), listing: null }) },
        pluginGrant: { findMany: vi.fn().mockResolvedValue([{ subjectKind: 'USER', effect: 'DENY' }]) },
        auditLog: { create: auditCreate },
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: '22222222-2222-4222-8222-222222222222', role: 'MEMBER', teamRoleId: null }) },
    );
    await expect(registry.runtimeAccess('user', packageRow().id, 'release-1', 'a'.repeat(64)))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(auditCreate).toHaveBeenCalledOnce();
  });

  it('binds runtime access to the exact published release and artifact digest', async () => {
    const release = releaseRow('1.0.0', 'release-1');
    const findRelease = vi.fn().mockResolvedValue(release);
    const registry = service(
      {
        pluginPackage: { findUnique: vi.fn().mockResolvedValue({ ...packageRow(), listing: null }) },
        pluginGrant: { findMany: vi.fn().mockResolvedValue([]) },
        pluginRelease: { findUnique: findRelease },
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: packageRow().ownerTeamId, role: 'MEMBER', teamRoleId: null }) },
    );

    await expect(registry.runtimeAccess('user', packageRow().id, release.id, release.sha256)).resolves.toMatchObject({
      allowed: true,
      mode: 'online-team-membership',
    });
    expect(findRelease).toHaveBeenCalledWith({ where: { id: release.id } });

    await expect(registry.runtimeAccess('user', packageRow().id, release.id, 'b'.repeat(64)))
      .rejects.toMatchObject({ code: 'plugin_release_mismatch' });
  });

  it('shows every release to the owner team but only approved releases to marketplace consumers', async () => {
    const releases = [
      releaseRow('1.0.0', 'pending'),
      { ...releaseRow('1.1.0', 'approved'), marketReviewStatus: 'APPROVED' },
      { ...releaseRow('1.2.0', 'rejected'), marketReviewStatus: 'REJECTED' },
    ];
    const owner = service(
      {
        pluginPackage: { findUnique: vi.fn().mockResolvedValue({ ...packageRow(releases), listing: null }) },
        pluginEntitlement: { count: vi.fn().mockResolvedValue(0) },
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: packageRow().ownerTeamId }) },
    );
    await expect(owner.packageDetail('owner', packageRow().id)).resolves.toMatchObject({
      releases: [{ id: 'pending' }, { id: 'approved' }, { id: 'rejected' }],
    });

    const consumer = service(
      {
        pluginPackage: {
          findUnique: vi.fn().mockResolvedValue({
            ...packageRow(releases),
            ownerTeamId: 'seller-team',
            listing: { status: 'DELISTED', priceCents: 1200, currentReleaseId: 'approved' },
          }),
        },
        pluginEntitlement: { count: vi.fn().mockResolvedValue(1) },
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue(buyerMembership) },
    );
    await expect(consumer.packageDetail('buyer-user', packageRow().id)).resolves.toMatchObject({
      releases: [{ id: 'approved' }],
      entitled: true,
    });
  });

  it('rejects downloading an unapproved marketplace release even with package access', async () => {
    const download = vi.fn();
    const registry = service(
      {
        pluginRelease: { findUnique: vi.fn().mockResolvedValue(releaseRow('2.0.0', 'pending-release')) },
        pluginPackage: {
          findUnique: vi.fn().mockResolvedValue({ ...packageRow(), ownerTeamId: 'seller-team', listing: { status: 'ACTIVE', priceCents: 0 } }),
        },
        pluginEntitlement: { count: vi.fn().mockResolvedValue(0) },
        auditLog: { create: vi.fn() },
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue(buyerMembership) },
      { download },
    );
    await expect(registry.artifactDownload('buyer-user', 'pending-release')).rejects.toMatchObject({ code: 'forbidden' });
    expect(download).not.toHaveBeenCalled();
  });

  it('rechecks package activity, claims approval, and keeps the highest approved SemVer current', async () => {
    const reviewed = {
      ...releaseRow('2.9.0', 'release-reviewed'),
      package: packageRow(),
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const listingUpsert = vi.fn().mockResolvedValue({});
    const activePackageFindUnique = vi.fn()
      .mockResolvedValueOnce({ ...packageRow(), governanceStatus: 'ARCHIVED' })
      .mockResolvedValueOnce(packageRow());
    const listingFindUnique = vi.fn().mockResolvedValue(null);
    const tx = {
      pluginPackage: { findUnique: activePackageFindUnique },
      pluginRelease: {
        updateMany,
        findMany: vi.fn().mockResolvedValue([
          { id: 'release-reviewed', version: '2.9.0' },
          { id: 'release-current', version: '10.0.0' },
        ]),
        findUnique: vi.fn().mockResolvedValue({ ...reviewed, marketReviewStatus: 'APPROVED' }),
      },
      marketplaceListing: { findUnique: listingFindUnique, upsert: listingUpsert },
      pluginReleaseReview: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const registry = service(
      {
        pluginRelease: { findUnique: vi.fn().mockResolvedValue(reviewed) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
      { ensurePlatformAdmin: vi.fn().mockResolvedValue({}) },
    );

    await expect(registry.approveRelease('admin', 'release-reviewed'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(updateMany).not.toHaveBeenCalled();
    expect(listingUpsert).not.toHaveBeenCalled();
    expect(tx.pluginReleaseReview.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();

    await expect(registry.approveRelease('admin', 'release-reviewed')).resolves.toMatchObject({
      currentReleaseId: 'release-current',
      release: { id: 'release-reviewed', marketReviewStatus: 'APPROVED' },
    });
    expect(activePackageFindUnique).toHaveBeenCalledTimes(2);
    expect(activePackageFindUnique).toHaveBeenNthCalledWith(1, { where: { id: packageRow().id } });
    expect(activePackageFindUnique).toHaveBeenNthCalledWith(2, { where: { id: packageRow().id } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'release-reviewed', status: 'PUBLISHED', marketReviewStatus: 'PENDING' },
      data: expect.objectContaining({ marketReviewStatus: 'APPROVED', reviewedById: 'admin' }),
    });
    expect(tx.pluginRelease.findMany).toHaveBeenCalledWith({
      where: {
        packageId: packageRow().id,
        status: 'PUBLISHED',
        marketReviewStatus: 'APPROVED',
        aiPolicyVersion: 1,
        aiPolicyStatus: 'PASSED',
      },
      select: { id: true, version: true },
    });
    expect(listingFindUnique).toHaveBeenCalledWith({ where: { packageId: packageRow().id } });
    expect(listingUpsert).toHaveBeenCalledWith({
      where: { packageId: packageRow().id },
      update: {
        currentReleaseId: 'release-current',
        status: 'ACTIVE',
        delistedBy: null,
        delistReason: '',
        delistedAt: null,
        delistedByUserId: null,
      },
      create: { packageId: packageRow().id, currentReleaseId: 'release-current', status: 'ACTIVE' },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'admin.plugin_release.approved',
        metadata: expect.objectContaining({ currentReleaseId: 'release-current' }),
      }),
    });
  });

  it.each(['PLATFORM', 'OWNER'] as const)(
    'keeps a %s delist while approval advances the stored release pointer',
    async (delistedBy) => {
    const reviewed = {
      ...releaseRow('2.0.0', 'release-reviewed'),
      package: packageRow(),
    };
    const suspendedListing = {
      id: 'listing-1',
      packageId: packageRow().id,
      status: 'DELISTED',
      currentReleaseId: 'release-old',
      priceCents: 0,
      delistedBy,
      delistReason: 'policy review',
      delistedAt: now,
      delistedByUserId: 'admin-original',
    };
    const listingUpsert = vi.fn().mockResolvedValue({});
    const tx = {
      pluginPackage: { findUnique: vi.fn().mockResolvedValue(packageRow()) },
      pluginRelease: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([{ id: 'release-reviewed', version: '2.0.0' }]),
        findUnique: vi.fn().mockResolvedValue({ ...reviewed, marketReviewStatus: 'APPROVED' }),
      },
      marketplaceListing: { findUnique: vi.fn().mockResolvedValue(suspendedListing), upsert: listingUpsert },
      pluginReleaseReview: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const registry = service(
      {
        pluginRelease: { findUnique: vi.fn().mockResolvedValue(reviewed) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
      { ensurePlatformAdmin: vi.fn().mockResolvedValue({}) },
    );

    await expect(registry.approveRelease('admin-next', 'release-reviewed')).resolves.toMatchObject({
      currentReleaseId: 'release-reviewed',
    });
    expect(listingUpsert).toHaveBeenCalledWith({
      where: { packageId: packageRow().id },
      update: { currentReleaseId: 'release-reviewed' },
      create: { packageId: packageRow().id, currentReleaseId: 'release-reviewed', status: 'ACTIVE' },
    });
    },
  );

  it.each([
    ['approval', (registry: PluginRegistryService) => registry.approveRelease('admin', 'release-claim')],
    ['rejection', (registry: PluginRegistryService) => registry.rejectRelease('admin', 'release-claim', 'invalid')],
  ])('%s returns conflict without review or audit when the terminal-state claim is lost', async (_name, run) => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const reviewCreate = vi.fn();
    const auditCreate = vi.fn();
    const listingUpsert = vi.fn();
    const tx = {
      pluginPackage: { findUnique: vi.fn().mockResolvedValue(packageRow()) },
      pluginRelease: { updateMany, findMany: vi.fn(), findUnique: vi.fn() },
      marketplaceListing: { findUnique: vi.fn(), upsert: listingUpsert },
      pluginReleaseReview: { create: reviewCreate },
      auditLog: { create: auditCreate },
    };
    const registry = service(
      {
        pluginRelease: {
          findUnique: vi.fn().mockResolvedValue({
            ...releaseRow('1.0.0', 'release-claim'),
            package: packageRow(),
          }),
        },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
      { ensurePlatformAdmin: vi.fn().mockResolvedValue({}) },
    );

    await expect(run(registry)).rejects.toMatchObject({ code: 'conflict' });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'release-claim', status: 'PUBLISHED', marketReviewStatus: 'PENDING' },
    }));
    expect(tx.pluginPackage.findUnique).toHaveBeenCalledTimes(_name === 'approval' ? 1 : 0);
    expect(tx.pluginRelease.findMany).not.toHaveBeenCalled();
    expect(listingUpsert).not.toHaveBeenCalled();
    expect(reviewCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('blocks packages with pending reviews, then atomically archives and owner-delists', async () => {
    const activeListing = {
      id: 'listing-1',
      packageId: packageRow().id,
      priceCents: 0,
      status: 'ACTIVE',
      currentReleaseId: 'release-current',
      delistedBy: null,
      delistReason: '',
      delistedAt: null,
      delistedByUserId: null,
    };
    const packageUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const listingUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const auditCreate = vi.fn().mockResolvedValue({});
    const pendingReviewCount = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const tx = {
      pluginRelease: { count: pendingReviewCount },
      pluginPackage: {
        updateMany: packageUpdateMany,
        findUnique: vi.fn().mockResolvedValue({ ...packageRow(), governanceStatus: 'ARCHIVED' }),
      },
      marketplaceListing: {
        updateMany: listingUpdateMany,
        findUnique: vi.fn().mockResolvedValue({
          ...activeListing,
          status: 'DELISTED',
          delistedBy: 'OWNER',
          delistReason: '插件包已归档',
          delistedAt: now,
          delistedByUserId: 'owner-user',
        }),
      },
      auditLog: { create: auditCreate },
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
    const registry = service(
      {
        pluginPackage: { findUnique: vi.fn().mockResolvedValue({ ...packageRow(), listing: activeListing }) },
        $transaction: transaction,
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: packageRow().ownerTeamId, role: 'TEAM_ADMIN' }) },
    );

    await expect(registry.updatePackageStatus('owner-user', packageRow().id, 'ARCHIVED'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(packageUpdateMany).not.toHaveBeenCalled();
    expect(listingUpdateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();

    await expect(registry.updatePackageStatus('owner-user', packageRow().id, 'ARCHIVED')).resolves.toMatchObject({
      package: { governanceStatus: 'ARCHIVED' },
      listing: { status: 'DELISTED', delistedBy: 'OWNER', delistReason: '插件包已归档' },
    });
    expect(pendingReviewCount).toHaveBeenCalledTimes(2);
    expect(pendingReviewCount).toHaveBeenNthCalledWith(1, {
      where: { packageId: packageRow().id, marketReviewStatus: 'PENDING' },
    });
    expect(pendingReviewCount).toHaveBeenNthCalledWith(2, {
      where: { packageId: packageRow().id, marketReviewStatus: 'PENDING' },
    });
    expect(packageUpdateMany).toHaveBeenCalledWith({
      where: { id: packageRow().id, governanceStatus: 'ACTIVE' },
      data: { governanceStatus: 'ARCHIVED' },
    });
    expect(listingUpdateMany).toHaveBeenCalledWith({
      where: { packageId: packageRow().id, status: 'ACTIVE' },
      data: {
        status: 'DELISTED',
        delistedBy: 'OWNER',
        delistReason: '插件包已归档',
        delistedAt: expect.any(Date),
        delistedByUserId: 'owner-user',
      },
    });
    expect(auditCreate).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('prevents owners from restoring a platform delist while allowing the platform to restore it', async () => {
    const platformListing = {
      id: 'listing-1',
      packageId: packageRow().id,
      priceCents: 0,
      status: 'DELISTED',
      currentReleaseId: 'release-current',
      delistedBy: 'PLATFORM',
      delistReason: 'policy review',
      delistedAt: now,
      delistedByUserId: 'admin',
    };
    const ownerTx = {
      marketplaceListing: { findUnique: vi.fn().mockResolvedValue(platformListing), updateMany: vi.fn() },
      pluginPackage: { findUnique: vi.fn() },
      pluginRelease: { findUnique: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const ownerRegistry = service(
      {
        pluginPackage: { findUnique: vi.fn().mockResolvedValue({ ...packageRow(), listing: platformListing }) },
        $transaction: vi.fn(async (callback: (client: typeof ownerTx) => unknown) => callback(ownerTx)),
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: packageRow().ownerTeamId, role: 'TEAM_ADMIN' }) },
    );

    await expect(ownerRegistry.updateOwnerMarketplaceStatus('owner-user', packageRow().id, 'ACTIVE', 'resume'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(ownerTx.marketplaceListing.updateMany).not.toHaveBeenCalled();
    expect(ownerTx.auditLog.create).not.toHaveBeenCalled();

    const activeListing = {
      ...platformListing,
      status: 'ACTIVE',
      delistedBy: null,
      delistReason: '',
      delistedAt: null,
      delistedByUserId: null,
    };
    const listingFindUnique = vi.fn()
      .mockResolvedValueOnce(platformListing)
      .mockResolvedValueOnce(activeListing);
    const platformUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const platformAuditCreate = vi.fn().mockResolvedValue({});
    const platformTx = {
      marketplaceListing: { findUnique: listingFindUnique, updateMany: platformUpdateMany },
      pluginPackage: { findUnique: vi.fn().mockResolvedValue(packageRow()) },
      pluginRelease: {
        findUnique: vi.fn().mockResolvedValue({
          ...releaseRow('2.0.0', 'release-current'),
          marketReviewStatus: 'APPROVED',
        }),
      },
      auditLog: { create: platformAuditCreate },
    };
    const platformRegistry = service(
      {
        pluginPackage: { findUnique: vi.fn().mockResolvedValue(packageRow()) },
        $transaction: vi.fn(async (callback: (client: typeof platformTx) => unknown) => callback(platformTx)),
      },
      { ensurePlatformAdmin: vi.fn().mockResolvedValue({}) },
    );

    await expect(platformRegistry.updatePlatformMarketplaceStatus('admin', packageRow().id, 'ACTIVE', 'cleared'))
      .resolves.toMatchObject({ listing: { status: 'ACTIVE', delistedBy: null } });
    expect(platformUpdateMany).toHaveBeenCalledWith({
      where: { id: 'listing-1', status: 'DELISTED', delistedBy: 'PLATFORM' },
      data: {
        status: 'ACTIVE',
        delistedBy: null,
        delistReason: '',
        delistedAt: null,
        delistedByUserId: null,
      },
    });
    expect(platformAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'admin.plugin_package.relisted' }),
    });
  });

  it('rejects release-based delist for a non-current marketplace release', async () => {
    const transaction = vi.fn();
    const registry = service(
      {
        pluginRelease: { findUnique: vi.fn().mockResolvedValue(releaseRow('1.0.0', 'release-old')) },
        marketplaceListing: {
          findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', currentReleaseId: 'release-current' }),
        },
        $transaction: transaction,
      },
      { ensurePlatformAdmin: vi.fn().mockResolvedValue({}) },
    );

    await expect(registry.delistRelease('admin', 'release-old', 'policy'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does not delist after approval concurrently switches the marketplace current release', async () => {
    const listingUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = {
      marketplaceListing: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'listing-1',
          status: 'ACTIVE',
          currentReleaseId: 'release-new',
        }),
        updateMany: listingUpdateMany,
      },
      auditLog: { create: vi.fn() },
    };
    const registry = service(
      {
        pluginRelease: { findUnique: vi.fn().mockResolvedValue(releaseRow('1.0.0', 'release-old')) },
        marketplaceListing: {
          findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', currentReleaseId: 'release-old' }),
        },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
      { ensurePlatformAdmin: vi.fn().mockResolvedValue({}) },
    );

    await expect(registry.delistRelease('admin', 'release-old', 'policy'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(listingUpdateMany).toHaveBeenCalledWith({
      where: { id: 'listing-1', status: 'ACTIVE', currentReleaseId: 'release-old' },
      data: expect.objectContaining({ status: 'DELISTED', delistedBy: 'PLATFORM' }),
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('withdraws a pending marketplace submission back to draft with review history and audit', async () => {
    const release = {
      ...releaseRow('1.0.0', 'release-withdraw'),
      package: packageRow(),
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const reviewCreate = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = {
      pluginRelease: {
        updateMany,
        findUnique: vi.fn().mockResolvedValue({
          ...releaseRow('1.0.0', 'release-withdraw'),
          marketReviewStatus: 'DRAFT',
          reviewReason: 'author changed scope',
        }),
      },
      pluginReleaseReview: { create: reviewCreate },
      auditLog: { create: auditCreate },
    };
    const registry = service(
      {
        pluginRelease: { findUnique: vi.fn().mockResolvedValue(release) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: packageRow().ownerTeamId, role: 'TEAM_ADMIN' }) },
    );

    await expect(registry.withdrawMarketplaceSubmission('owner-user', 'release-withdraw', '  author changed scope  '))
      .resolves.toMatchObject({ release: { marketReviewStatus: 'DRAFT', reviewReason: 'author changed scope' } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'release-withdraw', status: 'PUBLISHED', marketReviewStatus: 'PENDING' },
      data: {
        marketReviewStatus: 'DRAFT',
        reviewReason: 'author changed scope',
        reviewedById: null,
        reviewedAt: null,
      },
    });
    expect(reviewCreate).toHaveBeenCalledWith({
      data: { releaseId: 'release-withdraw', status: 'DRAFT', reason: 'author changed scope' },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'plugin.release.marketplace_withdrawn' }),
    });
  });

  it.each([
    { label: 'pending non-current', marketReviewStatus: 'PENDING', currentReleaseId: 'release-current', delistCount: 0, resetsReview: true },
    { label: 'approved marketplace current', marketReviewStatus: 'APPROVED', currentReleaseId: 'release-yank', delistCount: 1, resetsReview: false },
  ])('yanks a $label release without violating review or listing invariants', async ({ marketReviewStatus, currentReleaseId, delistCount, resetsReview }) => {
    const activeListing = {
      id: 'listing-1',
      packageId: packageRow().id,
      priceCents: 0,
      status: 'ACTIVE',
      currentReleaseId,
      delistedBy: null,
      delistReason: '',
      delistedAt: null,
      delistedByUserId: null,
    };
    const release = {
      ...releaseRow('1.0.0', 'release-yank'),
      marketReviewStatus,
      package: { ...packageRow(), listing: activeListing },
    };
    const releaseUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const listingUpdateMany = vi.fn().mockResolvedValue({ count: delistCount });
    const reviewCreate = vi.fn().mockResolvedValue({});
    const finalListing = delistCount === 1
      ? {
          ...activeListing,
          status: 'DELISTED',
          delistedBy: 'OWNER',
          delistReason: '作者撤回发行版',
          delistedAt: now,
          delistedByUserId: 'owner-user',
        }
      : activeListing;
    const tx = {
      pluginRelease: {
        updateMany: releaseUpdateMany,
        findUnique: vi.fn().mockResolvedValue({
          ...releaseRow('1.0.0', 'release-yank'),
          status: 'YANKED',
          marketReviewStatus: resetsReview ? 'DRAFT' : marketReviewStatus,
          reviewReason: resetsReview ? '作者撤回发行版' : '',
        }),
      },
      marketplaceListing: {
        updateMany: listingUpdateMany,
        findUnique: vi.fn().mockResolvedValue(finalListing),
      },
      pluginReleaseReview: { create: reviewCreate },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const registry = service(
      {
        pluginRelease: { findUnique: vi.fn().mockResolvedValue(release) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: packageRow().ownerTeamId, role: 'TEAM_ADMIN' }) },
    );

    await expect(registry.updateReleaseStatus('owner-user', 'release-yank', 'YANKED')).resolves.toMatchObject({
      release: {
        status: 'YANKED',
        marketReviewStatus: resetsReview ? 'DRAFT' : marketReviewStatus,
      },
      listing: { status: delistCount === 1 ? 'DELISTED' : 'ACTIVE' },
    });
    expect(releaseUpdateMany).toHaveBeenCalledWith({
      where: { id: 'release-yank', status: 'PUBLISHED', marketReviewStatus },
      data: resetsReview
        ? {
            status: 'YANKED',
            marketReviewStatus: 'DRAFT',
            reviewReason: '作者撤回发行版',
            reviewedById: null,
            reviewedAt: null,
          }
        : { status: 'YANKED' },
    });
    expect(listingUpdateMany).toHaveBeenCalledWith({
      where: { packageId: packageRow().id, currentReleaseId: 'release-yank', status: 'ACTIVE' },
      data: {
        status: 'DELISTED',
        delistedBy: 'OWNER',
        delistReason: '作者撤回发行版',
        delistedAt: expect.any(Date),
        delistedByUserId: 'owner-user',
      },
    });
    if (resetsReview) {
      expect(reviewCreate).toHaveBeenCalledWith({
        data: { releaseId: 'release-yank', status: 'DRAFT', reason: '作者撤回发行版' },
      });
    } else {
      expect(reviewCreate).not.toHaveBeenCalled();
    }
  });

  it('does not yank across a concurrent marketplace submission', async () => {
    const release = {
      ...releaseRow('1.0.0', 'release-race'),
      marketReviewStatus: 'DRAFT',
      package: { ...packageRow(), listing: null },
    };
    const releaseUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = {
      pluginRelease: { updateMany: releaseUpdateMany },
      marketplaceListing: { updateMany: vi.fn(), findUnique: vi.fn() },
      pluginReleaseReview: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const registry = service(
      {
        pluginRelease: { findUnique: vi.fn().mockResolvedValue(release) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: packageRow().ownerTeamId, role: 'TEAM_ADMIN' }) },
    );

    await expect(registry.updateReleaseStatus('owner-user', 'release-race', 'YANKED'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(releaseUpdateMany).toHaveBeenCalledWith({
      where: { id: 'release-race', status: 'PUBLISHED', marketReviewStatus: 'DRAFT' },
      data: { status: 'YANKED' },
    });
    expect(tx.marketplaceListing.updateMany).not.toHaveBeenCalled();
    expect(tx.pluginReleaseReview.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('creates a paid package order, balanced ledgers, audit, and entitlement in one transaction', async () => {
    const purchaseCreate = vi.fn().mockResolvedValue({ id: 'purchase-1' });
    const entitlementCreate = vi.fn().mockResolvedValue({ id: 'entitlement-1', purchaseId: 'purchase-1' });
    const ledgerCreate = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = {
      purchase: { create: purchaseCreate },
      team: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      balanceLedger: { create: ledgerCreate },
      auditLog: { create: auditCreate },
      pluginEntitlement: { create: entitlementCreate },
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
    const registry = service(
      {
        marketplaceListing: { findUnique: vi.fn().mockResolvedValue(marketplaceListing()) },
        pluginEntitlement: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: transaction,
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue(buyerMembership) },
    );

    await expect(registry.purchase('buyer-user', packageRow().id)).resolves.toEqual({
      entitled: true,
      entitlementId: 'entitlement-1',
      purchaseId: 'purchase-1',
    });
    expect(purchaseCreate).toHaveBeenCalledWith({
      data: {
        packageId: packageRow().id,
        buyerUserId: 'buyer-user',
        buyerTeamId: 'buyer-team',
        sellerUserId: 'seller-user',
        priceCents: 1200,
      },
    });
    expect(tx.team.updateMany).toHaveBeenCalledWith({
      where: { id: 'buyer-team', balanceCents: { gte: 1200 } },
      data: { balanceCents: { decrement: 1200 } },
    });
    expect(tx.team.update).toHaveBeenCalledWith({
      where: { id: 'seller-team' },
      data: { balanceCents: { increment: 1200 } },
    });
    expect(ledgerCreate).toHaveBeenNthCalledWith(1, {
      data: { teamId: 'buyer-team', amountCents: 1200, direction: 'DEBIT', reason: 'plugin_purchase', actorUserId: 'buyer-user' },
    });
    expect(ledgerCreate).toHaveBeenNthCalledWith(2, {
      data: { teamId: 'seller-team', amountCents: 1200, direction: 'CREDIT', reason: 'plugin_sale', actorUserId: 'seller-user' },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'buyer-user',
        action: 'plugin.marketplace.purchased',
        targetType: 'PluginPackage',
        targetId: packageRow().id,
        metadata: expect.objectContaining({ purchaseId: 'purchase-1', buyerTeamId: 'buyer-team', sellerTeamId: 'seller-team', priceCents: 1200 }),
      }),
    });
    expect(entitlementCreate).toHaveBeenCalledWith({
      data: { teamId: 'buyer-team', packageId: packageRow().id, purchaseId: 'purchase-1' },
    });
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('returns free marketplace packages without creating an entitlement or financial transaction', async () => {
    const transaction = vi.fn();
    const registry = service(
      {
        marketplaceListing: { findUnique: vi.fn().mockResolvedValue(marketplaceListing(0)) },
        pluginEntitlement: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: transaction,
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue(buyerMembership) },
    );

    await expect(registry.purchase('buyer-user', packageRow().id)).resolves.toEqual({
      entitled: true,
      entitlementId: null,
      purchaseId: null,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('returns the existing team entitlement idempotently without moving money', async () => {
    const transaction = vi.fn();
    const registry = service(
      {
        marketplaceListing: { findUnique: vi.fn().mockResolvedValue(marketplaceListing()) },
        pluginEntitlement: {
          findUnique: vi.fn().mockResolvedValue({ id: 'entitlement-existing', purchaseId: 'purchase-existing' }),
        },
        $transaction: transaction,
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue(buyerMembership) },
    );

    await expect(registry.purchase('buyer-user', packageRow().id)).resolves.toEqual({
      entitled: true,
      entitlementId: 'entitlement-existing',
      purchaseId: 'purchase-existing',
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('resolves a concurrent purchase unique conflict to the committed entitlement', async () => {
    const findEntitlement = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'entitlement-concurrent', purchaseId: 'purchase-concurrent' });
    const transaction = vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate order', {
      code: 'P2002',
      clientVersion: '7.8.0',
    }));
    const registry = service(
      {
        marketplaceListing: { findUnique: vi.fn().mockResolvedValue(marketplaceListing()) },
        pluginEntitlement: { findUnique: findEntitlement },
        $transaction: transaction,
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue(buyerMembership) },
    );

    await expect(registry.purchase('buyer-user', packageRow().id)).resolves.toEqual({
      entitled: true,
      entitlementId: 'entitlement-concurrent',
      purchaseId: 'purchase-concurrent',
    });
    expect(findEntitlement).toHaveBeenCalledTimes(2);
  });

  it('rolls back before seller credit, ledgers, audit, and entitlement when the buyer balance is insufficient', async () => {
    const tx = {
      purchase: { create: vi.fn().mockResolvedValue({ id: 'purchase-1' }) },
      team: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn(),
      },
      balanceLedger: { create: vi.fn() },
      auditLog: { create: vi.fn() },
      pluginEntitlement: { create: vi.fn() },
    };
    const registry = service(
      {
        marketplaceListing: { findUnique: vi.fn().mockResolvedValue(marketplaceListing()) },
        pluginEntitlement: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
      { ensureCurrentTeam: vi.fn().mockResolvedValue(buyerMembership) },
    );

    await expect(registry.purchase('buyer-user', packageRow().id)).rejects.toMatchObject({
      status: 402,
      code: 'insufficient_balance',
    });
    expect(tx.team.update).not.toHaveBeenCalled();
    expect(tx.balanceLedger.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.pluginEntitlement.create).not.toHaveBeenCalled();
  });
});
