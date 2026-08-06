import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { badRequest, forbidden, insufficientBalance, notFound, slugify } from '../common';
import { highestSemVer } from './plugin-registry-model';
import { SYSTEM_TEAM_ADMIN_ROLE_CODE, teamAdminRoleId, teamMemberRoleId } from './permissions/permission-codes';
import { applicationTeamSystemRoles } from './admin-applications';
import {
  ADMIN_TEAM_SUMMARY_SELECT,
  ADMIN_TEAM_MEMBER_SELECT,
  ADMIN_TEAM_DETAIL_SELECT,
  ADMIN_TEAM_PLUGIN_SELECT,
  ADMIN_TEAM_PURCHASE_SELECT,
  ADMIN_TEAM_LEDGER_SELECT,
  adminTeamOrderBy,
  adminTeamWhere,
  adminUserOption,
  normalizeAdminPage,
  type AdminTeamListQuery,
  type AdminPageQuery,
} from './admin-data-loading';

/**
 * 团队管理簇（deep module）。
 *
 * 从 AdminService 抽出的「团队」内聚职责：列表/增删改、成员与角色、余额调整、团队详情与插件/购买/流水看板。
 * AdminService 现在只是薄委托层（保持控制器与既有单测契约不变），本服务才是实现 + 私有 helper 的归属地，
 * 从而把 ~14 个方法的团队逻辑收敛到单一文件，改善 locality、降低 AdminService（上帝模块）体积。
 *
 * 不变量（沿用原实现，未改语义）：
 *  - 所有写操作置于 $transaction，余额变更必带 balanceLedger 流水（ADMIN-06 / ADMIN-10）。
 *  - 字段白名单（XLOG-01）、存在性前置校验（ADMIN-08/10）、幂等审计（H4/H5）全部保留。
 *  - 审计统一走本服务私有 audit()，与 AdminService.audit 同源同形（后续可进一步收敛为共享能力）。
 */
@Injectable()
export class AdminTeamsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async adminTeams(userId: string, query: AdminTeamListQuery = {}) {
    await this.auth.ensurePlatformAdmin(userId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where = adminTeamWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.team.findMany({
        where,
        orderBy: adminTeamOrderBy(query),
        skip,
        take: pageSize,
        select: ADMIN_TEAM_SUMMARY_SELECT,
      }),
      this.prisma.team.count({ where }),
    ]);
    const items = rows.map((team) => ({
      id: team.id,
      name: team.name,
      slug: team.slug,
      status: team.status,
      balanceCents: team.balanceCents,
      defaultPoolId: team.defaultPoolId,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      memberCount: team._count.memberships,
    }));
    return { items, total, page, pageSize };
  }

  async adminCreateTeam(actorId: string, input: { name: string; slug?: string; balanceCents?: number }) {
    await this.auth.ensurePlatformAdmin(actorId);
    const name = input.name.trim();
    // 修复 ADMIN-07：balanceCents 强制取整（Int 列不接受浮点，且避免浮点 cents 误差）。
    const balanceCents = Math.max(0, Math.floor(Number(input.balanceCents || 0)));
    // 修复 ADMIN-06：建团与初始流水放入同一事务，保证「余额变更必有流水」不变量。
    const team = await this.prisma.$transaction(async (tx) => {
      const created = await tx.team.create({ data: { name, slug: input.slug || slugify(name), balanceCents } });
      if (created.balanceCents > 0) {
        await tx.balanceLedger.create({ data: { teamId: created.id, amountCents: created.balanceCents, direction: 'CREDIT', reason: 'initial_balance', actorUserId: actorId } });
      }
      return created;
    });
    await this.audit(actorId, 'admin.team.created', 'Team', team.id, { name });
    return { team };
  }

  async adminUpdateTeam(actorId: string, id: string, input: { name?: string; status?: 'ACTIVE' | 'SUSPENDED'; defaultPoolId?: string | null }) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 修复 XLOG-01：显式字段白名单（此前 data: input 直接透传，可静默改 balanceCents 绕过流水审计）。
    const data: { name?: string; status?: 'ACTIVE' | 'SUSPENDED'; defaultPoolId?: string | null } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.status !== undefined) data.status = input.status;
    if (input.defaultPoolId !== undefined) {
      // 验证池子存在且团队有权使用（SHARED 或本团队的 DEDICATED）
      const normalizedPoolId = input.defaultPoolId === null || input.defaultPoolId === '' ? null : input.defaultPoolId;
      if (normalizedPoolId) {
        const pool = await this.prisma.pool.findUnique({ where: { id: normalizedPoolId }, select: { id: true, scope: true, teamId: true } });
        if (!pool) throw notFound('资源池不存在');
        const team = await this.prisma.team.findUnique({ where: { id }, select: { id: true } });
        if (!team) throw notFound('团队不存在');
        if (pool.scope === 'DEDICATED' && pool.teamId !== id) {
          throw forbidden('该专用池不属于当前团队');
        }
      }
      data.defaultPoolId = normalizedPoolId;
    }
    const team = await this.prisma.team.update({ where: { id }, data });
    await this.audit(actorId, 'admin.team.updated', 'Team', id, data);
    return { team };
  }

  // 软删除团队：参照 adminDeleteUser 的 DISABLED 模式，置为 SUSPENDED 而非物理级联删除（避免误删数据）。
  async adminDeleteTeam(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const team = await this.prisma.team.update({ where: { id }, data: { status: 'SUSPENDED' } });
    await this.audit(actorId, 'admin.team.deleted', 'Team', id, {});
    // 返回精简字段，不携带 memberships 等敏感 relation。
    return {
      team: {
        id: team.id,
        name: team.name,
        slug: team.slug,
        status: team.status,
        balanceCents: team.balanceCents,
        createdAt: team.createdAt,
        updatedAt: team.updatedAt,
      },
    };
  }

  async adminSetTeamAdmin(actorId: string, teamId: string, input: { userId: string }) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 修复 ADMIN-08：校验目标团队与用户状态，避免给已 SUSPENDED 团队或 DISABLED 用户授权产生僵尸管理员。
    const team = await this.prisma.team.findUnique({ where: { id: teamId }, select: { status: true } });
    if (!team || team.status !== 'ACTIVE') throw notFound('团队不存在或已挂起');
    const targetUser = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { status: true } });
    if (!targetUser || targetUser.status !== 'ACTIVE') throw notFound('用户不存在或已禁用');
    const membership = await this.prisma.$transaction(async (tx) => {
      const teamRoleId = await this.ensureSystemTeamRole(tx, teamId, 'TEAM_ADMIN');
      const updated = await tx.teamMembership.upsert({
        where: { teamId_userId: { teamId, userId: input.userId } },
        create: { teamId, userId: input.userId, role: 'TEAM_ADMIN', teamRoleId, status: 'ACTIVE' },
        update: { role: 'TEAM_ADMIN', teamRoleId, status: 'ACTIVE' },
      });
      await tx.user.update({
        where: { id: input.userId },
        data: { tokenVersion: { increment: 1 }, teamContextVersion: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'admin.team_admin.assigned',
          targetType: 'User',
          targetId: input.userId,
          metadata: { teamId, teamRoleId },
        },
      });
      return updated;
    });
    return { membership };
  }

  async adminRevokeTeamAdmin(actorId: string, teamId: string, targetUserId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const membership = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.teamMembership.findUnique({
        where: { teamId_userId: { teamId, userId: targetUserId } },
      });
      if (!existing) throw notFound('团队成员关系不存在');
      const teamRoleId = await this.ensureSystemTeamRole(tx, teamId, 'MEMBER');
      const updated = await tx.teamMembership.update({
        where: { teamId_userId: { teamId, userId: targetUserId } },
        data: { role: 'MEMBER', teamRoleId },
      });
      await tx.user.update({
        where: { id: targetUserId },
        data: { tokenVersion: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'admin.team_admin.revoked',
          targetType: 'User',
          targetId: targetUserId,
          metadata: { teamId, teamRoleId },
        },
      });
      return updated;
    });
    return { membership };
  }

  async adminAdjustBalance(actorId: string, teamId: string, input: { amountCents: number; direction: 'CREDIT' | 'DEBIT'; reason?: string }) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 修复 ADMIN-10：前置存在性校验，CREDIT 分支此前用无条件 team.update，团队不存在时 P2025 被吞成 500。
    const exists = await this.prisma.team.findUnique({ where: { id: teamId }, select: { id: true } });
    if (!exists) throw notFound('团队不存在');
    const amount = Math.max(1, Math.floor(Number(input.amountCents || 0)));
    await this.prisma.$transaction(async (tx) => {
      const data = input.direction === 'CREDIT' ? { balanceCents: { increment: amount } } : { balanceCents: { decrement: amount } };
      if (input.direction === 'DEBIT') {
        const updated = await tx.team.updateMany({ where: { id: teamId, balanceCents: { gte: amount } }, data });
        if (updated.count !== 1) throw insufficientBalance();
      } else {
        await tx.team.update({ where: { id: teamId }, data });
      }
      await tx.balanceLedger.create({ data: { teamId, amountCents: amount, direction: input.direction, reason: input.reason || 'admin_adjustment', actorUserId: actorId } });
      // 修复 H4：auditLog 写入移入事务，与 balanceLedger 原子提交。
      // 修复 H5：metadata 显式挑白名单字段，此前透传 input DTO 引用，shape 随 DTO 演进而漂移。
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'admin.team.balance_adjusted',
          targetType: 'Team',
          targetId: teamId,
          metadata: { teamId, amountCents: input.amountCents, direction: input.direction, reason: input.reason },
        },
      });
    });
    return this.prisma.team.findUnique({ where: { id: teamId } });
  }

  async adminTeamMembers(userId: string, teamId: string, query: AdminPageQuery & { q?: string } = {}) {
    await this.auth.ensurePlatformAdmin(userId);
    await this.ensureAdminTeamExists(teamId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where: Prisma.TeamMembershipWhereInput = { teamId };
    const keyword = query.q?.trim();
    if (keyword) {
      where.user = {
        is: {
          OR: [
            { email: { contains: keyword, mode: 'insensitive' } },
            { displayName: { contains: keyword, mode: 'insensitive' } },
          ],
        },
      };
    }
    const [rows, total] = await Promise.all([
      this.prisma.teamMembership.findMany({
        where,
        orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
        skip,
        take: pageSize,
        select: ADMIN_TEAM_MEMBER_SELECT,
      }),
      this.prisma.teamMembership.count({ where }),
    ]);
    const items = rows.map((membership) => ({
      teamId: membership.teamId,
      userId: membership.userId,
      role: membership.role,
      status: membership.status,
      teamRoleId: membership.teamRoleId,
      joinedAt: membership.joinedAt,
      user: adminUserOption(membership.user),
      teamRole: membership.teamRole ? {
        id: membership.teamRole.id,
        name: membership.teamRole.name,
        code: membership.teamRole.code,
      } : null,
    }));
    return { items, total, page, pageSize };
  }

  // 调整团队成员角色。平台 Admin 可在任意团队内为成员切换角色。
  // 与 adminSetTeamAdmin/adminRevokeTeamAdmin 区别：这两个是「指定/撤销」单向操作，
  // 此方法是「双向/任意」单一端点：前端成员 tab 角色下拉直接切换，可传枚举或 roleId（child-4 D7）。
  //
  // 输入兼容两种形态（service 双分支处理）：
  //  - { role: 'TEAM_ADMIN' | 'MEMBER' }：旧枚举（向后兼容旧前端），映射到对应系统角色并双写。
  //  - { roleId: '<role-id>' }：指定任意团队自定义角色（child-4 D7 新前端用），双写 teamRoleId + role 枚举
  //    （系统团队管理员 code → TEAM_ADMIN，否则 MEMBER），与 RoleService.assignMemberRole 同款语义。
  //  - 两者都未传：400 拒绝（DTO 用 @IsOptional 放宽，运行时显式校验）。
  async adminUpdateMemberRole(actorId: string, teamId: string, targetUserId: string, input: { role?: 'TEAM_ADMIN' | 'MEMBER'; roleId?: string }) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 前置存在性校验：update 在记录不存在时抛 P2025，此前被吞成 500（与 adminRevokeTeamAdmin 的 ADMIN-08 修复同源）。
    const existing = await this.prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId: targetUserId } } });
    if (!existing) throw notFound('团队成员关系不存在');

    // === 分支 1：roleId 形态（child-4 D7，指定任意团队角色）===
    if (input.roleId !== undefined) {
      const role = await this.prisma.role.findUnique({ where: { id: input.roleId } });
      if (!role || role.scope !== 'TEAM' || role.teamId !== teamId) throw badRequest('团队角色不存在');
      const isTeamAdmin = role.isSystem && role.code === SYSTEM_TEAM_ADMIN_ROLE_CODE;
      const nextRole: 'TEAM_ADMIN' | 'MEMBER' = isTeamAdmin ? 'TEAM_ADMIN' : 'MEMBER';
      // 幂等优化：role 与 teamRoleId 都未变则不重复写审计。
      if (existing.teamRoleId === role.id && existing.role === nextRole) {
        return { membership: existing };
      }
      const membership = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.teamMembership.update({
          where: { teamId_userId: { teamId, userId: targetUserId } },
          data: { teamRoleId: role.id, role: nextRole },
        });
        await tx.user.update({
          where: { id: targetUserId },
          data: { tokenVersion: { increment: 1 } },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: actorId,
            action: 'team.member.role_changed',
            targetType: 'User',
            targetId: targetUserId,
            metadata: {
              teamId,
              from: existing.role,
              to: nextRole,
              fromRoleId: existing.teamRoleId,
              toRoleId: role.id,
              managed: true,
            },
          },
        });
        return updated;
      });
      return { membership };
    }

    // === 分支 2：role 枚举形态（旧前端兼容）===
    if (input.role === undefined) throw badRequest('必须提供 role 或 roleId');
    const expectedRoleId = input.role === 'TEAM_ADMIN' ? teamAdminRoleId(teamId) : teamMemberRoleId(teamId);
    if (existing.role === input.role && existing.teamRoleId === expectedRoleId) return { membership: existing };
    const membership = await this.prisma.$transaction(async (tx) => {
      const teamRoleId = await this.ensureSystemTeamRole(tx, teamId, input.role!);
      const updated = await tx.teamMembership.update({
        where: { teamId_userId: { teamId, userId: targetUserId } },
        data: { role: input.role, teamRoleId },
      });
      await tx.user.update({
        where: { id: targetUserId },
        data: { tokenVersion: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'team.member.role_changed',
          targetType: 'User',
          targetId: targetUserId,
          metadata: {
            teamId,
            from: existing.role,
            to: input.role,
            fromRoleId: existing.teamRoleId,
            toRoleId: teamRoleId,
          },
        },
      });
      return updated;
    });
    return { membership };
  }

  // 团队启用/停用（ACTIVE↔SUSPENDED）。与 adminUpdateTeam 的 status 字段区别：
  // 此端点是专用状态切换，前端 footer 按钮直接用，语义明确；adminUpdateTeam 是综合信息更新（name+status）。
  // 不在此处重复审计 admin.team.updated：状态切换是更细粒度的事件，用独立 action 便于审计区分。
  async adminUpdateTeamStatus(actorId: string, teamId: string, input: { status: 'ACTIVE' | 'SUSPENDED' }) {
    await this.auth.ensurePlatformAdmin(actorId);
    const team = await this.prisma.team.findUnique({ where: { id: teamId }, select: { id: true, status: true } });
    if (!team) throw notFound('团队不存在');
    // 幂等优化：已是目标状态则不重复写审计，避免无变更操作污染审计日志。
    if (team.status === input.status) return { team };
    const updated = await this.prisma.team.update({ where: { id: teamId }, data: { status: input.status } });
    // action 统一前缀分类（team.status.suspended / team.status.activated）。
    const action = input.status === 'SUSPENDED' ? 'team.status.suspended' : 'team.status.activated';
    await this.audit(actorId, action, 'Team', teamId, { from: team.status, to: input.status });
    return { team: updated };
  }

  async adminTeamDetail(userId: string, teamId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: ADMIN_TEAM_DETAIL_SELECT,
    });
    if (!team) throw notFound('团队不存在');
    const [memberCount, roleCount, pluginCount, purchaseCount, ledgerAgg] = await Promise.all([
      this.prisma.teamMembership.count({ where: { teamId, status: 'ACTIVE' } }),
      this.prisma.role.count({ where: { scope: 'TEAM', teamId } }),
      this.prisma.pluginPackage.count({ where: { ownerTeamId: teamId } }),
      this.prisma.purchase.count({ where: { buyerTeamId: teamId } }),
      this.prisma.balanceLedger.groupBy({
        by: ['direction'],
        where: { teamId },
        _sum: { amountCents: true },
      }),
    ]);
    const creditSum = ledgerAgg.find((g) => g.direction === 'CREDIT')?._sum.amountCents ?? 0;
    const debitSum = ledgerAgg.find((g) => g.direction === 'DEBIT')?._sum.amountCents ?? 0;
    return {
      team: {
        id: team.id,
        name: team.name,
        slug: team.slug,
        status: team.status,
        allowPublicJoin: team.allowPublicJoin,
        description: team.description,
        balanceCents: team.balanceCents,
        defaultPoolId: team.defaultPoolId,
        createdAt: team.createdAt,
        updatedAt: team.updatedAt,
      },
      memberCount,
      roleCount,
      pluginCount,
      purchaseCount,
      ledgerSummary: { totalCreditCents: creditSum, totalDebitCents: debitSum, netCents: creditSum - debitSum },
    };
  }

  async adminTeamPlugins(userId: string, teamId: string, query: AdminPageQuery = {}) {
    await this.auth.ensurePlatformAdmin(userId);
    await this.ensureAdminTeamExists(teamId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where: Prisma.PluginPackageWhereInput = { ownerTeamId: teamId };
    const [rows, total] = await Promise.all([
      this.prisma.pluginPackage.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        select: ADMIN_TEAM_PLUGIN_SELECT,
      }),
      this.prisma.pluginPackage.count({ where }),
    ]);
    const items = rows.map((pluginPackage) => {
      const latestRelease = highestSemVer(pluginPackage.releases);
      return {
        id: pluginPackage.id,
        name: pluginPackage.name,
        version: latestRelease?.version ?? null,
        status: pluginPackage.governanceStatus === 'ACTIVE' ? 'ENABLED' : 'DISABLED',
        visibility: pluginPackage.listing?.status === 'ACTIVE' ? 'PUBLIC' : 'TEAM',
        reviewStatus: latestRelease?.marketReviewStatus ?? 'DRAFT',
        marketplace: pluginPackage.listing?.status === 'ACTIVE',
        priceCents: pluginPackage.listing?.priceCents ?? 0,
        installCount: pluginPackage.listing?.installCount ?? 0,
        createdAt: pluginPackage.createdAt,
        updatedAt: pluginPackage.updatedAt,
      };
    });
    return { items, total, page, pageSize };
  }

  async adminTeamPurchases(userId: string, teamId: string, query: AdminPageQuery = {}) {
    await this.auth.ensurePlatformAdmin(userId);
    await this.ensureAdminTeamExists(teamId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where: Prisma.PurchaseWhereInput = { buyerTeamId: teamId };
    const [rows, total] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        select: ADMIN_TEAM_PURCHASE_SELECT,
      }),
      this.prisma.purchase.count({ where }),
    ]);
    const items = rows.map((purchase) => ({
      id: purchase.id,
      pluginId: null,
      packageId: purchase.packageId,
      releaseId: purchase.releaseId,
      pluginName: purchase.package?.name ?? '未知插件',
      priceCents: purchase.priceCents,
      buyerUserId: purchase.buyerUserId,
      sellerUserId: purchase.sellerUserId,
      createdAt: purchase.createdAt,
    }));
    return { items, total, page, pageSize };
  }

  async adminTeamLedger(userId: string, teamId: string, query: AdminPageQuery = {}) {
    await this.auth.ensurePlatformAdmin(userId);
    await this.ensureAdminTeamExists(teamId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where: Prisma.BalanceLedgerWhereInput = { teamId };
    const [rows, total, ledgerAgg] = await Promise.all([
      this.prisma.balanceLedger.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        select: ADMIN_TEAM_LEDGER_SELECT,
      }),
      this.prisma.balanceLedger.count({ where }),
      this.prisma.balanceLedger.groupBy({
        by: ['direction'],
        where,
        _sum: { amountCents: true },
      }),
    ]);
    const totalCreditCents = ledgerAgg.find((entry) => entry.direction === 'CREDIT')?._sum.amountCents ?? 0;
    const totalDebitCents = ledgerAgg.find((entry) => entry.direction === 'DEBIT')?._sum.amountCents ?? 0;
    const items = rows.map((entry) => ({
      id: entry.id,
      teamId: entry.teamId,
      amountCents: entry.amountCents,
      direction: entry.direction,
      reason: entry.reason,
      actorUserId: entry.actorUserId,
      createdAt: entry.createdAt,
      actor: entry.actor ? {
        id: entry.actor.id,
        email: entry.actor.email,
        displayName: entry.actor.displayName,
      } : null,
    }));
    return {
      items,
      total,
      page,
      pageSize,
      summary: {
        totalCreditCents,
        totalDebitCents,
        netCents: totalCreditCents - totalDebitCents,
      },
    };
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }

  private async ensureSystemTeamRole(
    tx: Prisma.TransactionClient,
    teamId: string,
    legacyRole: 'TEAM_ADMIN' | 'MEMBER',
  ) {
    const roleId = legacyRole === 'TEAM_ADMIN' ? teamAdminRoleId(teamId) : teamMemberRoleId(teamId);
    const role = applicationTeamSystemRoles(teamId).roles.find((candidate) => candidate.id === roleId);
    if (!role) throw notFound('团队系统角色未初始化');
    await tx.role.upsert({
      where: { id: roleId },
      create: role,
      update: {},
    });
    return roleId;
  }

  private async ensureAdminTeamExists(id: string) {
    const team = await this.prisma.team.findUnique({ where: { id }, select: { id: true } });
    if (!team) throw notFound('团队不存在');
  }
}
