import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma.service';
import { conflict, forbidden, insufficientBalance, notFound, publicUser, slugify } from '../common';
import { AuthService } from './auth.service';
import { publicPlugin } from './plugin-package';

@Injectable()
export class AdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async adminDashboard(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    // ADMIN-VIEW-03 修复：原仅返回 enabledPlugins，仪表盘「已禁用插件」待办数硬编码 0。
    // 现补一次 status='DISABLED' 的 plugin 计数，返回 disabledPlugins 让前端读到真实值。
    const [users, teams, pendingApplications, plugins, disabledPlugins, pendingPluginReviews] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.team.count(),
      this.prisma.teamAdminApplication.count({ where: { status: 'PENDING' } }),
      this.prisma.plugin.count({ where: { status: 'ENABLED' } }),
      this.prisma.plugin.count({ where: { status: 'DISABLED' } }),
      this.prisma.plugin.count({ where: { reviewStatus: 'PENDING' } }),
    ]);
    return { users, teams, pendingApplications, enabledPlugins: plugins, disabledPlugins, pendingPluginReviews };
  }

  // 平台级 AI 生成质量看板（调研报告 Top10 / A4）。
  // 首版复用现有 AuditLog 聚合，不新建 CliSessionLog 表（避免与组A schema 迁移冲突）：
  //   - 调用次数：llm_binding.key_decrypted（桌面每次发起 AI 生成都会解密 key → 一次会话即一次调用代理）。
  //   - 成功次数：plugin.uploaded（生成成功并上传团队云端，是产物落地的可靠信号）。
  //   - 失败次数：调用 - 成功（近似估算，因 audit 不记录每次失败，仅作为质量趋势参考）。
  //   - 全部基于 AuditLog count，零新表、零破坏式 DDL。
  async adminGenerationStats(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    // 月度窗口：当前自然月起始 → 现在（取本月初便于运营观察近期质量趋势）。
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [monthCalls, monthSuccess, totalCalls, totalSuccess] = await Promise.all([
      this.prisma.auditLog.count({ where: { action: 'llm_binding.key_decrypted', createdAt: { gte: monthStart } } }),
      this.prisma.auditLog.count({ where: { action: 'plugin.uploaded', createdAt: { gte: monthStart } } }),
      this.prisma.auditLog.count({ where: { action: 'llm_binding.key_decrypted' } }),
      this.prisma.auditLog.count({ where: { action: 'plugin.uploaded' } }),
    ]);
    const safeRate = (calls: number, success: number) => (calls > 0 ? Math.round((success / calls) * 1000) / 10 : 0);
    return {
      period: 'current_month',
      month: { calls: monthCalls, success: monthSuccess, failed: Math.max(0, monthCalls - monthSuccess), successRate: safeRate(monthCalls, monthSuccess) },
      total: { calls: totalCalls, success: totalSuccess, failed: Math.max(0, totalCalls - totalSuccess), successRate: safeRate(totalCalls, totalSuccess) },
      // 平均耗时暂缺（audit 未记录 duration），保留字段便于前端预留展示位，避免 NaN。
      avgDurationMs: null,
    };
  }

  // 平台级财务概览看板（调研报告 Top10 / C7）。
  // 全量基于现有 Purchase/Plugin 表聚合，不新建 PaymentOrder/PlatformFeePolicy 表：
  //   - GMV（月/累计）：sum(Purchase.priceCents)。平台抽成暂为 0（ADR-0002 明确放弃），platformRevenueCents 恒为 0。
  //   - 付费用户数：distinct Purchase.buyerUserId。
  //   - 付费转化率：付费用户 / 总用户（需 count User）。
  //   - Top5 热销插件：按 installCount 降序取前 5（市场插件，installCount 是 installMarketplacePlugin 维护的真实安装数）。
  async adminFinanceStats(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [monthGmvAgg, totalGmvAgg, paidBuyers, totalUsers, topPluginsRaw] = await Promise.all([
      // Prisma aggregate _sum 对空表返回 null，用 ?? 0 兜底避免 NaN。
      this.prisma.purchase.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { priceCents: true } }),
      this.prisma.purchase.aggregate({ _sum: { priceCents: true } }),
      this.prisma.purchase.findMany({ select: { buyerUserId: true }, distinct: ['buyerUserId'] }),
      this.prisma.user.count(),
      this.prisma.plugin.findMany({
        where: { marketplace: true },
        orderBy: [{ installCount: 'desc' }, { ratingCount: 'desc' }],
        take: 5,
        select: { id: true, name: true, installCount: true, ratingCount: true, ratingSum: true, priceCents: true },
      }),
    ]);
    const monthGmv = monthGmvAgg._sum.priceCents ?? 0;
    const totalGmv = totalGmvAgg._sum.priceCents ?? 0;
    const paidUserCount = paidBuyers.length;
    const conversionRate = totalUsers > 0 ? Math.round((paidUserCount / totalUsers) * 1000) / 10 : 0;
    const topPlugins = topPluginsRaw.map((p) => ({
      id: p.id,
      name: p.name,
      installCount: p.installCount,
      ratingCount: p.ratingCount,
      // 平均分：ratingCount>0 才计算，否则 0，避免除零 NaN。
      avgScore: p.ratingCount > 0 ? Math.round((p.ratingSum / p.ratingCount) * 10) / 10 : 0,
      priceCents: p.priceCents,
    }));
    return {
      period: 'current_month',
      month: { gmvCents: monthGmv },
      total: { gmvCents: totalGmv },
      // 平台抽成暂为 0（ADR-0002 放弃抽成现金流），保留字段为后续商业化预留。
      platformRevenueCents: 0,
      paidUserCount,
      totalUserCount: totalUsers,
      conversionRate,
      topPlugins,
    };
  }

  async adminUsers(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    return { users: users.map(publicUser) };
  }

  async adminCreateUser(actorId: string, input: { email: string; password: string; displayName?: string; platformRole?: 'NONE' | 'PLATFORM_ADMIN' }) {
    await this.auth.ensurePlatformAdmin(actorId);
    const email = input.email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(input.password || 'ChangeMe123!', 12);
    const user = await this.prisma.user.create({ data: { email, passwordHash, displayName: input.displayName || email, platformRole: input.platformRole || 'NONE' } });
    await this.audit(actorId, 'admin.user.created', 'User', user.id, { email });
    return { user: publicUser(user) };
  }

  async adminUpdateUser(actorId: string, id: string, input: { displayName?: string; status?: 'ACTIVE' | 'DISABLED'; platformRole?: 'NONE' | 'PLATFORM_ADMIN' }) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 修复 ADMIN-09：禁止自降级/自禁用（会锁死末位平台管理员）。
    if (id === actorId && (input.status === 'DISABLED' || input.platformRole === 'NONE')) {
      throw forbidden('不能禁用或降级自己的平台管理员权限');
    }
    // 修复 ADMIN-09：禁止禁用/降级最后一个 PLATFORM_ADMIN。
    if (input.status === 'DISABLED' || input.platformRole === 'NONE') {
      const target = await this.prisma.user.findUnique({ where: { id }, select: { platformRole: true, status: true } });
      if (target?.platformRole === 'PLATFORM_ADMIN' && target.status === 'ACTIVE') {
        const remainingAdmins = await this.prisma.user.count({ where: { platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' } });
        if (remainingAdmins <= 1) throw forbidden('不能禁用或降级最后一个平台管理员');
      }
    }
    // 显式仅取声明字段，丢弃 email/password 等客户端误传的非法键，避免透传进 prisma.user.update 触发 PrismaClientValidationError。
    const data: { displayName?: string; status?: 'ACTIVE' | 'DISABLED'; platformRole?: 'NONE' | 'PLATFORM_ADMIN'; tokenVersion?: { increment: number } } = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.status !== undefined) data.status = input.status;
    if (input.platformRole !== undefined) data.platformRole = input.platformRole;
    // 修复 ADMIN-02 / AUTH-01：禁用或降级时自增 tokenVersion，使已签发的旧 token 立即失效。
    if (input.status === 'DISABLED' || input.platformRole === 'NONE') data.tokenVersion = { increment: 1 };
    const user = await this.prisma.user.update({ where: { id }, data });
    await this.audit(actorId, 'admin.user.updated', 'User', id, data);
    return { user: publicUser(user) };
  }

  async adminDeleteUser(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 修复 ADMIN-09：禁止自禁用与禁用最后一个平台管理员。
    if (id === actorId) throw forbidden('不能禁用自己的账号');
    const target = await this.prisma.user.findUnique({ where: { id }, select: { platformRole: true, status: true } });
    if (target?.platformRole === 'PLATFORM_ADMIN' && target.status === 'ACTIVE') {
      const remainingAdmins = await this.prisma.user.count({ where: { platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' } });
      if (remainingAdmins <= 1) throw forbidden('不能禁用最后一个平台管理员');
    }
    // tokenVersion 自增使旧 token 立即失效（ADMIN-02）；此前旧 token 最长 7 天仍可用。
    const user = await this.prisma.user.update({ where: { id }, data: { status: 'DISABLED', tokenVersion: { increment: 1 } } });
    await this.audit(actorId, 'admin.user.disabled', 'User', id, {});
    return { user: publicUser(user) };
  }

  async adminTeams(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const teams = await this.prisma.team.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        memberships: {
          where: { status: 'ACTIVE' },
          include: { user: true },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });
    return {
      teams: teams.map((team) => ({
        ...team,
        memberships: undefined,
        members: team.memberships.map((membership) => ({ ...membership, user: publicUser(membership.user) })),
        memberCount: team.memberships.length,
      })),
    };
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

  async adminUpdateTeam(actorId: string, id: string, input: { name?: string; status?: 'ACTIVE' | 'SUSPENDED' }) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 修复 XLOG-01：显式字段白名单（此前 data: input 直接透传，可静默改 balanceCents 绕过流水审计）。
    const data: { name?: string; status?: 'ACTIVE' | 'SUSPENDED' } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.status !== undefined) data.status = input.status;
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
    const membership = await this.prisma.teamMembership.upsert({
      where: { teamId_userId: { teamId, userId: input.userId } },
      create: { teamId, userId: input.userId, role: 'TEAM_ADMIN', status: 'ACTIVE' },
      update: { role: 'TEAM_ADMIN', status: 'ACTIVE' },
    });
    await this.audit(actorId, 'admin.team_admin.assigned', 'User', input.userId, { teamId });
    return { membership };
  }

  async adminRevokeTeamAdmin(actorId: string, teamId: string, targetUserId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 修复 ADMIN-08：update 在记录不存在时抛 P2025，此前被吞成 500，现显式前置存在性校验返回 404。
    const existing = await this.prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId: targetUserId } } });
    if (!existing) throw notFound('团队成员关系不存在');
    const membership = await this.prisma.teamMembership.update({ where: { teamId_userId: { teamId, userId: targetUserId } }, data: { role: 'MEMBER' } });
    await this.audit(actorId, 'admin.team_admin.revoked', 'User', targetUserId, { teamId });
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
    });
    await this.audit(actorId, 'admin.team.balance_adjusted', 'Team', teamId, input);
    return this.prisma.team.findUnique({ where: { id: teamId } });
  }

  async adminPlugins(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const plugins = await this.prisma.plugin.findMany({ orderBy: { createdAt: 'desc' }, include: { team: true, author: true } });
    return { plugins: plugins.map((plugin) => publicPlugin(plugin, plugin.teamId || undefined)) };
  }

  async adminPluginReviewPending(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const plugins = await this.prisma.plugin.findMany({
      where: { reviewStatus: 'PENDING' },
      orderBy: { updatedAt: 'asc' },
      include: { team: true, author: true },
    });
    return { plugins: plugins.map((plugin) => publicPlugin(plugin, plugin.teamId || undefined)) };
  }

  async adminApprovePlugin(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    if (plugin.reviewStatus !== 'PENDING') throw conflict('插件不在审核中');
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.plugin.update({
        where: { id },
        data: { reviewStatus: 'APPROVED', reviewReason: '', reviewedById: actorId, reviewedAt: new Date(), marketplace: true, visibility: 'PUBLIC' },
      });
      await tx.pluginReview.create({ data: { pluginId: id, reviewerId: actorId, status: 'APPROVED', reason: '' } });
      await tx.auditLog.create({ data: { actorUserId: actorId, action: 'admin.plugin.approved', targetType: 'Plugin', targetId: id, metadata: { teamId: plugin.teamId } } });
      return next;
    });
    return { plugin: publicPlugin(updated, updated.teamId || undefined) };
  }

  async adminRejectPlugin(actorId: string, id: string, reason?: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    if (plugin.reviewStatus !== 'PENDING') throw conflict('插件不在审核中');
    const reviewReason = reason?.trim() || '未通过平台审核';
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.plugin.update({
        where: { id },
        data: { reviewStatus: 'REJECTED', reviewReason, reviewedById: actorId, reviewedAt: new Date(), marketplace: false, visibility: plugin.teamId ? 'TEAM' : plugin.visibility },
      });
      await tx.pluginReview.create({ data: { pluginId: id, reviewerId: actorId, status: 'REJECTED', reason: reviewReason } });
      await tx.auditLog.create({ data: { actorUserId: actorId, action: 'admin.plugin.rejected', targetType: 'Plugin', targetId: id, metadata: { teamId: plugin.teamId, reason: reviewReason } } });
      return next;
    });
    return { plugin: publicPlugin(updated, updated.teamId || undefined) };
  }

  async adminCreatePlugin(actorId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    throw forbidden('插件创建只允许通过本地客户端 Agent 发布流程，不支持管理端新增插件');
  }

  async adminUpdatePlugin(actorId: string, id: string, input: { name?: string; description?: string; status?: 'ENABLED' | 'DISABLED'; priceCents?: number }) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 修复 PLUGIN-09：前置存在性校验，此前 plugin.update 在 id 不存在时抛 P2025 被吞成 500。
    const existing = await this.prisma.plugin.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw notFound('插件不存在');
    const plugin = await this.prisma.plugin.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        status: input.status,
        priceCents: input.priceCents === undefined ? undefined : Math.max(0, Math.floor(Number(input.priceCents))),
      },
    });
    await this.audit(actorId, 'admin.plugin.updated', 'Plugin', id, input);
    return { plugin: publicPlugin(plugin, plugin.teamId || undefined) };
  }

  async adminApplications(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    // include reviewedBy 以便前端展示申请处理人（未处理时为 null）。
    const applications = await this.prisma.teamAdminApplication.findMany({ include: { user: true, reviewedBy: true }, orderBy: { createdAt: 'desc' } });
    return { applications };
  }

  async approveApplication(actorId: string, id: string) {
    const team = await this.auth.createTeamForApplication(id, actorId);
    return { team };
  }

  async rejectApplication(actorId: string, id: string, reason?: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 修复 AUTH-02 / XSM-01 / ADMIN-05：此前无 status==='PENDING' 守卫，
    // 可把已 APPROVED（已建团）的申请改回 REJECTED，造成状态与团队数据不一致。
    const application = await this.prisma.teamAdminApplication.findUnique({ where: { id } });
    if (!application) throw notFound('申请不存在');
    if (application.status !== 'PENDING') throw conflict('该申请已处理');
    const updated = await this.prisma.teamAdminApplication.update({ where: { id }, data: { status: 'REJECTED', reviewReason: reason || '', reviewedById: actorId, reviewedAt: new Date() } });
    await this.audit(actorId, 'team_admin_application.rejected', 'TeamAdminApplication', id, { reason });
    return { application: updated };
  }

  async auditLogs(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const logs = await this.prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { actor: true } });
    return { logs };
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}