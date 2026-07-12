// MeService 单测：覆盖数据导出（脱敏完整）+ 账号注销（软删除字段正确 + 审计）。
//  - exportMyData：用户不存在抛 not_found；Promise.all 并行查五类数据；出参不含 passwordHash/tokenVersion。
//  - deleteMyAccount：用户不存在抛 not_found；事务内软删字段正确（status=DISABLED + 打码邮箱 + tokenVersion++ +
//    随机 passwordHash）+ 审计 action='user.account_deleted' metadata 仅 {userId}。
// 参考 release.service.spec.ts / auth.service.spec.ts：Mock PrismaService，不连真实 DB。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MeService } from './me.service';

function mockPrisma() {
  const user = { findUnique: vi.fn(), update: vi.fn() };
  const plugin = { findMany: vi.fn(async () => []) };
  const purchase = { findMany: vi.fn(async () => []) };
  const walletTransaction = { findMany: vi.fn(async () => []) };
  const teamMembership = { findMany: vi.fn(async () => []) };
  const auditLog = { create: vi.fn() };
  const tx = { user: { update: user.update }, auditLog: { create: auditLog.create } };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return { user, plugin, purchase, walletTransaction, teamMembership, auditLog, $transaction, __tx: tx };
}

describe('MeService 数据导出 + 账号注销', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: MeService;

  beforeEach(() => {
    prisma = mockPrisma();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new MeService(prisma);
  });

  describe('exportMyData', () => {
    it('用户不存在时抛 not_found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.exportMyData('missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('导出个人信息含 email/displayName/createdAt，不含 passwordHash/tokenVersion', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        displayName: 'Alice',
        status: 'ACTIVE',
        platformRole: 'NONE',
        tokenVersion: 5,
        passwordHash: '$2a$12$secret-hash',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const result = await service.exportMyData('u1');
      // publicUser 白名单 + createdAt。
      expect(result.user).toEqual({
        id: 'u1',
        email: 'a@b.com',
        displayName: 'Alice',
        status: 'ACTIVE',
        platformRole: 'NONE',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      // 关键安全约束：绝不返回 passwordHash / tokenVersion。
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.user).not.toHaveProperty('tokenVersion');
    });

    it('并行查询五类数据（authorUserId/buyerUserId/userId 过滤）', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', displayName: 'A', status: 'ACTIVE', platformRole: 'NONE', createdAt: new Date() });
      prisma.plugin.findMany.mockResolvedValue([{ id: 'p1', name: '插件A', version: '1.0.0', description: 'd', visibility: 'PUBLIC', reviewStatus: 'APPROVED', marketplace: true, priceCents: 100, createdAt: new Date() }]);
      prisma.purchase.findMany.mockResolvedValue([
        { id: 'pu1', pluginId: 'p2', packageId: null, sellerUserId: 'u2', priceCents: 200, createdAt: new Date() },
        { id: 'pu2', pluginId: null, packageId: 'pkg-2', sellerUserId: 'u3', priceCents: 300, createdAt: new Date() },
      ]);
      prisma.walletTransaction.findMany.mockResolvedValue([{ id: 'w1', amountCents: 1000, direction: 'CREDIT', reason: 'signup_bonus', pluginId: null, createdAt: new Date() }]);
      prisma.teamMembership.findMany.mockResolvedValue([{ teamId: 't1', role: 'MEMBER', status: 'ACTIVE', joinedAt: new Date(), team: { id: 't1', name: '团队A', slug: 'a' } }]);

      const result = await service.exportMyData('u1');
      // plugins 按 authorUserId 过滤。
      expect(prisma.plugin.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { authorUserId: 'u1' } }));
      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]).toMatchObject({ id: 'p1', name: '插件A', priceCents: 100 });
      // purchases 按 buyerUserId 过滤。
      expect(prisma.purchase.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { buyerUserId: 'u1' } }));
      expect(result.purchases).toHaveLength(2);
      expect(result.purchases[1]).toMatchObject({ pluginId: null, packageId: 'pkg-2', priceCents: 300 });
      // wallet 按 userId 过滤。
      expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1' } }));
      expect(result.wallet).toHaveLength(1);
      // teams 按 userId 过滤。
      expect(prisma.teamMembership.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1' } }));
      expect(result.teams).toHaveLength(1);
      expect(result.teams[0]).toMatchObject({ teamId: 't1', role: 'MEMBER', team: { id: 't1', name: '团队A' } });
    });

    it('无任何关联数据时返回空数组（非 null）', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', displayName: 'A', status: 'ACTIVE', platformRole: 'NONE', createdAt: new Date() });
      const result = await service.exportMyData('u1');
      expect(result.plugins).toEqual([]);
      expect(result.purchases).toEqual([]);
      expect(result.wallet).toEqual([]);
      expect(result.teams).toEqual([]);
    });
  });

  describe('deleteMyAccount', () => {
    it('用户不存在时抛 not_found 且不开启事务', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.deleteMyAccount('missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('软删字段正确：status=DISABLED + 打码邮箱 + displayName + tokenVersion++ + 随机 passwordHash', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
      const result = await service.deleteMyAccount('u1');
      expect(result).toEqual({ ok: true });
      // 事务内 user.update 被调用，字段语义符合软删契约。
      const call = prisma.__tx.user.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'u1' });
      expect(call.data.status).toBe('DISABLED');
      expect(call.data.displayName).toBe('已注销用户');
      expect(call.data.tokenVersion).toEqual({ increment: 1 });
      // email 打码：原邮箱-deleted-<时间戳>@deleted.local。
      expect(call.data.email).toMatch(/^a@b\.com-deleted-\d+@deleted\.local$/);
      // passwordHash 被替换为 bcrypt 随机串（非原值，长度合理）。
      expect(call.data.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(call.data.passwordHash).not.toBe('a@b.com');
    });

    it('审计 action=user.account_deleted，metadata 仅 {userId}（不记原邮箱）', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
      await service.deleteMyAccount('u1');
      expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: 'u1',
          action: 'user.account_deleted',
          targetType: 'User',
          targetId: 'u1',
          metadata: { userId: 'u1' },
        }),
      }));
    });

    it('审计 metadata 不泄漏原邮箱', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'sensitive@example.com' });
      await service.deleteMyAccount('u1');
      const call = prisma.__tx.auditLog.create.mock.calls[0][0];
      // metadata 只含 userId，不含原邮箱。
      expect(call.data.metadata).toEqual({ userId: 'u1' });
      expect(JSON.stringify(call.data.metadata)).not.toContain('sensitive@example.com');
    });

    it('原邮箱被释放：打码邮箱与新值不同且唯一（含时间戳）', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'reuse@example.com' });
      await service.deleteMyAccount('u1');
      const call = prisma.__tx.user.update.mock.calls[0][0];
      // 打码邮箱不以原邮箱结尾（已变成 @deleted.local 域），原邮箱可被重新注册。
      expect(call.data.email).not.toBe('reuse@example.com');
      expect(call.data.email.endsWith('@deleted.local')).toBe(true);
    });
  });
});
