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
    reviewReason: '',
    createdAt: now,
  };
}

function service(prisma: Record<string, unknown>, auth: Record<string, unknown>, artifacts: Record<string, unknown> = {}) {
  return new PluginRegistryService(prisma as never, auth as never, artifacts as never);
}

function marketplaceListing(priceCents = 1200) {
  return {
    id: 'listing-1',
    packageId: packageRow().id,
    currentReleaseId: 'release-1',
    priceCents,
    status: 'ACTIVE',
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
    await expect(registry.runtimeAccess('user', packageRow().id)).rejects.toMatchObject({ code: 'forbidden' });
    expect(auditCreate).toHaveBeenCalledOnce();
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

  it('approval switches the marketplace listing to the reviewed release transactionally', async () => {
    const listingUpdate = vi.fn().mockResolvedValue({});
    const releaseUpdate = vi.fn().mockResolvedValue({ ...releaseRow('2.0.0', 'release-2'), marketReviewStatus: 'APPROVED' });
    const tx = {
      pluginRelease: { update: releaseUpdate },
      marketplaceListing: { update: listingUpdate },
      pluginReleaseReview: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const registry = service(
      {
        pluginRelease: { findUnique: vi.fn().mockResolvedValue(releaseRow('2.0.0', 'release-2')) },
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      },
      { ensurePlatformAdmin: vi.fn().mockResolvedValue({}) },
    );
    await registry.approveRelease('admin', 'release-2');
    expect(listingUpdate).toHaveBeenCalledWith({
      where: { packageId: packageRow().id },
      data: { currentReleaseId: 'release-2', status: 'ACTIVE' },
    });
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
