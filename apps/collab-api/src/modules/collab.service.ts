import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma.service';
import { badRequest, conflict, forbidden, insufficientBalance, notFound, slugify } from '../common';
import { AuthService } from './auth.service';

const hashInvite = (code: string) => createHash('sha256').update(code.trim()).digest('hex');
const publicUser = (user: { id: string; email: string; displayName: string; status: string; platformRole?: string }) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  status: user.status,
  platformRole: user.platformRole,
});

@Injectable()
export class CollabService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  onboarding(userId: string) {
    return this.auth.me(userId);
  }

  async submitApplication(userId: string, input: { teamName: string; reason?: string }) {
    const pending = await this.prisma.teamAdminApplication.findFirst({ where: { userId, status: 'PENDING' } });
    if (pending) return { application: pending };
    const application = await this.prisma.teamAdminApplication.create({
      data: { userId, teamName: input.teamName?.trim() || '新团队', reason: input.reason?.trim() || '' },
    });
    await this.audit(userId, 'team_admin_application.created', 'TeamAdminApplication', application.id, { teamName: application.teamName });
    return { application };
  }

  async myApplication(userId: string) {
    const application = await this.prisma.teamAdminApplication.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return { application };
  }

  async redeemInvitation(userId: string, code: string) {
    const invite = await this.prisma.invitationCode.findUnique({ where: { codeHash: hashInvite(code) }, include: { team: true } });
    if (!invite || invite.status !== 'ACTIVE') throw badRequest('邀请码无效');
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) throw badRequest('邀请码已过期');
    if (invite.usedCount >= invite.maxUses) throw badRequest('邀请码已达到使用次数上限');
    if (invite.team.status !== 'ACTIVE') throw forbidden('团队当前不可加入');
    await this.prisma.$transaction(async (tx) => {
      await tx.teamMembership.upsert({
        where: { teamId_userId: { teamId: invite.teamId, userId } },
        create: { teamId: invite.teamId, userId, role: 'MEMBER' },
        update: { status: 'ACTIVE', role: 'MEMBER' },
      });
      await tx.invitationCode.update({ where: { id: invite.id }, data: { usedCount: { increment: 1 } } });
      await tx.auditLog.create({ data: { actorUserId: userId, action: 'invitation.redeemed', targetType: 'InvitationCode', targetId: invite.id, metadata: { teamId: invite.teamId } } });
    });
    return this.auth.me(userId);
  }

  async currentTeam(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    return { team: membership.team, role: membership.role };
  }

  async currentMembers(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const members = await this.prisma.teamMembership.findMany({
      where: { teamId: membership.teamId, status: 'ACTIVE' },
      include: { user: true },
      orderBy: { joinedAt: 'asc' },
    });
    return { members: members.map((m) => ({ teamId: m.teamId, userId: m.userId, role: m.role, joinedAt: m.joinedAt, user: publicUser(m.user) })) };
  }

  async removeMember(actorId: string, userId: string) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    if (actorId === userId) throw badRequest('不能移除自己');
    const target = await this.prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId: membership.teamId, userId } } });
    if (!target) throw notFound('成员不存在');
    if (target.role === 'TEAM_ADMIN') throw forbidden('不能移除团队管理员');
    await this.prisma.teamMembership.update({ where: { teamId_userId: { teamId: membership.teamId, userId } }, data: { status: 'REMOVED' } });
    await this.audit(actorId, 'team.member.removed', 'User', userId, { teamId: membership.teamId });
    return { ok: true };
  }

  async createInvitation(actorId: string, input: { maxUses?: number; expiresAt?: string }) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const code = `LF-${randomBytes(9).toString('base64url').toUpperCase()}`;
    const invite = await this.prisma.invitationCode.create({
      data: {
        teamId: membership.teamId,
        createdById: actorId,
        codeHash: hashInvite(code),
        displayCodePrefix: code.slice(0, 7),
        maxUses: Math.max(1, Number(input.maxUses || 1)),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });
    await this.audit(actorId, 'invitation.created', 'InvitationCode', invite.id, { teamId: membership.teamId });
    return { invitation: { ...invite, code } };
  }

  async listInvitations(actorId: string) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const invitations = await this.prisma.invitationCode.findMany({ where: { teamId: membership.teamId }, orderBy: { createdAt: 'desc' } });
    return { invitations };
  }

  async disableInvitation(actorId: string, id: string) {
    const membership = await this.auth.ensureTeamAdmin(actorId);
    const invite = await this.prisma.invitationCode.findFirst({ where: { id, teamId: membership.teamId } });
    if (!invite) throw notFound('邀请码不存在');
    await this.prisma.invitationCode.update({ where: { id }, data: { status: 'DISABLED' } });
    await this.audit(actorId, 'invitation.disabled', 'InvitationCode', id, { teamId: membership.teamId });
    return { ok: true };
  }

  async balance(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const team = await this.prisma.team.findUniqueOrThrow({ where: { id: membership.teamId } });
    return { balanceCents: team.balanceCents };
  }

  async ledger(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const ledger = await this.prisma.balanceLedger.findMany({ where: { teamId: membership.teamId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { ledger };
  }

  async consume(userId: string, input: { amountCents: number; reason?: string }) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const amount = Math.max(1, Number(input.amountCents || 0));
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.team.updateMany({ where: { id: membership.teamId, balanceCents: { gte: amount } }, data: { balanceCents: { decrement: amount } } });
      if (updated.count !== 1) throw insufficientBalance();
      await tx.balanceLedger.create({ data: { teamId: membership.teamId, amountCents: amount, direction: 'DEBIT', reason: input.reason || 'usage', actorUserId: userId } });
    });
    return this.balance(userId);
  }

  async availablePlugins() {
    const plugins = await this.prisma.plugin.findMany({ where: { status: 'ENABLED' }, orderBy: { createdAt: 'desc' } });
    return { plugins };
  }

  async adminDashboard(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const [users, teams, pendingApplications, plugins] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.team.count(),
      this.prisma.teamAdminApplication.count({ where: { status: 'PENDING' } }),
      this.prisma.plugin.count({ where: { status: 'ENABLED' } }),
    ]);
    return { users, teams, pendingApplications, enabledPlugins: plugins };
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
    const user = await this.prisma.user.update({ where: { id }, data: input });
    await this.audit(actorId, 'admin.user.updated', 'User', id, input);
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
    return { plugins: await this.prisma.plugin.findMany({ orderBy: { createdAt: 'desc' } }) };
  }

  async adminCreatePlugin(actorId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    throw forbidden('插件创建只允许通过本地客户端 Agent 发布流程，不支持管理端新增插件');
  }

  async adminUpdatePlugin(actorId: string, id: string, input: { name?: string; description?: string; status?: 'ENABLED' | 'DISABLED' }) {
    await this.auth.ensurePlatformAdmin(actorId);
    const plugin = await this.prisma.plugin.update({ where: { id }, data: input });
    await this.audit(actorId, 'admin.plugin.updated', 'Plugin', id, input);
    return { plugin };
  }

  async adminApplications(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const applications = await this.prisma.teamAdminApplication.findMany({ include: { user: true }, orderBy: { createdAt: 'desc' } });
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