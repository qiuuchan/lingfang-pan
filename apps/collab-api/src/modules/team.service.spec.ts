// TeamService 单测：覆盖公开团队发现 + 直接加入 + 团队资料更新（Top1 解法）。
//  - listPublicTeams：仅返回 allowPublicJoin=true + ACTIVE 的团队，按成员数降序。
//  - joinPublicTeam：团队不存在/未开放/非 ACTIVE 各自拒绝；成功时 upsert 成员并审计。
//  - updateTeamProfile：非团队管理员被 ensureTeamAdmin 拒绝（403）；正常更新 allowPublicJoin + description。
// 参考 release.service.spec.ts / admin.service.spec.ts：Mock PrismaService + AuthService，不连真实 DB。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TeamService } from './team.service';
import { forbidden, notFound } from '../common';

function mockPrisma() {
  const team = {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  };
  const teamMembership = { upsert: vi.fn() };
  const auditLog = { create: vi.fn() };
  const tx = { teamMembership: { upsert: teamMembership.upsert }, auditLog: { create: auditLog.create } };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return { team, teamMembership, auditLog, $transaction, __tx: tx };
}

function mockAuth() {
  return {
    ensureTeamAdmin: vi.fn(),
    ensureCurrentTeam: vi.fn(),
    me: vi.fn(async (userId: string) => ({ user: { id: userId }, team: { id: 'team-1' } })),
  };
}

describe('TeamService 公开团队发现 + 直接加入 + 资料', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let service: TeamService;

  beforeEach(() => {
    prisma = mockPrisma();
    auth = mockAuth();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new TeamService(prisma, auth);
  });

  describe('listPublicTeams', () => {
    it('仅返回 allowPublicJoin=true + ACTIVE 的团队，按成员数降序', async () => {
      prisma.team.findMany.mockResolvedValue([
        { id: 't1', name: '团队A', slug: 'a', description: 'd1', _count: { memberships: 3 } },
        { id: 't2', name: '团队B', slug: 'b', description: 'd2', _count: { memberships: 10 } },
        { id: 't3', name: '团队C', slug: 'c', description: 'd3', _count: { memberships: 5 } },
      ]);
      const result = await service.listPublicTeams();
      // 按成员数降序：t2(10) > t3(5) > t1(3)。
      expect(result.teams.map((t) => t.id)).toEqual(['t2', 't3', 't1']);
      expect(result.teams[0]).toEqual({ id: 't2', name: '团队B', slug: 'b', description: 'd2', memberCount: 10 });
      // findMany 必须带 allowPublicJoin=true + status=ACTIVE 过滤。
      expect(prisma.team.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { allowPublicJoin: true, status: 'ACTIVE' },
      }));
    });

    it('无公开团队时返回空数组', async () => {
      prisma.team.findMany.mockResolvedValue([]);
      const result = await service.listPublicTeams();
      expect(result.teams).toEqual([]);
    });
  });

  describe('joinPublicTeam', () => {
    it('团队不存在时抛 not_found', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.joinPublicTeam('u1', 'missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('团队未开放公开加入（allowPublicJoin=false）时抛 forbidden', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 't1', status: 'ACTIVE', allowPublicJoin: false });
      await expect(service.joinPublicTeam('u1', 't1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      // 校验失败时不写成员。
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('团队非 ACTIVE 时抛 forbidden', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 't1', status: 'SUSPENDED', allowPublicJoin: true });
      await expect(service.joinPublicTeam('u1', 't1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    });

    it('成功加入时 upsert 成员（ACTIVE/MEMBER）+ 审计 + 返回 session', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 't1', status: 'ACTIVE', allowPublicJoin: true });
      const result = await service.joinPublicTeam('u1', 't1');
      // upsert 带 teamId + userId，角色 MEMBER，刷新 joinedAt（重新激活已 REMOVED 成员）。
      expect(prisma.__tx.teamMembership.upsert).toHaveBeenCalledWith(expect.objectContaining({
        where: { teamId_userId: { teamId: 't1', userId: 'u1' } },
        create: { teamId: 't1', userId: 'u1', role: 'MEMBER' },
      }));
      // 审计 action=team.public_joined。
      expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'team.public_joined', targetId: 't1' }),
      }));
      // 返回 auth.me（最新 session）。
      expect(auth.me).toHaveBeenCalledWith('u1');
      expect(result).toEqual({ user: { id: 'u1' }, team: { id: 'team-1' } });
    });
  });

  describe('updateTeamProfile', () => {
    it('非团队管理员被 ensureTeamAdmin 拒绝（403）', async () => {
      auth.ensureTeamAdmin.mockImplementation(() => {
        throw forbidden('仅团队管理员可操作');
      });
      await expect(service.updateTeamProfile('u1', { allowPublicJoin: true })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.team.update).not.toHaveBeenCalled();
    });

    it('更新 allowPublicJoin + description 写库并审计', async () => {
      auth.ensureTeamAdmin.mockResolvedValue({ teamId: 't1', role: 'TEAM_ADMIN' });
      prisma.team.findUniqueOrThrow.mockResolvedValue({ id: 't1', name: '团队A', allowPublicJoin: true, description: '新简介' });
      const result = await service.updateTeamProfile('u1', { allowPublicJoin: true, description: '新简介' });
      expect(prisma.team.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { allowPublicJoin: true, description: '新简介' } });
      expect(result.team.allowPublicJoin).toBe(true);
    });

    it('description 超 500 字被截断', async () => {
      auth.ensureTeamAdmin.mockResolvedValue({ teamId: 't1', role: 'TEAM_ADMIN' });
      prisma.team.findUniqueOrThrow.mockResolvedValue({ id: 't1', name: '团队A', allowPublicJoin: false, description: '' });
      const longDesc = 'x'.repeat(600);
      await service.updateTeamProfile('u1', { description: longDesc });
      // slice(0,500) 截断。
      const call = (prisma.team.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.data.description.length).toBe(500);
    });

    it('空输入（无字段）不写库，直接返回当前 profile', async () => {
      auth.ensureTeamAdmin.mockResolvedValue({ teamId: 't1', role: 'TEAM_ADMIN' });
      prisma.team.findUniqueOrThrow.mockResolvedValue({ id: 't1', name: '团队A', allowPublicJoin: false, description: '' });
      await service.updateTeamProfile('u1', {});
      expect(prisma.team.update).not.toHaveBeenCalled();
    });
  });
});
