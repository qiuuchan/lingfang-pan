import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { conflict, forbidden, notFound } from '../common';
import { AuthService } from './auth.service';
import { ensurePluginManager, normalizePluginPackage, publicPlugin, type PluginPackageInput } from './plugin-package';

@Injectable()
export class PluginService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async uploadPlugin(userId: string, input: PluginPackageInput) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    if (membership.team.status !== 'ACTIVE') throw forbidden('团队当前不可上传插件');
    const normalized = normalizePluginPackage(input);
    const existing = await this.prisma.plugin.findUnique({
      where: { teamId_contentHash: { teamId: membership.teamId, contentHash: normalized.contentHash } },
    });
    if (existing) return { plugin: publicPlugin(existing, membership.teamId), deduplicated: true };

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
    return { plugin: publicPlugin(plugin, membership.teamId), deduplicated: false };
  }

  async myPlugins(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugins = await this.prisma.plugin.findMany({
      where: { authorUserId: userId, teamId: membership.teamId },
      orderBy: { updatedAt: 'desc' },
    });
    return { plugins: plugins.map((plugin) => publicPlugin(plugin, membership.teamId)) };
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
    return { plugins: plugins.map((plugin) => publicPlugin(plugin, membership.teamId)) };
  }

  async submitPluginToMarketplace(userId: string, id: string, input: { priceCents?: number }) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    ensurePluginManager(plugin, membership.teamId, userId, membership.role);
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
    return { plugin: publicPlugin(updated, membership.teamId) };
  }

  async editPluginDraft(userId: string, id: string, input: PluginPackageInput) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    ensurePluginManager(plugin, membership.teamId, userId, membership.role);
    if (plugin.reviewStatus === 'PENDING') throw conflict('审核中的插件不能编辑，请等待审核完成或联系平台管理员');

    const normalized = normalizePluginPackage(input);
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
    return { plugin: publicPlugin(updated, membership.teamId) };
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
    return { installation, plugin: publicPlugin(plugin, membership.teamId) };
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}