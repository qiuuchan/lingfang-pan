import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminService } from './admin.service';

const CREATED_AT = new Date('2026-07-12T08:00:00.000Z');
const REVIEWED_AT = new Date('2026-07-12T09:00:00.000Z');

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: 'application-1',
    userId: 'applicant-1',
    teamName: 'Alpha Team',
    reason: '需要团队空间',
    status: 'PENDING',
    reviewReason: '',
    reviewedAt: null,
    createdAt: CREATED_AT,
    user: { id: 'applicant-1', email: 'owner@example.com', displayName: 'Owner' },
    reviewedBy: null,
    ...overrides,
  };
}

function createHarness() {
  const events: string[] = [];
  const teamAdminApplication = {
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    findUnique: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const team = {
    create: vi.fn(async () => ({
      id: 'team-1',
      name: 'Alpha Team',
      slug: 'alpha-team-applic',
      status: 'ACTIVE',
      balanceCents: 0,
      defaultPoolId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })),
  };
  const role = { create: vi.fn(async () => ({})) };
  const teamMembership = { create: vi.fn(async () => ({})) };
  const auditLog = {
    create: vi.fn(async () => {
      events.push('audit');
      return {};
    }),
  };
  const tx = { teamAdminApplication, team, role, teamMembership, auditLog };
  const $transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
    events.push('transaction:start');
    try {
      const result = await callback(tx);
      events.push('transaction:commit');
      return result;
    } catch (error) {
      events.push('transaction:rollback');
      throw error;
    }
  });
  const prisma = { teamAdminApplication, team, role, teamMembership, auditLog, $transaction };
  const auth = { ensurePlatformAdmin: vi.fn(async () => ({})) };
  const notifications = {
    create: vi.fn(async () => {
      events.push('notification');
      return {};
    }),
  };
  const mail = {};
  // @ts-expect-error 聚焦 mock 只实现这些场景使用的依赖。
  const service = new AdminService(prisma, auth, notifications, mail);
  return { service, prisma, auth, notifications, events };
}

describe('AdminService team admin application governance', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it('服务端分页并用轻量 select 返回 summary，不读取审批理由', async () => {
    harness.prisma.teamAdminApplication.findMany.mockResolvedValueOnce([application()]);
    harness.prisma.teamAdminApplication.count.mockResolvedValueOnce(41);

    const result = await harness.service.adminApplications('admin-1', {
      page: 2,
      pageSize: 25,
      q: '  alpha  ',
      status: 'PENDING',
    });

    expect(result).toEqual({
      items: [
        {
          id: 'application-1',
          teamName: 'Alpha Team',
          status: 'PENDING',
          createdAt: CREATED_AT.toISOString(),
          user: { id: 'applicant-1', email: 'owner@example.com', displayName: 'Owner' },
        },
      ],
      total: 41,
      page: 2,
      pageSize: 25,
    });
    const query = harness.prisma.teamAdminApplication.findMany.mock.calls[0]?.[0];
    expect(query).toMatchObject({
      skip: 25,
      take: 25,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      where: {
        status: 'PENDING',
        OR: [
          { teamName: { contains: 'alpha', mode: 'insensitive' } },
          { user: { email: { contains: 'alpha', mode: 'insensitive' } } },
          { user: { displayName: { contains: 'alpha', mode: 'insensitive' } } },
        ],
      },
    });
    expect(query?.select).not.toHaveProperty('reason');
    expect(query?.select).not.toHaveProperty('reviewReason');
    expect(query?.select).not.toHaveProperty('reviewedBy');
    expect(harness.prisma.teamAdminApplication.count).toHaveBeenCalledWith({ where: query?.where });
  });

  it('详情按 id 单独读取完整理由、处理信息和用户白名单', async () => {
    harness.prisma.teamAdminApplication.findUnique.mockResolvedValueOnce(application({
      status: 'REJECTED',
      reviewReason: '资料不完整',
      reviewedAt: REVIEWED_AT,
      reviewedBy: { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin' },
    }));

    const result = await harness.service.adminApplication('admin-1', 'application-1');

    expect(result).toEqual({
      application: {
        id: 'application-1',
        teamName: 'Alpha Team',
        status: 'REJECTED',
        createdAt: CREATED_AT.toISOString(),
        user: { id: 'applicant-1', email: 'owner@example.com', displayName: 'Owner' },
        reason: '需要团队空间',
        reviewReason: '资料不完整',
        reviewedAt: REVIEWED_AT.toISOString(),
        reviewedBy: { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin' },
      },
    });
    expect(harness.prisma.teamAdminApplication.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'application-1' },
      select: expect.objectContaining({ reason: true, reviewReason: true, reviewedBy: expect.any(Object) }),
    }));
  });

  it('approve 在一个事务内抢占、建团、创建系统角色和 membership，提交后才通知', async () => {
    harness.prisma.teamAdminApplication.findUnique.mockResolvedValueOnce(application());

    const result = await harness.service.approveApplication('admin-1', 'application-1');

    expect(result.team.id).toBe('team-1');
    expect(harness.prisma.teamAdminApplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'application-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'APPROVED', reviewedById: 'admin-1' }),
    }));
    expect(harness.prisma.role.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ id: 'team-admin-team-1', code: 'team_admin', isSystem: true }),
    });
    expect(harness.prisma.role.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ id: 'team-member-team-1', code: 'team_member', isSystem: true }),
    });
    expect(harness.prisma.teamMembership.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        teamId: 'team-1',
        userId: 'applicant-1',
        role: 'TEAM_ADMIN',
        teamRoleId: 'team-admin-team-1',
      }),
    });
    expect(harness.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(harness.events.indexOf('transaction:commit')).toBeLessThan(harness.events.indexOf('notification'));
    expect(harness.notifications.create).toHaveBeenCalledWith(
      'applicant-1',
      'application_approved',
      expect.any(String),
      expect.any(String),
      { relatedType: 'Team', relatedId: 'team-1' },
    );
  });

  it('approve 抢占失败返回 409，事务内外均无副作用', async () => {
    harness.prisma.teamAdminApplication.findUnique.mockResolvedValueOnce(application({ status: 'REJECTED' }));
    harness.prisma.teamAdminApplication.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(harness.service.approveApplication('admin-1', 'application-1')).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });

    expect(harness.prisma.team.create).not.toHaveBeenCalled();
    expect(harness.prisma.role.create).not.toHaveBeenCalled();
    expect(harness.prisma.teamMembership.create).not.toHaveBeenCalled();
    expect(harness.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(harness.notifications.create).not.toHaveBeenCalled();
  });

  it('reject 在事务内抢占并写 audit，提交后通知并返回详情', async () => {
    harness.prisma.teamAdminApplication.findUnique
      .mockResolvedValueOnce(application())
      .mockResolvedValueOnce(application({
        status: 'REJECTED',
        reviewReason: '资料不完整',
        reviewedAt: REVIEWED_AT,
        reviewedBy: { id: 'admin-1', email: 'admin@example.com', displayName: 'Admin' },
      }));

    const result = await harness.service.rejectApplication('admin-1', 'application-1', '  资料不完整  ');

    expect(harness.prisma.teamAdminApplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'application-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'REJECTED', reviewReason: '资料不完整', reviewedById: 'admin-1' }),
    }));
    expect(harness.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'team_admin_application.rejected',
        metadata: { reason: '资料不完整' },
      }),
    });
    expect(result.application.reviewReason).toBe('资料不完整');
    expect(harness.events.indexOf('transaction:commit')).toBeLessThan(harness.events.indexOf('notification'));
    expect(harness.notifications.create).toHaveBeenCalledTimes(1);
  });

  it('reject 抢占失败返回 409，不写 audit 或通知', async () => {
    harness.prisma.teamAdminApplication.findUnique.mockResolvedValueOnce(application({ status: 'APPROVED' }));
    harness.prisma.teamAdminApplication.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(harness.service.rejectApplication('admin-1', 'application-1', '资料不完整')).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });

    expect(harness.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(harness.notifications.create).not.toHaveBeenCalled();
  });

  it.each([undefined, '   ', 'x'.repeat(501)])('reject 拒绝缺失、空白或超过 500 字的原因', async (reason) => {
    await expect(harness.service.rejectApplication('admin-1', 'application-1', reason)).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    });
    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('approve/reject 并发只允许一个终态、一个 audit 和一次通知', async () => {
    let terminalStatus: 'APPROVED' | 'REJECTED' | null = null;
    harness.prisma.teamAdminApplication.findUnique.mockImplementation(async ({ select }) => {
      if (select?.reason) {
        return application({
          status: terminalStatus ?? 'PENDING',
          reviewReason: terminalStatus === 'REJECTED' ? '资料不完整' : '',
          reviewedAt: terminalStatus ? REVIEWED_AT : null,
        });
      }
      return application();
    });
    harness.prisma.teamAdminApplication.updateMany.mockImplementation(async ({ data }) => {
      if (terminalStatus) return { count: 0 };
      terminalStatus = data.status as 'APPROVED' | 'REJECTED';
      return { count: 1 };
    });

    const results = await Promise.allSettled([
      harness.service.approveApplication('admin-1', 'application-1'),
      harness.service.rejectApplication('admin-2', 'application-1', '资料不完整'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { status: 409, code: 'conflict' },
    });
    expect(terminalStatus === 'APPROVED' || terminalStatus === 'REJECTED').toBe(true);
    expect(harness.prisma.teamAdminApplication.updateMany).toHaveBeenCalledTimes(2);
    expect(harness.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(harness.notifications.create).toHaveBeenCalledTimes(1);
  });
});
