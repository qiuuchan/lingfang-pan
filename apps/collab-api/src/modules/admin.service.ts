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
    const [users, teams, pendingApplications, plugins, pendingPluginReviews] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.team.count(),
      this.prisma.teamAdminApplication.count({ where: { status: 'PENDING' } }),
      this.prisma.plugin.count({ where: { status: 'ENABLED' } }),
      this.prisma.plugin.count({ where: { reviewStatus: 'PENDING' } }),
    ]);
    return { users, teams, pendingApplications, enabledPlugins: plugins, pendingPluginReviews };
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
    // 显式仅取声明字段，丢弃 email/password 等客户端误传的非法键，避免透传进 prisma.user.update 触发 PrismaClientValidationError。
    const data: { displayName?: string; status?: 'ACTIVE' | 'DISABLED'; platformRole?: 'NONE' | 'PLATFORM_ADMIN' } = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.status !== undefined) data.status = input.status;
    if (input.platformRole !== undefined) data.platformRole = input.platformRole;
    const user = await this.prisma.user.update({ where: { id }, data });
    await this.audit(actorId, 'admin.user.updated', 'User', id, data);
    return { user: publicUser(user) };
  }

  async adminDeleteUser(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const user = await this.prisma.user.update({ where: { id }, data: { status: 'DISABLED' } });
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
    const team = await this.prisma.team.create({ data: { name, slug: input.slug || slugify(name), balanceCents: Number(input.balanceCents || 0) } });
    if (team.balanceCents > 0) await this.prisma.balanceLedger.create({ data: { teamId: team.id, amountCents: team.balanceCents, direction: 'CREDIT', reason: 'initial_balance', actorUserId: actorId } });
    await this.audit(actorId, 'admin.team.created', 'Team', team.id, { name });
    return { team };
  }

  async adminUpdateTeam(actorId: string, id: string, input: { name?: string; status?: 'ACTIVE' | 'SUSPENDED' }) {
    await this.auth.ensurePlatformAdmin(actorId);
    const team = await this.prisma.team.update({ where: { id }, data: input });
    await this.audit(actorId, 'admin.team.updated', 'Team', id, input);
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
    const membership = await this.prisma.teamMembership.upsert({
      where: { teamId_userId: { teamId, userId: input.userId } },
      create: { teamId, userId: input.userId, role: 'TEAM_ADMIN' },
      update: { role: 'TEAM_ADMIN', status: 'ACTIVE' },
    });
    await this.audit(actorId, 'admin.team_admin.assigned', 'User', input.userId, { teamId });
    return { membership };
  }

  async adminRevokeTeamAdmin(actorId: string, teamId: string, targetUserId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const membership = await this.prisma.teamMembership.update({ where: { teamId_userId: { teamId, userId: targetUserId } }, data: { role: 'MEMBER' } });
    await this.audit(actorId, 'admin.team_admin.revoked', 'User', targetUserId, { teamId });
    return { membership };
  }

  async adminAdjustBalance(actorId: string, teamId: string, input: { amountCents: number; direction: 'CREDIT' | 'DEBIT'; reason?: string }) {
    await this.auth.ensurePlatformAdmin(actorId);
    const amount = Math.max(1, Number(input.amountCents || 0));
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
    const plugin = await this.prisma.plugin.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        status: input.status,
        priceCents: input.priceCents === undefined ? undefined : Math.max(0, Number(input.priceCents)),
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
    const application = await this.prisma.teamAdminApplication.update({ where: { id }, data: { status: 'REJECTED', reviewReason: reason || '', reviewedById: actorId, reviewedAt: new Date() } });
    await this.audit(actorId, 'team_admin_application.rejected', 'TeamAdminApplication', id, { reason });
    return { application };
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