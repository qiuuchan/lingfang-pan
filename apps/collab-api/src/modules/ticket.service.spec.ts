// TicketService 单测：前台隔离、状态机、附件限制、越权下载、通知/审计埋点。
// Mock PrismaService / AuthService / NotificationService，不连真实 DB；附件落盘通过 mock 文件系统调用避免真实写盘。
// 参考 notification.service.spec.ts：构造 mock prisma，断言 where 隔离与状态推进。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TicketService } from './ticket.service';

const now = new Date('2026-06-25T00:00:00.000Z');

// 避免真实写盘：mock node:fs/promises 的写入操作。
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  copyFile: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ size: 10 })),
}));
vi.mock('node:fs', () => ({
  createReadStream: vi.fn(() => ({ pipe: vi.fn() })),
}));

function makeTicket(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    userId: 'user-1',
    teamId: 'team-1',
    category: 'BUG',
    title: '测试工单',
    status: 'OPEN',
    priority: 'NORMAL',
    handlerUserId: null,
    lastReplyAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function mockPrisma() {
  const ticket = {
    create: vi.fn(async () => ({ ...makeTicket(), messages: [{ id: 'm1' }] })),
    findUnique: vi.fn(async () => makeTicket()),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    update: vi.fn(async (args: { data: Record<string, unknown> }) => ({
      ...makeTicket(),
      ...args.data,
    })),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const ticketMessage = { create: vi.fn(async () => ({ id: 'm2' })) };
  const ticketAttachment = {
    create: vi.fn(async () => ({ id: 'a1' })),
    findUnique: vi.fn(async () => null),
  };
  const auditLog = { create: vi.fn(async () => ({})) };
  const user = {
    findUnique: vi.fn(async () => ({ id: 'user-1', displayName: 'U', email: 'u@x.com' })),
    findMany: vi.fn(async () => []),
  };
  const team = { findUnique: vi.fn(async () => ({ id: 'team-1', name: 'T' })) };
  const prisma = { ticket, ticketMessage, ticketAttachment, auditLog, user, team };
  return {
    ...prisma,
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma)
    ),
  };
}

function mockAuth(teamId: string | null = 'team-1') {
  return {
    ensureCurrentTeam: vi.fn(async () => {
      if (teamId === null) throw new Error('no team');
      return { teamId };
    }),
  };
}

function mockNotifications() {
  return { create: vi.fn(async () => ({})) };
}

function makeService(
  prisma: ReturnType<typeof mockPrisma>,
  auth = mockAuth(),
  notify = mockNotifications()
) {
  // @ts-expect-error mock 不实现完整接口，仅测用到的方法。
  return { service: new TicketService(prisma, auth, notify), auth, notify };
}

describe('TicketService', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    prisma = mockPrisma();
  });

  describe('create', () => {
    it('用当前团队 teamId 建工单 + 首条 USER 消息', async () => {
      const { service, auth } = makeService(prisma);
      // getForUser 在 create 末尾被调用，需 loadFull 返回带 messages/attachments 的工单。
      prisma.ticket.findUnique.mockResolvedValue({
        ...makeTicket(),
        messages: [],
        attachments: [],
      } as never);
      await service.create('user-1', { title: '标题', body: '描述', category: 'BUG' }, []);
      expect(auth.ensureCurrentTeam).toHaveBeenCalledWith('user-1');
      expect(prisma.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            teamId: 'team-1',
            title: '标题',
            status: 'OPEN',
          }),
        })
      );
    });

    it('无团队时 teamId 降级为 null，不阻断提交', async () => {
      const { service } = makeService(prisma, mockAuth(null));
      prisma.ticket.findUnique.mockResolvedValue({
        ...makeTicket({ teamId: null }),
        messages: [],
        attachments: [],
      } as never);
      await service.create('user-1', { title: '标题', body: '描述' }, []);
      expect(prisma.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ teamId: null }) })
      );
    });

    it('空标题抛 bad_request', async () => {
      const { service } = makeService(prisma);
      await expect(
        service.create('user-1', { title: '  ', body: '描述' }, [])
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('getForUser 越权隔离', () => {
    it('他人工单返回 not_found（不泄漏存在性）', async () => {
      const { service } = makeService(prisma);
      prisma.ticket.findUnique.mockResolvedValue({
        ...makeTicket({ userId: 'user-other' }),
        messages: [],
        attachments: [],
      } as never);
      await expect(service.getForUser('user-1', 't1')).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });
    });
  });

  describe('addUserMessage 状态机', () => {
    it('RESOLVED 工单用户回复 → 自动回到 IN_PROGRESS', async () => {
      const { service } = makeService(prisma);
      prisma.ticket.findUnique
        .mockResolvedValueOnce(makeTicket({ status: 'RESOLVED' }) as never) // 第一次：取状态
        .mockResolvedValue({
          ...makeTicket({ status: 'IN_PROGRESS' }),
          messages: [],
          attachments: [],
        } as never); // getForUser
      await service.addUserMessage('user-1', 't1', { body: '还没好' }, []);
      expect(prisma.ticket.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'RESOLVED' }),
          data: expect.objectContaining({ status: 'IN_PROGRESS' }),
        })
      );
    });

    it('CLOSED 工单不可追加回复', async () => {
      const { service } = makeService(prisma);
      prisma.ticket.findUnique.mockResolvedValue(makeTicket({ status: 'CLOSED' }) as never);
      await expect(service.addUserMessage('user-1', 't1', { body: 'x' }, [])).rejects.toMatchObject(
        { status: 400 }
      );
    });

    it('他人工单追加 → not_found', async () => {
      const { service } = makeService(prisma);
      prisma.ticket.findUnique.mockResolvedValue(makeTicket({ userId: 'other' }) as never);
      await expect(service.addUserMessage('user-1', 't1', { body: 'x' }, [])).rejects.toMatchObject(
        { status: 404 }
      );
    });
  });

  describe('addAdminMessage', () => {
    it('OPEN→IN_PROGRESS，记 handler，触发通知 + 审计', async () => {
      const { service, notify } = makeService(prisma);
      prisma.ticket.findUnique
        .mockResolvedValueOnce(makeTicket({ status: 'OPEN' }) as never)
        .mockResolvedValue({
          ...makeTicket({ status: 'IN_PROGRESS' }),
          messages: [],
          attachments: [],
        } as never);
      await service.addAdminMessage('admin-1', 't1', { body: '已处理' }, []);
      expect(prisma.ticket.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'OPEN' }),
          data: expect.objectContaining({ status: 'IN_PROGRESS', handlerUserId: 'admin-1' }),
        })
      );
      expect(prisma.auditLog.create).toHaveBeenCalled();
      expect(notify.create).toHaveBeenCalledWith(
        'user-1',
        'ticket_reply',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ relatedType: 'Ticket', relatedId: 't1' })
      );
    });

    it('关闭操作抢先完成时不再写入回复消息', async () => {
      const { service } = makeService(prisma);
      prisma.ticket.findUnique.mockResolvedValue(makeTicket({ status: 'OPEN' }) as never);
      prisma.ticket.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.addAdminMessage('admin-1', 't1', { body: '并发回复' }, [])
      ).rejects.toMatchObject({
        status: 409,
        code: 'conflict',
      });
      expect(prisma.ticketMessage.create).not.toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('非法状态转移抛 bad_request（CLOSED→OPEN）', async () => {
      const { service } = makeService(prisma);
      prisma.ticket.findUnique.mockResolvedValue(makeTicket({ status: 'CLOSED' }) as never);
      await expect(service.updateStatus('admin-1', 't1', { status: 'OPEN' })).rejects.toMatchObject(
        { status: 400 }
      );
    });

    it('无 status/priority 抛 bad_request', async () => {
      const { service } = makeService(prisma);
      await expect(service.updateStatus('admin-1', 't1', {})).rejects.toMatchObject({
        status: 400,
      });
    });

    it('状态被并发修改时拒绝覆盖新状态', async () => {
      const { service } = makeService(prisma);
      prisma.ticket.findUnique.mockResolvedValue(makeTicket({ status: 'OPEN' }) as never);
      prisma.ticket.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.updateStatus('admin-1', 't1', { status: 'CLOSED' })
      ).rejects.toMatchObject({
        status: 409,
        code: 'conflict',
      });
    });
  });

  describe('listAdmin', () => {
    it('返回稳定分页的摘要 items，列表查询使用白名单 select', async () => {
      const { service } = makeService(prisma);
      prisma.ticket.findMany.mockResolvedValue([]);
      const result = await service.listAdmin({ page: 2, pageSize: 10 });
      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
          orderBy: [{ lastReplyAt: 'desc' }, { id: 'desc' }],
          select: expect.objectContaining({
            title: true,
            user: { select: { id: true, displayName: true, email: true } },
            _count: { select: { messages: true, attachments: true } },
          }),
        })
      );
      expect(result).toEqual({ items: [], total: 0, page: 2, pageSize: 10 });
    });
  });

  describe('streamAttachment 下载越权', () => {
    it('非 admin 下载他人工单附件 → not_found', async () => {
      const { service } = makeService(prisma);
      prisma.ticketAttachment.findUnique.mockResolvedValue({
        id: 'a1',
        ticketId: 't1',
        storedName: 'x.log',
        filename: 'x.log',
        mimeType: 'text/plain',
        sizeBytes: 10,
        ticket: { id: 't1', userId: 'user-other' },
      } as never);
      await expect(
        service.streamAttachment('t1', 'a1', { userId: 'user-1', isAdmin: false })
      ).rejects.toMatchObject({ status: 404 });
    });

    it('admin 可下载任意附件', async () => {
      const { service } = makeService(prisma);
      prisma.ticketAttachment.findUnique.mockResolvedValue({
        id: 'a1',
        ticketId: 't1',
        storedName: 'x.log',
        filename: 'x.log',
        mimeType: 'text/plain',
        sizeBytes: 10,
        ticket: { id: 't1', userId: 'user-other' },
      } as never);
      const result = await service.streamAttachment('t1', 'a1', {
        userId: 'admin-1',
        isAdmin: true,
      });
      expect(result.filename).toBe('x.log');
    });

    it('附件不属于该工单 → not_found', async () => {
      const { service } = makeService(prisma);
      prisma.ticketAttachment.findUnique.mockResolvedValue({
        id: 'a1',
        ticketId: 'other-ticket',
        storedName: 'x.log',
        filename: 'x.log',
        mimeType: 'text/plain',
        sizeBytes: 10,
        ticket: { id: 'other-ticket', userId: 'user-1' },
      } as never);
      await expect(
        service.streamAttachment('t1', 'a1', { userId: 'user-1', isAdmin: false })
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
