import { describe, expect, it, vi } from 'vitest';
import { loadLegacyPlugins } from './migrate-plugin-registry-v4-legacy';

function plugin() {
  return {
    id: 'plugin-1',
    name: 'Legacy',
    description: '',
    version: '1.0.0',
    entry: 'index.js',
    runtimeType: 'NODEJS',
    visibility: 'TEAM',
    teamId: 'team-owner',
    authorUserId: 'user-owner',
    files: [],
    manifest: {},
    capabilities: [],
    reviewStatus: 'APPROVED',
    reviewReason: '',
    reviewedById: null,
    reviewedAt: null,
    marketplace: true,
    priceCents: 100,
    installCount: 1,
    ratingCount: 1,
    ratingSum: 5,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function rawClient(rows: unknown[][]) {
  return { $queryRawUnsafe: vi.fn().mockImplementation(() => Promise.resolve(rows.shift() ?? [])) };
}

describe('loadLegacyPlugins', () => {
  it('reads PostgreSQL legacy tables without relying on removed Prisma delegates and groups relations', async () => {
    const prisma = rawClient([
      [plugin()],
      [{ id: 'purchase-1', pluginId: 'plugin-1', buyerTeamId: 'team-buyer' }],
      [{ id: 'install-1', pluginId: 'plugin-1', teamId: 'team-buyer' }],
      [{ id: 'review-1', pluginId: 'plugin-1' }],
      [{ id: 'rating-1', pluginId: 'plugin-1', teamId: 'team-buyer' }],
      [{ id: 'grant-1', pluginId: 'plugin-1' }],
    ]);

    const result = await loadLegacyPlugins(prisma as never, 'postgresql');

    expect(result[0]).toMatchObject({
      id: 'plugin-1',
      purchases: [{ id: 'purchase-1' }],
      installations: [{ id: 'install-1' }],
      reviews: [{ id: 'review-1' }],
      ratings: [{ id: 'rating-1' }],
      pluginGrants: [{ id: 'grant-1' }],
    });
    expect(prisma.$queryRawUnsafe).toHaveBeenNthCalledWith(1, 'SELECT * FROM "Plugin"');
  });

  it('uses MySQL identifier quoting', async () => {
    const prisma = rawClient([[plugin()], [], [], [], [], []]);
    await loadLegacyPlugins(prisma as never, 'mysql');
    expect(prisma.$queryRawUnsafe).toHaveBeenNthCalledWith(1, 'SELECT * FROM `Plugin`');
  });

  it('fails closed when a legacy relation points to a missing plugin', async () => {
    const prisma = rawClient([[], [{ id: 'purchase-1', pluginId: 'missing' }], [], [], [], []]);
    await expect(loadLegacyPlugins(prisma as never, 'postgresql')).rejects.toThrow(
      'references missing Plugin missing'
    );
  });
});
