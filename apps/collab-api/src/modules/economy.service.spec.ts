// EconomyService 单测（R2：余额改团队共享 + 个人钱包退役）。
//  - 购买成功：买家团队 DEBIT(plugin_purchase) + 卖家团队 CREDIT(plugin_sale)，通知卖家。
//  - 团队余额不足：team.updateMany count=0 → 抛 insufficientBalance（402），不通知。
//  - 并发不重复扣：原子条件扣款（updateMany where balanceCents>=price）由 count 控制。
//  - 幂等命中（已购买）：返回买家团队余额，不通知。
//  - 卖家收益进卖家当前/主团队（ensureCurrentTeam(sellerId)）。
// Mock PrismaService + AuthService + NotificationService，不连真实 DB。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EconomyService } from './economy.service';

function makePlugin(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'plugin-1',
    name: '插件A',
    priceCents: 1000,
    marketplace: true,
    reviewStatus: 'APPROVED',
    status: 'ENABLED',
    authorUserId: 'seller-1',
    ...overrides,
  };
}

function mockPrisma() {
  // purchase 流程：plugin.findFirst → purchase.findUnique（幂等）→ $transaction（team 扣款/加款/落单/2 条 BalanceLedger）
  //                → team.findUniqueOrThrow（返回买家团队余额）。
  const team = { updateMany: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn(async () => ({ balanceCents: 0 })) };
  const purchase = { findUnique: vi.fn(async () => null), create: vi.fn() };
  const balanceLedger = { create: vi.fn() };
  const auditLog = { create: vi.fn() };
  const tx = { team, purchase, balanceLedger };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return {
    plugin: { findFirst: vi.fn() },
    purchase,
    team,
    balanceLedger,
    auditLog,
    $transaction,
    __tx: tx,
  };
}

function mockAuth() {
  return {
    // 买家 → team-buyer，卖家 → team-seller。
    ensureCurrentTeam: vi.fn(async (userId: string) => ({
      teamId: userId === 'seller-1' ? 'team-seller' : 'team-buyer',
      userId,
      role: 'MEMBER',
    })),
    ensurePlatformAdmin: vi.fn(),
    ensureTeamAdmin: vi.fn(),
  };
}

function mockNotifications() {
  return { create: vi.fn(async () => ({})) };
}

describe('EconomyService purchase（团队余额结算 + 通知埋点）', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let notifications: ReturnType<typeof mockNotifications>;
  let service: EconomyService;

  beforeEach(() => {
    prisma = mockPrisma();
    auth = mockAuth();
    notifications = mockNotifications();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new EconomyService(prisma, auth, notifications);
  });

  it('购买成功：买家团队 DEBIT(plugin_purchase) + 卖家团队 CREDIT(plugin_sale)，通知卖家', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin()); // 价格 1000 分 = ¥10.00
    prisma.__tx.team.updateMany.mockResolvedValueOnce({ count: 1 }); // 买家团队条件扣款命中
    prisma.team.findUniqueOrThrow.mockResolvedValue({ balanceCents: 0 });

    const result = await service.purchase('buyer-1', 'plugin-1');
    expect(result.status).toBe('purchased');

    // 买家团队原子条件扣款（防透支）。
    expect(prisma.__tx.team.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'team-buyer', balanceCents: { gte: 1000 } },
      data: { balanceCents: { decrement: 1000 } },
    }));
    // 卖家团队加款。
    expect(prisma.__tx.team.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'team-seller' },
      data: { balanceCents: { increment: 1000 } },
    }));
    // 流水：买家 DEBIT(plugin_purchase) + 卖家 CREDIT(plugin_sale)。
    const buyerLedger = prisma.__tx.balanceLedger.create.mock.calls.find((c) => c[0].data.direction === 'DEBIT');
    expect(buyerLedger?.[0].data).toMatchObject({ teamId: 'team-buyer', amountCents: 1000, reason: 'plugin_purchase:plugin-1', actorUserId: 'buyer-1' });
    const sellerLedger = prisma.__tx.balanceLedger.create.mock.calls.find((c) => c[0].data.direction === 'CREDIT');
    expect(sellerLedger?.[0].data).toMatchObject({ teamId: 'team-seller', amountCents: 1000, reason: 'plugin_sale:plugin-1', actorUserId: 'seller-1' });

    expect(notifications.create).toHaveBeenCalledWith(
      'seller-1', 'purchase_sale', expect.any(String),
      expect.stringContaining('插件A'),
      { relatedType: 'Plugin', relatedId: 'plugin-1' },
    );
  });

  it('卖家收益进卖家当前/主团队（ensureCurrentTeam(sellerId)）', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin());
    prisma.__tx.team.updateMany.mockResolvedValueOnce({ count: 1 });
    await service.purchase('buyer-1', 'plugin-1');
    expect(auth.ensureCurrentTeam).toHaveBeenCalledWith('seller-1');
    expect(prisma.__tx.team.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'team-seller' } }));
  });

  it('团队余额不足抛 insufficientBalance（402），不通知（count=0）', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin());
    prisma.__tx.team.updateMany.mockResolvedValueOnce({ count: 0 }); // 余额不足，原子扣款未命中
    await expect(service.purchase('buyer-1', 'plugin-1')).rejects.toMatchObject({ status: 402 });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(prisma.__tx.team.update).not.toHaveBeenCalled(); // 卖家未加款
  });

  it('已购买（幂等命中）返回买家团队余额，不通知', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin());
    prisma.purchase.findUnique.mockResolvedValueOnce({ id: 'p0' }); // 已存在购买记录
    prisma.team.findUniqueOrThrow.mockResolvedValueOnce({ balanceCents: 500 });
    const result = await service.purchase('buyer-1', 'plugin-1');
    expect(result.status).toBe('already_purchased');
    expect((result as { balance_cents: number }).balance_cents).toBe(500);
    expect(notifications.create).not.toHaveBeenCalled();
    expect(prisma.__tx.team.updateMany).not.toHaveBeenCalled(); // 未发生扣款
  });

  it('插件不存在或未上架抛 not_found，不通知', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(null);
    await expect(service.purchase('buyer-1', 'plugin-1')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('购买成功后通知 create 抛错时主流程不阻塞（仍返回 purchased）', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin());
    prisma.__tx.team.updateMany.mockResolvedValueOnce({ count: 1 });
    notifications.create.mockRejectedValueOnce(new Error('db down'));
    const result = await service.purchase('buyer-1', 'plugin-1');
    expect(result.status).toBe('purchased');
  });

  it('购买自己的插件被拒（bad_request），不触发通知', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin({ authorUserId: 'buyer-1' }));
    await expect(service.purchase('buyer-1', 'plugin-1')).rejects.toMatchObject({ status: 400 });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('免费插件无需购买被拒（bad_request）', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin({ priceCents: 0 }));
    await expect(service.purchase('buyer-1', 'plugin-1')).rejects.toMatchObject({ status: 400 });
  });
});
