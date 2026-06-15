// EconomyService 单测：聚焦组B 通知埋点契约（purchase 成功通知 seller）。
//  - purchase_success_notifies_seller：购买成功后 notifications.create(sellerId, 'purchase_sale', ...)。
//  - purchase_already_purchased_skips_notification：幂等命中（已购买）不通知。
//  - purchase_failure_skips_notification：余额不足抛 insufficientBalance，不触发通知。
// 参考 release.service.spec.ts：Mock PrismaService + AuthService + NotificationService，不连真实 DB。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EconomyService } from './economy.service';
import { insufficientBalance, notFound } from '../common';

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
  // purchase 流程：plugin.findFirst → purchase.findUnique（幂等）→ $transaction（扣款/加款/落单/流水）
  //                → wallet.upsert（ensureWallet）。
  // 余额校验在 $transaction 内 wallet.updateMany count 控制。
  const wallet = { updateMany: vi.fn(), upsert: vi.fn() };
  const purchase = { findUnique: vi.fn(async () => null), create: vi.fn() };
  const walletTransaction = { create: vi.fn(), findFirst: vi.fn(async () => ({ id: 'wt0' })) };
  const auditLog = { create: vi.fn() };
  const tx = { wallet, purchase, walletTransaction };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return {
    plugin: { findFirst: vi.fn() },
    purchase,
    wallet,
    walletTransaction,
    auditLog,
    $transaction,
    __tx: tx,
  };
}

function mockAuth() {
  return {
    ensureCurrentTeam: vi.fn(async () => ({ teamId: 'team-1', userId: 'buyer-1', role: 'MEMBER' })),
    ensurePlatformAdmin: vi.fn(),
    ensureTeamAdmin: vi.fn(),
  };
}

function mockNotifications() {
  return { create: vi.fn(async () => ({})) };
}

describe('EconomyService purchase 通知埋点', () => {
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

  it('购买成功后通知卖家（type=purchase_sale，sellerId 正确，body 含插件名与金额）', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin()); // 价格 1000 分 = ¥10.00
    // ensureWallet 两次调用：第一次幂等检查前（purchase.findUnique 之前不调），purchase 成功后调一次。
    prisma.wallet.upsert.mockResolvedValue({ userId: 'buyer-1', balanceCents: 0 });
    // $transaction 内 wallet.updateMany 命中（count=1）。
    prisma.__tx.wallet.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await service.purchase('buyer-1', 'plugin-1');
    expect(result.status).toBe('purchased');
    expect(notifications.create).toHaveBeenCalledWith(
      'seller-1', 'purchase_sale', expect.any(String),
      expect.stringContaining('插件A'), // body 含插件名
      { relatedType: 'Plugin', relatedId: 'plugin-1' },
    );
  });

  it('已购买（幂等命中）不触发通知（status=already_purchased）', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin());
    prisma.purchase.findUnique.mockResolvedValueOnce({ id: 'p0' }); // 已存在购买记录
    prisma.wallet.upsert.mockResolvedValue({ userId: 'buyer-1', balanceCents: 500 });
    const result = await service.purchase('buyer-1', 'plugin-1');
    expect(result.status).toBe('already_purchased');
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('余额不足抛 insufficientBalance，不触发通知', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin());
    prisma.__tx.wallet.updateMany.mockResolvedValueOnce({ count: 0 }); // 余额不足
    await expect(service.purchase('buyer-1', 'plugin-1')).rejects.toMatchObject({ status: 402 });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('插件不存在或未上架抛 not_found，不触发通知', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(null);
    await expect(service.purchase('buyer-1', 'plugin-1')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('购买成功后通知 create 抛错时主流程不阻塞（仍返回 purchased）', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin());
    prisma.wallet.upsert.mockResolvedValue({ userId: 'buyer-1', balanceCents: 0 });
    prisma.__tx.wallet.updateMany.mockResolvedValueOnce({ count: 1 });
    notifications.create.mockRejectedValueOnce(new Error('db down'));
    const result = await service.purchase('buyer-1', 'plugin-1');
    expect(result.status).toBe('purchased');
  });

  it('购买自己的插件被拒（bad_request），不触发通知', async () => {
    prisma.plugin.findFirst.mockResolvedValueOnce(makePlugin({ authorUserId: 'buyer-1' }));
    await expect(service.purchase('buyer-1', 'plugin-1')).rejects.toMatchObject({ status: 400 });
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
