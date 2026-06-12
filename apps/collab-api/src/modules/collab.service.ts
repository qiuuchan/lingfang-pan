import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
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

type PluginFileInput = {
  path: string;
  content: string;
};

type PluginManifestInput = {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  runtime_type?: string;
  runtimeType?: string;
  entry?: string;
  visibility?: string;
  capabilities?: Array<{ kind?: string; reason?: string; risk?: string; requires_admin?: boolean; scope?: unknown }>;
};

type PluginPackageInput = {
  manifest?: PluginManifestInput;
  files?: PluginFileInput[];
  priceCents?: number;
};

type NormalizedPluginPackage = {
  manifest: {
    id: string;
    name: string;
    version: string;
    description: string;
    runtime_type: 'client' | 'cloud';
    entry: string;
    visibility: 'private' | 'tenant';
    capabilities: Array<{ kind: string; reason: string; risk: string; requires_admin: boolean; scope?: unknown }>;
  };
  files: PluginFileInput[];
  runtimeType: 'CLIENT' | 'CLOUD';
  visibility: 'PRIVATE' | 'TEAM';
  contentHash: string;
};

const MAX_PLUGIN_FILES = 80;
const MAX_PLUGIN_FILE_BYTES = 256 * 1024;
const MAX_PLUGIN_TOTAL_BYTES = 2 * 1024 * 1024;
const ALLOWED_CAPABILITIES = new Set([
  'ui.view', 'fs.pick', 'fs.read', 'fs.write', 'net.fetch',
  'clipboard', 'llm.chat', 'storage.kv',
  'system.info', 'system.screenshot', 'system.notify',
  'code-assistant.run', 'code-assistant.session', 'plugin.upload', 'plugin.submitMarketplace',
]);

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

  async uploadPlugin(userId: string, input: PluginPackageInput) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    if (membership.team.status !== 'ACTIVE') throw forbidden('团队当前不可上传插件');
    const normalized = this.normalizePluginPackage(input);
    const existing = await this.prisma.plugin.findUnique({
      where: { teamId_contentHash: { teamId: membership.teamId, contentHash: normalized.contentHash } },
    });
    if (existing) return { plugin: this.publicPlugin(existing, membership.teamId), deduplicated: true };

    const plugin = await this.prisma.plugin.create({
      data: {
        name: normalized.manifest.name,
        description: normalized.manifest.description,
        version: normalized.manifest.version,
        entry: normalized.manifest.entry,
        runtimeType: normalized.runtimeType,
        visibility: normalized.visibility,
        teamId: membership.teamId,
        authorUserId: userId,
        files: normalized.files as unknown as Prisma.InputJsonValue,
        manifest: normalized.manifest as unknown as Prisma.InputJsonValue,
        capabilities: normalized.manifest.capabilities as unknown as Prisma.InputJsonValue,
        contentHash: normalized.contentHash,
        reviewStatus: 'DRAFT',
        marketplace: false,
        priceCents: Math.max(0, Number(input.priceCents || 0)),
      },
    });
    await this.audit(userId, 'plugin.uploaded', 'Plugin', plugin.id, { teamId: membership.teamId, contentHash: normalized.contentHash });
    return { plugin: this.publicPlugin(plugin, membership.teamId), deduplicated: false };
  }

  async myPlugins(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugins = await this.prisma.plugin.findMany({
      where: { authorUserId: userId, teamId: membership.teamId },
      orderBy: { updatedAt: 'desc' },
    });
    return { plugins: plugins.map((plugin) => this.publicPlugin(plugin, membership.teamId)) };
  }

  async availablePlugins(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugins = await this.prisma.plugin.findMany({
      where: {
        status: 'ENABLED',
        OR: [
          { teamId: membership.teamId, visibility: 'TEAM' },
          { teamId: membership.teamId, visibility: 'PRIVATE', authorUserId: userId },
          { marketplace: true, reviewStatus: 'APPROVED', visibility: 'PUBLIC' },
          { installations: { some: { teamId: membership.teamId, status: 'ENABLED' } } },
        ],
      },
      orderBy: [{ marketplace: 'asc' }, { updatedAt: 'desc' }],
    });
    return { plugins: plugins.map((plugin) => this.publicPlugin(plugin, membership.teamId)) };
  }

  async submitPluginToMarketplace(userId: string, id: string, input: { priceCents?: number }) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    this.ensurePluginManager(plugin, membership.teamId, userId, membership.role);
    if (plugin.status !== 'ENABLED') throw forbidden('已禁用插件不能提交市场');
    if (plugin.reviewStatus === 'PENDING') throw conflict('插件已在审核中');

    const priceCents = Math.max(0, Number(input.priceCents || plugin.priceCents || 0));
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.plugin.update({
        where: { id },
        data: { marketplace: true, priceCents, reviewStatus: 'PENDING', reviewReason: '', reviewedById: null, reviewedAt: null },
      });
      await tx.pluginReview.create({ data: { pluginId: id, status: 'PENDING', reason: '' } });
      await tx.auditLog.create({ data: { actorUserId: userId, action: 'plugin.marketplace.submitted', targetType: 'Plugin', targetId: id, metadata: { teamId: membership.teamId, priceCents } } });
      return next;
    });
    return { plugin: this.publicPlugin(updated, membership.teamId) };
  }

  async editPluginDraft(userId: string, id: string, input: PluginPackageInput) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    this.ensurePluginManager(plugin, membership.teamId, userId, membership.role);
    if (plugin.reviewStatus === 'PENDING') throw conflict('审核中的插件不能编辑，请等待审核完成或联系平台管理员');

    const normalized = this.normalizePluginPackage(input);
    const duplicated = await this.prisma.plugin.findUnique({
      where: { teamId_contentHash: { teamId: membership.teamId, contentHash: normalized.contentHash } },
    });
    if (duplicated && duplicated.id !== id) throw conflict('团队内已存在相同内容的插件', { pluginId: duplicated.id });

    const updated = await this.prisma.plugin.update({
      where: { id },
      data: {
        name: normalized.manifest.name,
        description: normalized.manifest.description,
        version: normalized.manifest.version,
        entry: normalized.manifest.entry,
        runtimeType: normalized.runtimeType,
        visibility: normalized.visibility,
        files: normalized.files as unknown as Prisma.InputJsonValue,
        manifest: normalized.manifest as unknown as Prisma.InputJsonValue,
        capabilities: normalized.manifest.capabilities as unknown as Prisma.InputJsonValue,
        contentHash: normalized.contentHash,
        reviewStatus: 'DRAFT',
        reviewReason: '',
        reviewedById: null,
        reviewedAt: null,
        marketplace: false,
      },
    });
    await this.audit(userId, 'plugin.draft.edited', 'Plugin', id, { teamId: membership.teamId, contentHash: normalized.contentHash });
    return { plugin: this.publicPlugin(updated, membership.teamId) };
  }

  async installMarketplacePlugin(userId: string, id: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin || plugin.status !== 'ENABLED' || plugin.reviewStatus !== 'APPROVED' || !plugin.marketplace || plugin.visibility !== 'PUBLIC') {
      throw notFound('市场插件不存在或不可安装');
    }
    const existing = await this.prisma.pluginInstallation.findUnique({ where: { pluginId_teamId: { pluginId: id, teamId: membership.teamId } } });
    const installation = existing
      ? await this.prisma.pluginInstallation.update({ where: { id: existing.id }, data: { status: 'ENABLED', version: plugin.version, installedById: userId } })
      : await this.prisma.$transaction(async (tx) => {
          const created = await tx.pluginInstallation.create({ data: { pluginId: id, teamId: membership.teamId, installedById: userId, version: plugin.version } });
          await tx.plugin.update({ where: { id }, data: { installCount: { increment: 1 } } });
          return created;
        });
    await this.audit(userId, 'plugin.marketplace.installed', 'Plugin', id, { teamId: membership.teamId });
    return { installation, plugin: this.publicPlugin(plugin, membership.teamId) };
  }

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
    const plugins = await this.prisma.plugin.findMany({ orderBy: { createdAt: 'desc' }, include: { team: true, author: true } });
    return { plugins: plugins.map((plugin) => this.publicPlugin(plugin, plugin.teamId || undefined)) };
  }

  async adminPluginReviewPending(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const plugins = await this.prisma.plugin.findMany({
      where: { reviewStatus: 'PENDING' },
      orderBy: { updatedAt: 'asc' },
      include: { team: true, author: true },
    });
    return { plugins: plugins.map((plugin) => this.publicPlugin(plugin, plugin.teamId || undefined)) };
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
    return { plugin: this.publicPlugin(updated, updated.teamId || undefined) };
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
    return { plugin: this.publicPlugin(updated, updated.teamId || undefined) };
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
    return { plugin: this.publicPlugin(plugin, plugin.teamId || undefined) };
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

  private publicPlugin(plugin: {
    id: string;
    name: string;
    description: string;
    version: string;
    entry: string;
    runtimeType: string;
    status: string;
    visibility: string;
    teamId: string | null;
    authorUserId: string | null;
    files: unknown;
    manifest: unknown;
    capabilities: unknown;
    contentHash: string;
    reviewStatus: string;
    reviewReason: string;
    reviewedById: string | null;
    reviewedAt: Date | null;
    marketplace: boolean;
    priceCents: number;
    installCount: number;
    ratingCount: number;
    ratingSum: number;
    createdAt: Date;
    updatedAt: Date;
  }, currentTeamId?: string) {
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      entry: plugin.entry,
      runtimeType: plugin.runtimeType,
      runtime_type: String(plugin.runtimeType).toLowerCase(),
      status: plugin.status,
      visibility: plugin.visibility,
      teamId: plugin.teamId,
      authorUserId: plugin.authorUserId,
      files: plugin.files,
      manifest: plugin.manifest,
      capabilities: plugin.capabilities,
      contentHash: plugin.contentHash,
      reviewStatus: plugin.reviewStatus,
      reviewReason: plugin.reviewReason,
      reviewedById: plugin.reviewedById,
      reviewedAt: plugin.reviewedAt?.toISOString() || null,
      marketplace: plugin.marketplace,
      priceCents: plugin.priceCents,
      installCount: plugin.installCount,
      ratingCount: plugin.ratingCount,
      ratingSum: plugin.ratingSum,
      source: plugin.teamId === currentTeamId ? 'team' : plugin.marketplace ? 'marketplace' : 'platform',
      createdAt: plugin.createdAt.toISOString(),
      updatedAt: plugin.updatedAt.toISOString(),
    };
  }

  private ensurePluginManager(plugin: { teamId: string | null; authorUserId: string | null }, teamId: string, userId: string, role: string) {
    if (plugin.teamId !== teamId) throw forbidden('不能操作其他团队的插件');
    if (plugin.authorUserId !== userId && role !== 'TEAM_ADMIN') throw forbidden('仅作者或团队管理员可操作该插件');
  }

  private normalizePluginPackage(input: PluginPackageInput): NormalizedPluginPackage {
    const manifest = input.manifest;
    const rawFiles = input.files;
    if (!manifest || typeof manifest !== 'object') throw badRequest('manifest 不能为空');
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) throw badRequest('files 不能为空');
    if (rawFiles.length > MAX_PLUGIN_FILES) throw badRequest('插件文件数量超限');

    const name = this.cleanText(manifest.name, '插件名称不能为空');
    const version = this.cleanText(manifest.version || '0.1.0', '插件版本不能为空');
    const entry = this.cleanPath(manifest.entry || 'ui/index.html');
    const runtime = String(manifest.runtime_type || manifest.runtimeType || 'client').toLowerCase();
    if (runtime !== 'client' && runtime !== 'cloud') throw badRequest('runtime_type 只允许 client 或 cloud');
    const visibilityValue = String(manifest.visibility || 'tenant').toLowerCase();
    if (visibilityValue !== 'tenant' && visibilityValue !== 'private') throw badRequest('visibility 只允许 tenant 或 private');

    const seen = new Set<string>();
    let totalBytes = 0;
    const files = rawFiles.map((file) => {
      if (!file || typeof file !== 'object') throw badRequest('文件格式不正确');
      const path = this.cleanPath(file.path);
      if (seen.has(path)) throw conflict('插件文件路径重复', { path });
      seen.add(path);
      if (typeof file.content !== 'string') throw badRequest('插件文件内容必须是字符串', { path });
      const bytes = Buffer.byteLength(file.content, 'utf8');
      if (bytes > MAX_PLUGIN_FILE_BYTES) throw badRequest('单个插件文件过大', { path, limitBytes: MAX_PLUGIN_FILE_BYTES });
      totalBytes += bytes;
      if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) throw badRequest('插件包总大小超限', { limitBytes: MAX_PLUGIN_TOTAL_BYTES });
      return { path, content: file.content };
    }).sort((a, b) => a.path.localeCompare(b.path));

    if (!seen.has(entry)) throw badRequest('manifest.entry 指向的文件不存在', { entry });
    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities.map((capability) => {
      const kind = String(capability?.kind || '').trim();
      if (!ALLOWED_CAPABILITIES.has(kind)) throw badRequest('插件能力不在允许范围内', { kind });
      const risk = String(capability?.risk || 'low');
      if (!['none', 'low', 'medium', 'high'].includes(risk)) throw badRequest('插件能力 risk 不合法', { kind, risk });
      return {
        kind,
        reason: String(capability?.reason || ''),
        risk,
        requires_admin: Boolean(capability?.requires_admin),
        ...(capability?.scope === undefined ? {} : { scope: capability.scope }),
      };
    }) : [];

    const normalizedManifest = {
      id: String(manifest.id || name).trim(),
      name,
      version,
      description: String(manifest.description || ''),
      runtime_type: runtime as 'client' | 'cloud',
      entry,
      visibility: visibilityValue as 'private' | 'tenant',
      capabilities,
    };
    const contentHash = createHash('sha256').update(JSON.stringify({ manifest: normalizedManifest, files })).digest('hex');
    return {
      manifest: normalizedManifest,
      files,
      runtimeType: runtime === 'client' ? 'CLIENT' : 'CLOUD',
      visibility: visibilityValue === 'private' ? 'PRIVATE' : 'TEAM',
      contentHash,
    };
  }

  private cleanText(value: unknown, message: string) {
    const text = String(value || '').trim();
    if (!text) throw badRequest(message);
    return text;
  }

  private cleanPath(value: unknown) {
    const path = String(value || '').trim().replace(/\\/g, '/');
    if (!path) throw badRequest('插件文件路径不能为空');
    if (path.startsWith('/') || path.startsWith('~') || /^[a-zA-Z]:\//.test(path)) throw badRequest('插件文件路径不能是绝对路径', { path });
    const segments = path.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw badRequest('插件文件路径不能包含空段或 ..', { path });
    if (segments.some((segment) => segment.startsWith('.'))) throw badRequest('插件文件路径不能包含隐藏系统路径', { path });
    return path;
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}