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
  // 邀请码模型：createInvitation 用 create，redeemInvitation 用 findUnique + 事务内 updateMany。
  const invitationCode = { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) };
  const tx = {
    teamMembership: { upsert: teamMembership.upsert },
    auditLog: { create: auditLog.create },
    invitationCode: { updateMany: invitationCode.updateMany },
  };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return { team, teamMembership, auditLog, invitationCode, $transaction, __tx: tx };
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

  // 修复 INVITE-CASE：邀请码兑换大小写无关。
  // hashInvite 是模块私有 const，无法直接调用，故端到端验证：
  // createInvitation 捕获存库 codeHash（生成 code 已大写），再用同一 code 的「全小写」形式兑换，
  // 断言 redeemInvitation 的 findUnique 命中的 codeHash 与存库完全一致 → 证明归一生效、不再误报"邀请码无效"。
  describe('邀请码大小写无关兑换（INVITE-CASE）', () => {
    it('小写输入与生成时大写 code 命中同一 codeHash', async () => {
      auth.ensureTeamAdmin.mockResolvedValue({ teamId: 't1', role: 'TEAM_ADMIN' });
      // 捕获 create 写入的 codeHash（由真实 hashInvite 算出）。
      let storedCodeHash = '';
      prisma.invitationCode.create.mockImplementation(async ({ data }: { data: { codeHash: string } }) => {
        storedCodeHash = data.codeHash;
        return { id: 'inv-1', ...data };
      });
      const { invitation } = await service.createInvitation('admin-1', { maxUses: 1 });
      const code = invitation.code as string;
      // 生成 code 形如 LF-XXXX（大写）。
      expect(code).toBe(code.toUpperCase());
      expect(storedCodeHash).not.toBe('');

      // 用全小写形式兑换，findUnique 命中的 codeHash 必须等于存库值。
      prisma.invitationCode.findUnique.mockResolvedValue({
        id: 'inv-1', status: 'ACTIVE', expiresAt: null, maxUses: 1, usedCount: 0,
        teamId: 't1', team: { status: 'ACTIVE' },
      });
      await service.redeemInvitation('u1', code.toLowerCase());
      const findArg = prisma.invitationCode.findUnique.mock.calls[0][0];
      expect(findArg.where.codeHash).toBe(storedCodeHash);
    });

    it('全小写 / 全大写 / 混合大小写 / 带空白输入命中同一 codeHash', async () => {
      auth.ensureTeamAdmin.mockResolvedValue({ teamId: 't1', role: 'TEAM_ADMIN' });
      let storedCodeHash = '';
      prisma.invitationCode.create.mockImplementation(async ({ data }: { data: { codeHash: string } }) => {
        storedCodeHash = data.codeHash;
        return { id: 'inv-2', ...data };
      });
      const { invitation } = await service.createInvitation('admin-1', { maxUses: 5 });
      const code = invitation.code as string;
      prisma.invitationCode.findUnique.mockResolvedValue({
        id: 'inv-2', status: 'ACTIVE', expiresAt: null, maxUses: 5, usedCount: 0,
        teamId: 't1', team: { status: 'ACTIVE' },
      });

      const variants = [code.toLowerCase(), code.toUpperCase(), `  ${code.toLowerCase()}  `];
      for (const variant of variants) {
        prisma.invitationCode.findUnique.mockClear();
        await service.redeemInvitation('u1', variant);
        expect(prisma.invitationCode.findUnique.mock.calls[0][0].where.codeHash).toBe(storedCodeHash);
      }
    });
  });
});
