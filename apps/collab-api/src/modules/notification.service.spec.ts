// NotificationService 单测（组B：通知系统）。
// 覆盖：
//  - create 写入正确字段（type/title/body/related）。
//  - listForUser 返回列表 + 未读数（unreadOnly 过滤，limit clamp）。
//  - markRead 按 userId 隔离：越权或不存在时 updateMany count=0 → not_found。
//  - markAllRead 批量更新当前用户未读。
//  - 埋点契约（AdminService/EconomyService 注入后触发 create）：单独在各自 service 测试中验证（见 admin/economy 埋点断言块）。
// 参考 release.service.spec.ts：Mock PrismaService，不连真实 DB。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NotificationService } from './notification.service';
import { notFound } from '../common';

const now = new Date('2026-06-15T00:00:00.000Z');

function makeNotification(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'n1',
    userId: 'user-1',
    type: 'plugin_approved',
    title: '插件审核通过',
    body: '你的插件已上架',
    read: false,
    relatedType: 'Plugin',
    relatedId: 'plugin-1',
    createdAt: now,
    ...overrides,
  };
}

function mockPrisma() {
  return {
    notification: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'n1',
        createdAt: now,
        ...args.data,
      })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

describe('NotificationService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: NotificationService;

  beforeEach(() => {
    prisma = mockPrisma();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new NotificationService(prisma);
  });

  describe('create', () => {
    it('写入正确字段（含 related 关联实体）', async () => {
      await service.create('user-1', 'plugin_approved', '插件审核通过', '已上架', {
        relatedType: 'Plugin',
        relatedId: 'plugin-1',
      });
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          type: 'plugin_approved',
          title: '插件审核通过',
          body: '已上架',
          relatedType: 'Plugin',
          relatedId: 'plugin-1',
        },
      });
    });

    it('related 缺省时 relatedType/relatedId 为 undefined（不带关联）', async () => {
      await service.create('user-1', 'system', '系统通知', '欢迎使用');
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ relatedType: undefined, relatedId: undefined }),
      });
    });
  });

  describe('listForUser', () => {
    it('返回列表 + 未读数（默认全部）', async () => {
      prisma.notification.findMany.mockResolvedValueOnce([makeNotification()]);
      prisma.notification.count.mockResolvedValueOnce(3);
      const result = await service.listForUser('user-1');
      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0].createdAt).toBe(now.toISOString());
      expect(result.unreadCount).toBe(3);
      // findMany 不带 read 过滤（unreadOnly 默认 false）。
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } })
      );
    });

    it('unreadOnly=true 时仅返回未读', async () => {
      prisma.notification.count.mockResolvedValueOnce(0);
      await service.listForUser('user-1', { unreadOnly: true });
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', read: false } })
      );
    });

    it('limit clamp 到 [1,100]（超出取 100，<=0 取 1）', async () => {
      prisma.notification.count.mockResolvedValue(0);
      await service.listForUser('user-1', { limit: 999 });
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 })
      );
      await service.listForUser('user-1', { limit: 0 });
      expect(prisma.notification.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 1 })
      );
    });
  });

  describe('markRead', () => {
    it('命中（count>0）返回 ok', async () => {
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 1 });
      const result = await service.markRead('n1', 'user-1');
      expect(result).toEqual({ ok: true });
      // 关键：updateMany where 带 userId 隔离，read:false 仅更新未读（避免重复置位）。
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n1', userId: 'user-1', read: false },
        data: { read: true },
      });
    });

    it('越权或不存在（count=0）抛 not_found，不泄漏存在性', async () => {
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.markRead('n1', 'user-other')).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });
    });
  });

  describe('markAllRead', () => {
    it('批量更新当前用户全部未读', async () => {
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 5 });
      const result = await service.markAllRead('user-1');
      expect(result).toEqual({ ok: true, updatedCount: 5 });
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', read: false },
        data: { read: true },
      });
    });
  });
});
