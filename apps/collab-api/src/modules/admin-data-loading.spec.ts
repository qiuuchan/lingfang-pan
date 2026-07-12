import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminService } from './admin.service';

const NOW = new Date('2026-07-12T00:00:00.000Z');

function mockPrisma() {
  return {
    user: {
      findMany: vi.fn(async () => [] as unknown[]),
      findUnique: vi.fn(),
      count: vi.fn(async () => 0),
    },
    auditLog: {
      findMany: vi.fn(async () => [] as unknown[]),
      findUnique: vi.fn(),
      count: vi.fn(async () => 0),
    },
    team: {
      findMany: vi.fn(async () => [] as unknown[]),
      findUnique: vi.fn(),
      count: vi.fn(async () => 0),
    },
    teamMembership: {
      findMany: vi.fn(async () => [] as unknown[]),
      count: vi.fn(async () => 0),
    },
  };
}

function mockAuth() {
  return { ensurePlatformAdmin: vi.fn(async () => undefined) };
}

describe('AdminService dynamic loading read models', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: AdminService;

  beforeEach(() => {
    prisma = mockPrisma();
    // @ts-expect-error focused Prisma/Auth mocks only implement read paths under test.
    service = new AdminService(prisma, mockAuth(), { create: vi.fn() }, { sendMail: vi.fn() });
  });

  it('paginates users with DB filters, a shared where, and an explicit no-secret select', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{
      id: 'u1',
      email: 'user@example.com',
      displayName: 'User',
      status: 'ACTIVE',
      platformRole: 'PLATFORM_ADMIN',
      platformRoleId: 'role-platform',
      emailVerified: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      passwordHash: 'must-not-leak',
      tokenVersion: 9,
    }]);
    prisma.user.count.mockResolvedValueOnce(12);

    const result = await service.adminUsers('admin', {
      page: 2,
      pageSize: 5,
      q: 'user',
      status: 'ACTIVE',
      platformRole: 'PLATFORM_ADMIN',
      sort: 'email',
      order: 'asc',
    });

    const listArgs = prisma.user.findMany.mock.calls[0][0] as Record<string, any>;
    const countArgs = prisma.user.count.mock.calls[0][0] as Record<string, any>;
    expect(listArgs).toMatchObject({ skip: 5, take: 5 });
    expect(countArgs.where).toBe(listArgs.where);
    expect(listArgs.where).toMatchObject({ status: 'ACTIVE', platformRole: 'PLATFORM_ADMIN' });
    expect(listArgs.select).not.toHaveProperty('passwordHash');
    expect(listArgs.select).not.toHaveProperty('tokenVersion');
    expect(result).toMatchObject({ total: 12, page: 2, pageSize: 5 });
    expect(result.items[0]).not.toHaveProperty('passwordHash');
    expect(result.items[0]).not.toHaveProperty('tokenVersion');
  });

  it('bounds user options at 50 and avoids a COUNT query for autocomplete', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{
      id: 'u1', email: 'user@example.com', displayName: 'User', status: 'ACTIVE', platformRole: 'NONE',
    }]);

    const result = await service.adminUserOptions('admin', { q: 'user', limit: 999 });

    const args = prisma.user.findMany.mock.calls[0][0] as Record<string, any>;
    expect(args.take).toBe(50);
    expect(args.where.status).toBe('ACTIVE');
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 50 });
  });

  it('keeps user login pages lightweight and uses the same where for rows/count', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1' });
    prisma.auditLog.findMany.mockResolvedValueOnce([{
      id: 'log-1', action: 'auth.login.success', createdAt: NOW, metadata: { ip: '127.0.0.1' },
    }]);
    prisma.auditLog.count.mockResolvedValueOnce(1);

    const result = await service.adminUserLogins('admin', 'u1', { page: 3, pageSize: 10 });

    const listArgs = prisma.auditLog.findMany.mock.calls[0][0] as Record<string, any>;
    const countArgs = prisma.auditLog.count.mock.calls[0][0] as Record<string, any>;
    expect(listArgs).toMatchObject({ skip: 20, take: 10 });
    expect(countArgs.where).toBe(listArgs.where);
    expect(listArgs.select).not.toHaveProperty('metadata');
    expect(result.items).toEqual([{ id: 'log-1', action: 'auth.login.success', createdAt: NOW }]);
  });

  it('lists teams without membership rows and keeps filtered count consistent', async () => {
    prisma.team.findMany.mockResolvedValueOnce([{
      id: 't1',
      name: 'Team',
      slug: 'team',
      status: 'ACTIVE',
      balanceCents: 10,
      defaultPoolId: null,
      createdAt: NOW,
      updatedAt: NOW,
      _count: { memberships: 4 },
      memberships: [{ user: { passwordHash: 'must-not-leak' } }],
    }]);
    prisma.team.count.mockResolvedValueOnce(8);

    const result = await service.adminTeams('admin', { page: 2, pageSize: 3, q: 'team', status: 'ACTIVE' });

    const listArgs = prisma.team.findMany.mock.calls[0][0] as Record<string, any>;
    const countArgs = prisma.team.count.mock.calls[0][0] as Record<string, any>;
    expect(listArgs).toMatchObject({ skip: 3, take: 3 });
    expect(countArgs.where).toBe(listArgs.where);
    expect(listArgs.select).not.toHaveProperty('memberships');
    expect(listArgs.select._count.select.memberships).toEqual({ where: { status: 'ACTIVE' } });
    expect(result.items[0]).toMatchObject({ id: 't1', memberCount: 4 });
    expect(result.items[0]).not.toHaveProperty('memberships');
  });

  it('filters team members in the database and strips nested user secrets', async () => {
    prisma.team.findUnique.mockResolvedValueOnce({ id: 't1' });
    prisma.teamMembership.findMany.mockResolvedValueOnce([{
      teamId: 't1',
      userId: 'u1',
      role: 'MEMBER',
      status: 'ACTIVE',
      teamRoleId: 'team-member-t1',
      joinedAt: NOW,
      user: {
        id: 'u1', email: 'user@example.com', displayName: 'User', status: 'ACTIVE', platformRole: 'NONE',
        passwordHash: 'must-not-leak', tokenVersion: 2,
      },
      teamRole: { id: 'team-member-t1', name: 'Member', code: 'team_member' },
    }]);
    prisma.teamMembership.count.mockResolvedValueOnce(1);

    const result = await service.adminTeamMembers('admin', 't1', { q: 'user' });

    const listArgs = prisma.teamMembership.findMany.mock.calls[0][0] as Record<string, any>;
    const countArgs = prisma.teamMembership.count.mock.calls[0][0] as Record<string, any>;
    expect(countArgs.where).toBe(listArgs.where);
    expect(listArgs.where.user.is.OR).toHaveLength(2);
    expect(result.items[0].user).not.toHaveProperty('passwordHash');
    expect(result.items[0].user).not.toHaveProperty('tokenVersion');
  });

  it('excludes audit metadata from pages and returns it only from detail', async () => {
    prisma.auditLog.findMany.mockResolvedValueOnce([{
      id: 'audit-1',
      action: 'admin.user.updated',
      targetType: 'User',
      targetId: 'u1',
      createdAt: NOW,
      metadata: { changed: ['email'] },
      actor: {
        id: 'admin', email: 'admin@example.com', displayName: 'Admin', passwordHash: 'must-not-leak',
      },
    }]);
    prisma.auditLog.count.mockResolvedValueOnce(1);

    const page = await service.auditLogs('admin', { q: 'user', actorId: 'admin', targetType: 'User' });
    const listArgs = prisma.auditLog.findMany.mock.calls[0][0] as Record<string, any>;
    const countArgs = prisma.auditLog.count.mock.calls[0][0] as Record<string, any>;
    expect(countArgs.where).toBe(listArgs.where);
    expect(listArgs.select).not.toHaveProperty('metadata');
    expect(page.items[0]).not.toHaveProperty('metadata');
    expect(page.items[0].actor).not.toHaveProperty('passwordHash');

    prisma.auditLog.findUnique.mockResolvedValueOnce({
      id: 'audit-1',
      action: 'admin.user.updated',
      targetType: 'User',
      targetId: 'u1',
      createdAt: NOW,
      metadata: { changed: ['email'] },
      actor: {
        id: 'admin', email: 'admin@example.com', displayName: 'Admin', passwordHash: 'must-not-leak',
      },
    });
    const detail = await service.auditLog('admin', 'audit-1');
    const detailArgs = prisma.auditLog.findUnique.mock.calls[0][0] as Record<string, any>;
    expect(detailArgs.select.metadata).toBe(true);
    expect(detail.log.metadata).toEqual({ changed: ['email'] });
    expect(detail.log.actor).not.toHaveProperty('passwordHash');
  });
});
