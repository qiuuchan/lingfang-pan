// 跨租户越权数据库集成测试（commercial-readiness P2：多租户行级隔离 e2e）。
//
// 背景：平台为逻辑隔离（单库行级 teamId）。既有隔离测试均为 mock 级——mock prisma 无法暴露
// 「查询漏拼 teamId where 条件」这类真实 SQL 缺陷。本 spec 用真实 PG 验证：
//  - 成员关系不可冒认（ensureTeamMembership 精确解析）
//  - 团队管理面（移除成员/邀请码）无法越权操作他团资源，且不泄漏存在性（not_found 而非数据变更）
//  - 通知按 userId 行级隔离
//  - 自动化计划按资源 ID 访问时 teamId 过滤生效（跨团 pause/remove 无效）
// 每个越权用例都带正向对照（同团内操作成功），排除 fixture 缺陷导致的假阳性。
//
// 门控：CROSS_TENANT_DATABASE_INTEGRATION=1 才执行（同 plugin-shared-state 约定），
// 常规 `pnpm test` 下 describe.skip，不影响单测基线。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { TeamService } from './team.service';
import { NotificationService } from './notification.service';
import { AutomationScheduleService } from './automation-schedule.service';

const enabled = process.env.CROSS_TENANT_DATABASE_INTEGRATION === '1';
const databaseDescribe = enabled ? describe : describe.skip;

const suffix = randomUUID();
const teamAId = randomUUID();
const teamBId = randomUUID();
const adminAId = randomUUID();
const memberAId = randomUUID();
const adminBId = randomUUID();
const roleAId = randomUUID();
const roleBId = randomUUID();
const inviteBId = randomUUID();
const notifBId = randomUUID();
const scheduleAId = randomUUID();
const packageAId = randomUUID();
const releaseAId = randomUUID();

let prisma: PrismaService;
let auth: AuthService;
let teamService: TeamService;
let notificationService: NotificationService;
let scheduleService: AutomationScheduleService;

databaseDescribe(
  `跨租户越权隔离 database integration (${process.env.DATABASE_PROVIDER || 'unknown'})`,
  () => {
    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();

      // 两个相互隔离的团队。
      await prisma.team.create({
        data: { id: teamAId, name: `CT Team A ${suffix}`, slug: `ct-a-${suffix}` },
      });
      await prisma.team.create({
        data: { id: teamBId, name: `CT Team B ${suffix}`, slug: `ct-b-${suffix}` },
      });

      // 用户：A 管理员 / A 成员 / B 管理员。
      for (const [id, name] of [
        [adminAId, 'ct-admin-a'],
        [memberAId, 'ct-member-a'],
        [adminBId, 'ct-admin-b'],
      ] as const) {
        await prisma.user.create({
          data: {
            id,
            email: `${name}-${suffix}@example.test`,
            displayName: name,
            passwordHash: 'not-used',
          },
        });
      }

      // 团队级角色（含自动化计划管理权限，供 AutomationScheduleService.managementContext 解析）。
      for (const [id, teamId, name] of [
        [roleAId, teamAId, `CT Role A ${suffix}`],
        [roleBId, teamBId, `CT Role B ${suffix}`],
      ] as const) {
        await prisma.role.create({
          data: { id, name, scope: 'TEAM', teamId, permissions: ['team.plugin.edit_draft'] },
        });
      }

      // 成员关系：adminA/memberA ∈ A；adminB ∈ B（互不交叉）。
      await prisma.teamMembership.create({
        data: {
          teamId: teamAId,
          userId: adminAId,
          role: 'TEAM_ADMIN',
          teamRoleId: roleAId,
          status: 'ACTIVE',
        },
      });
      await prisma.teamMembership.create({
        data: {
          teamId: teamAId,
          userId: memberAId,
          role: 'MEMBER',
          teamRoleId: roleAId,
          status: 'ACTIVE',
        },
      });
      await prisma.teamMembership.create({
        data: {
          teamId: teamBId,
          userId: adminBId,
          role: 'TEAM_ADMIN',
          teamRoleId: roleBId,
          status: 'ACTIVE',
        },
      });

      // B 团邀请码（用于 A 团管理员越权禁用测试）。
      await prisma.invitationCode.create({
        data: {
          id: inviteBId,
          teamId: teamBId,
          codeHash: `ct-hash-${suffix}`,
          displayCodePrefix: 'LF-CT',
          createdById: adminBId,
          maxUses: 1,
        },
      });

      // adminB 的通知（用于跨用户已读越权测试）。
      await prisma.notification.create({
        data: { id: notifBId, userId: adminBId, type: 'cross_tenant_test', title: 'ct', body: '' },
      });

      // A 团插件包 + 发布（AutomationSchedule.workflowReleaseId 有 FK，须真实存在）。
      await prisma.pluginPackage.create({
        data: {
          id: packageAId,
          ownerTeamId: teamAId,
          authorUserId: adminAId,
          manifestId: `test.cross-tenant.${suffix}`,
          name: 'Cross Tenant Fixture Plugin',
        },
      });
      await prisma.pluginRelease.create({
        data: {
          id: releaseAId,
          packageId: packageAId,
          version: '1.0.0',
          manifest: { manifest_version: 1, id: `test.cross-tenant.${suffix}`, version: '1.0.0' },
          artifactKey: `cross-tenant/${suffix}.lfplugin`,
          sha256: 'c'.repeat(64),
          sizeBytes: 1,
          aiPolicyVersion: 1,
          aiPolicyStatus: 'PASSED',
        },
      });

      // 工作流发布包装（AutomationSchedule.workflowReleaseId FK → WorkflowRelease.pluginReleaseId）。
      await prisma.workflowRelease.create({
        data: {
          pluginReleaseId: releaseAId,
          definitionVersion: '1.0.0',
          definitionSha256: 'e'.repeat(64),
          definitionJson: { nodes: [] },
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object', properties: {} },
          cloudEligible: true,
          expandedNodeCount: 0,
          maxParallelism: 1,
        },
      });

      // A 团自动化计划（用于 B 团越权 pause/remove 测试）。
      await prisma.automationSchedule.create({
        data: {
          id: scheduleAId,
          teamId: teamAId,
          createdByUserId: adminAId,
          workflowReleaseId: releaseAId,
          workflowReleaseSha256: 'c'.repeat(64),
          kind: 'ONCE',
          runAt: new Date(Date.now() + 86_400_000),
          inputJson: {},
          inputSchemaSha256: 'd'.repeat(64),
          status: 'ACTIVE',
          generation: 1,
          schedulerKey: `ct-sched-${suffix}-1`,
          nextRunAt: new Date(Date.now() + 86_400_000),
        },
      });

      // 服务装配：真实 prisma + 真实 AuthService；mail/geetest/governance 打桩（本测试不触达）。
      const mail = { sendMail: vi.fn(async () => undefined) };
      const geetest = { isSceneEnabled: vi.fn(async () => false) };
      // @ts-expect-error 打桩仅实现被测路径用到的方法。
      auth = new AuthService(prisma, mail, geetest);
      // @ts-expect-error 同上。
      teamService = new TeamService(prisma, auth);
      notificationService = new NotificationService(prisma);
      const governance = { authorizeRelease: vi.fn(async () => undefined) };
      // @ts-expect-error 同上。
      scheduleService = new AutomationScheduleService(prisma, auth, governance);
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      // 按 FK 依赖逆序清理（auditLog.actor→user 为 Restrict，须先删）。
      await prisma.auditLog.deleteMany({
        where: { actorUserId: { in: [adminAId, memberAId, adminBId] } },
      });
      await prisma.automationOutbox.deleteMany({ where: { aggregateId: scheduleAId } });
      await prisma.automationSchedule.deleteMany({ where: { id: scheduleAId } });
      await prisma.workflowRelease.deleteMany({ where: { pluginReleaseId: releaseAId } });
      await prisma.pluginRelease.deleteMany({ where: { id: releaseAId } });
      await prisma.pluginPackage.deleteMany({ where: { id: packageAId } });
      await prisma.notification.deleteMany({ where: { id: notifBId } });
      await prisma.invitationCode.deleteMany({ where: { id: inviteBId } });
      await prisma.teamMembership.deleteMany({ where: { teamId: { in: [teamAId, teamBId] } } });
      await prisma.role.deleteMany({ where: { id: { in: [roleAId, roleBId] } } });
      await prisma.user.deleteMany({ where: { id: { in: [adminAId, memberAId, adminBId] } } });
      await prisma.team.deleteMany({ where: { id: { in: [teamAId, teamBId] } } });
      await prisma.$disconnect();
    }, 30_000);

    describe('A 成员关系基础（AuthService）', () => {
      it('ensureTeamMembership 无法冒认他团成员（403）', async () => {
        await expect(auth.ensureTeamMembership(adminAId, teamBId)).rejects.toMatchObject({
          status: 403,
          code: 'forbidden',
        });
      });

      it('ensureCurrentTeam 只解析到自己的团队', async () => {
        const membership = await auth.ensureCurrentTeam(adminAId);
        expect(membership.teamId).toBe(teamAId);
      });

      it('普通成员无团队管理员权限（403）', async () => {
        await expect(auth.ensureTeamAdmin(memberAId)).rejects.toMatchObject({
          status: 403,
          code: 'forbidden',
        });
      });
    });

    describe('B 团队管理面越权（TeamService）', () => {
      it('A 团管理员移除 B 团成员 → not_found，且 B 团 membership 不受影响', async () => {
        await expect(teamService.removeMember(adminAId, adminBId)).rejects.toMatchObject({
          status: 404,
          code: 'not_found',
        });
        const untouched = await prisma.teamMembership.findUnique({
          where: { teamId_userId: { teamId: teamBId, userId: adminBId } },
        });
        expect(untouched?.status).toBe('ACTIVE');
      });

      it('A 团管理员禁用 B 团邀请码 → not_found，邀请码保持 ACTIVE', async () => {
        await expect(teamService.disableInvitation(adminAId, inviteBId)).rejects.toMatchObject({
          status: 404,
          code: 'not_found',
        });
        const invite = await prisma.invitationCode.findUnique({ where: { id: inviteBId } });
        expect(invite?.status).toBe('ACTIVE');
      });

      it('listInvitations 不泄漏他团邀请码', async () => {
        const { invitations } = await teamService.listInvitations(adminAId);
        expect(invitations.map((i) => i.id)).not.toContain(inviteBId);
      });

      it('正向对照：A 团管理员移除本团成员成功', async () => {
        await expect(teamService.removeMember(adminAId, memberAId)).resolves.toMatchObject({
          ok: true,
        });
        const removed = await prisma.teamMembership.findUnique({
          where: { teamId_userId: { teamId: teamAId, userId: memberAId } },
        });
        expect(removed?.status).toBe('REMOVED');
      });
    });

    describe('C 通知用户级隔离（NotificationService）', () => {
      it('跨用户标记已读 → not_found，通知保持未读', async () => {
        await expect(notificationService.markRead(notifBId, adminAId)).rejects.toMatchObject({
          status: 404,
          code: 'not_found',
        });
        const notif = await prisma.notification.findUnique({ where: { id: notifBId } });
        expect(notif?.read).toBe(false);
      });

      it('正向对照：本人标记已读成功', async () => {
        await expect(notificationService.markRead(notifBId, adminBId)).resolves.toMatchObject({
          ok: true,
        });
      });
    });

    describe('D 自动化计划资源 ID 隔离（AutomationScheduleService）', () => {
      it('list 不返回他团计划', async () => {
        const { schedules } = await scheduleService.list(adminBId);
        expect(schedules.map((s: { id: string }) => s.id)).not.toContain(scheduleAId);
      });

      it('B 团越权 pause A 团计划 → not_found，计划保持 ACTIVE/generation 不变', async () => {
        await expect(scheduleService.pause(adminBId, scheduleAId, 1)).rejects.toMatchObject({
          status: 404,
          code: 'not_found',
        });
        const row = await prisma.automationSchedule.findUnique({ where: { id: scheduleAId } });
        expect(row?.status).toBe('ACTIVE');
        expect(row?.generation).toBe(1);
      });

      it('B 团越权 remove A 团计划 → not_found，计划未被删除', async () => {
        await expect(scheduleService.remove(adminBId, scheduleAId, 1)).rejects.toMatchObject({
          status: 404,
          code: 'not_found',
        });
        const row = await prisma.automationSchedule.findUnique({ where: { id: scheduleAId } });
        expect(row?.status).toBe('ACTIVE');
      });

      it('正向对照：A 团管理员 pause 本团计划成功', async () => {
        const result = await scheduleService.pause(adminAId, scheduleAId, 1);
        expect(result.schedule.status).toBe('PAUSED');
        const row = await prisma.automationSchedule.findUnique({ where: { id: scheduleAId } });
        expect(row?.status).toBe('PAUSED');
        expect(row?.generation).toBe(2);
      });
    });
  }
);
