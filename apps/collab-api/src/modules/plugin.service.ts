import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { badRequest, conflict, forbidden, notFound, AppError } from '../common';
import { AuthService } from './auth.service';
import { PluginGrantService } from './plugin-grant.service';
import { NotificationService } from './notification.service';
import { ensurePluginManager, normalizePluginPackage, publicAvailablePlugin, publicPlugin, type PluginPackageInput } from './plugin-package';

/** 语义版本比较：newVer 是否严格大于 oldVer（x.y.z）。非法格式按 0.0.0 处理。 */
function isVersionNewer(newVer: string, oldVer: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const [a1, a2, a3] = parse(newVer);
  const [b1, b2, b3] = parse(oldVer);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}

@Injectable()
export class PluginService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PluginGrantService) private readonly grants: PluginGrantService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  async uploadPlugin(userId: string, input: PluginPackageInput) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    if (membership.team.status !== 'ACTIVE') throw forbidden('团队当前不可上传插件');
    const normalized = normalizePluginPackage(input);
    const existing = await this.prisma.plugin.findUnique({
      where: { teamId_contentHash: { teamId: membership.teamId, contentHash: normalized.contentHash } },
    });
    if (existing) return { plugin: publicPlugin(existing, membership.teamId), deduplicated: true };

    // 同 manifest.id + 同团队 已存在 → 视为同插件的版本升级，委托 editPluginDraft 做 in-place 更新
    // （含权限校验 + 版本校验 + 通知已安装用户）。manifest.id 由 normalizePluginPackage 规范化（trim）。
    // 这让「上传 0.0.1 后再上传 0.0.2」覆盖同一插件行，而非创建无关联的新 UUID 行。
    const manifestId = normalized.manifest.id;
    if (manifestId) {
      const sameLogical = await this.prisma.plugin.findFirst({
        where: { teamId: membership.teamId, manifest: { path: ['id'], equals: manifestId } },
        orderBy: { updatedAt: 'desc' },
      });
      if (sameLogical) {
        const { plugin } = await this.editPluginDraft(userId, sameLogical.id, input);
        return { plugin, upgraded: true };
      }
    }

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
      include: {
        installations: {
          where: { teamId: membership.teamId, status: 'ENABLED' },
          select: { id: true, version: true },
        },
      },
      orderBy: [{ marketplace: 'asc' }, { updatedAt: 'desc' }],
    });
    // RBAC 插件授权过滤：被 deny 的插件不出现在可用列表。
    // resolvePluginAccess（deny 优先、user 级优先于 role 级、团队管理员默认放行、无 grant 默认放行）。
    const accessible: typeof plugins = [];
    for (const plugin of plugins) {
      const ok = await this.grants.resolvePluginAccess(membership.teamId, plugin.id, userId, membership.teamRoleId);
      if (ok) accessible.push(plugin);
    }
    return { plugins: accessible.map((plugin) => publicAvailablePlugin(plugin, membership.teamId)) };
  }

  async submitPluginToMarketplace(userId: string, id: string, input: { priceCents?: number }) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    ensurePluginManager(plugin, membership.teamId, userId, membership.role);
    if (plugin.status !== 'ENABLED') throw forbidden('已禁用插件不能提交市场');
    if (plugin.reviewStatus === 'PENDING') throw conflict('插件已在审核中');

    // 修复 PPK-03：显式区分 undefined（保持原价）与 0（免费化），此前 0 被 || 吞掉无法改免费。
    const priceCents = input.priceCents === undefined
      ? Math.max(0, plugin.priceCents)
      : Math.max(0, Math.floor(Number(input.priceCents) || 0));
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

  /** 作者/团队管理员设置插件定价（不改源码、不触发审核流程）。
   *  与 editPluginDraft 区别：editPluginDraft 需要完整 manifest+files 且会重置 reviewStatus=DRAFT，
   *  本方法仅更新 priceCents，保留现有 reviewStatus/marketplace 不变（适合作者在审核前/未上架时调价）。
   *  约束：审核中(PENDING)的插件不可改价（避免审核与定价并发），已上架(APPROVED+marketplace)需走管理员下架后重审。 */
  async setPluginPrice(userId: string, id: string, input: { priceCents?: number }) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    ensurePluginManager(plugin, membership.teamId, userId, membership.role);
    if (plugin.reviewStatus === 'PENDING') throw conflict('审核中的插件不能改价，请等待审核完成');
    if (plugin.reviewStatus === 'APPROVED' && plugin.marketplace) {
      throw conflict('已上架市场的插件需联系平台管理员下架后再改价');
    }
    // priceCents 语义与 submitPluginToMarketplace 对齐：undefined 保持原价，0=免费，负数归 0。
    const priceCents = input.priceCents === undefined
      ? Math.max(0, plugin.priceCents)
      : Math.max(0, Math.floor(Number(input.priceCents) || 0));
    const updated = await this.prisma.plugin.update({
      where: { id },
      data: { priceCents },
    });
    await this.audit(userId, 'plugin.price.set', 'Plugin', id, { teamId: membership.teamId, priceCents });
    return { plugin: publicPlugin(updated, membership.teamId) };
  }

  /** 作者/团队管理员删除插件（物理删，级联清 Installation/Review）。
   *  约束：已上架市场(marketplace=true)的插件不可由作者删（影响已购买/安装用户，需 admin 下架后再删）。
   *  未上架（草稿/驳回/团队内）可删。级联删 PluginInstallation（onDelete: Cascade 自动）。 */
  async deleteByAuthor(userId: string, id: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id }, select: { id: true, name: true, marketplace: true, teamId: true, authorUserId: true } });
    if (!plugin) throw notFound('插件不存在');
    ensurePluginManager(plugin, membership.teamId, userId, membership.role);
    if (plugin.marketplace) {
      throw conflict('已上架市场的插件需联系平台管理员下架后再删除');
    }
    // 级联删 PluginInstallation + PluginReview（schema onDelete: Cascade 自动）+ 物理删 Plugin。
    await this.prisma.plugin.delete({ where: { id } });
    await this.audit(userId, 'plugin.deleted', 'Plugin', id, { teamId: membership.teamId, name: plugin.name });
  }

  /** 作者/团队管理员切换插件启用/禁用（status: ENABLED/DISABLED）。
   *  与 admin.adminUpdatePlugin 区别：admin 可改任意插件，本方法仅限作者/团队管理员改自己的插件，
   *  且不改其他治理字段（价格/可见性等）。约束：审核中(PENDING)的插件不可切换（避免审核与下架并发），
   *  已上架(APPROVED+marketplace)的市场插件不可由作者禁用（影响已购买/安装用户，需走管理员下架）。 */
  async setPluginStatus(userId: string, id: string, input: { status: 'ENABLED' | 'DISABLED' }) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    ensurePluginManager(plugin, membership.teamId, userId, membership.role);
    if (plugin.reviewStatus === 'PENDING') throw conflict('审核中的插件不能切换状态，请等待审核完成');
    if (plugin.reviewStatus === 'APPROVED' && plugin.marketplace) {
      throw conflict('已上架市场的插件需联系平台管理员下架后再禁用');
    }
    if (input.status !== 'ENABLED' && input.status !== 'DISABLED') {
      throw badRequest('status 仅支持 ENABLED 或 DISABLED');
    }
    if (plugin.status === input.status) return { plugin: publicPlugin(plugin, membership.teamId) };
    const updated = await this.prisma.plugin.update({
      where: { id },
      data: { status: input.status },
    });
    await this.audit(userId, input.status === 'ENABLED' ? 'plugin.enabled' : 'plugin.disabled', 'Plugin', id, { teamId: membership.teamId });
    return { plugin: publicPlugin(updated, membership.teamId) };
  }

  async editPluginDraft(userId: string, id: string, input: PluginPackageInput) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    ensurePluginManager(plugin, membership.teamId, userId, membership.role);
    if (plugin.reviewStatus === 'PENDING') throw conflict('审核中的插件不能编辑，请等待审核完成或联系平台管理员');

    // 版本号校验：已上架插件更新时，新版本必须严格大于当前版本（防降级/同版本覆盖）。
    // 首次草稿（无版本或 0.0.0）不校验。
    const isLiveUpdate = plugin.reviewStatus === 'APPROVED' && plugin.marketplace;

    const normalized = normalizePluginPackage(input);
    const duplicated = await this.prisma.plugin.findUnique({
      where: { teamId_contentHash: { teamId: membership.teamId, contentHash: normalized.contentHash } },
    });
    if (duplicated && duplicated.id !== id) throw conflict('团队内已存在相同内容的插件', { pluginId: duplicated.id });

    // 已上架插件更新源码：保留 APPROVED + marketplace（不重审、不下架），直接生效。
    // 产品决策：作者更新插件（改源码/升版本）无需管理员重新审核，新版直接推送给已安装用户。
    // 安全权衡：接受作者替换已审核代码的风险（换取发布效率）；管理员仍可随时下架（adminRejectPlugin）。
    if (isLiveUpdate) {
      const oldVersion = plugin.version ?? '0.0.0';
      if (!isVersionNewer(normalized.manifest.version, oldVersion)) {
        throw badRequest(`已上架插件更新版本号必须大于当前版本 ${oldVersion}（不能降级或相同），请升版本号后重试。`);
      }
      const updated = await this.prisma.plugin.update({
        where: { id },
        data: {
          name: normalized.manifest.name,
          description: normalized.manifest.description,
          version: normalized.manifest.version,
          entry: normalized.manifest.entry,
          runtimeType: normalized.runtimeType,
          // 保留原 visibility（不覆盖）：已上架插件是 PUBLIC，normalizePluginPackage 只产出
          // TEAM/PRIVATE，覆盖会导致插件对新用户从市场消失（availablePlugins 靠 visibility=PUBLIC 匹配）。
          files: normalized.files as unknown as Prisma.InputJsonValue,
          manifest: normalized.manifest as unknown as Prisma.InputJsonValue,
          capabilities: normalized.manifest.capabilities as unknown as Prisma.InputJsonValue,
          contentHash: normalized.contentHash,
          // 保留审核态：不重置 reviewStatus/marketplace/visibility，已购用户不受影响，新版直接生效。
        },
      });
      await this.audit(userId, 'plugin.live.updated', 'Plugin', id, { teamId: membership.teamId, oldVersion, newVersion: normalized.manifest.version, contentHash: normalized.contentHash });
      // 推送新版本通知给已安装旧版本的用户（复用 adminApprovePlugin 的推送逻辑）。
      await this.notifyNewVersion(id, updated.name, normalized.manifest.version, oldVersion);
      return { plugin: publicPlugin(updated, membership.teamId) };
    }

    // 未上架（DRAFT/REJECTED/已下架）：改源码打回 DRAFT 重审（原逻辑）。
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

  /**
   * 推送「新版本」通知给已安装旧版本的用户。
   * 复用 adminApprovePlugin 的推送语义：向每位安装了旧版本（≠ newVersion）的用户发 new_version 通知。
   * 触发失败不阻塞主流程（与审核通知同语义）。
   */
  private async notifyNewVersion(pluginId: string, pluginName: string, newVersion: string, oldVersion: string) {
    try {
      const installations = await this.prisma.pluginInstallation.findMany({
        where: { pluginId, status: 'ENABLED' },
        select: { installedById: true, version: true },
      });
      for (const inst of installations) {
        if (!inst.installedById || inst.version === newVersion) continue;
        try {
          await this.notifications.create(
            inst.installedById,
            'new_version',
            '插件有新版本',
            `你安装的「${pluginName}」发布了新版本 v${newVersion}（当前 v${inst.version}），可在插件页更新。`,
            { relatedType: 'Plugin', relatedId: pluginId },
          );
        } catch {
          /* 单条通知失败不影响其它用户 */
        }
      }
    } catch {
      /* 查询安装记录失败不阻塞更新 */
    }
  }

  /** 作者/团队管理员编辑插件元数据（名称/描述/图标），不改源码、不重算 contentHash、不重置审核态。
   *  与 editPluginDraft 区别：editPluginDraft 改源码必须重传整包并打回 DRAFT 重审；
   *  本方法只动展示信息（manifest 浅合并 + 顶层 name/description），其余字段透传。
   *  约束：审核中(PENDING)不能编辑（与 editPluginDraft 一致，避免与审核并发）；
   *  已上架(APPROVED+marketplace)允许仅改元数据 —— 名称/描述/图标不影响已购用户的功能与计费，
   *  不触发源码变更，无需走「下架→改名→重审」的重流程（这是与 editPluginDraft 的关键差异）。
   *  图标存入 manifest.icon（不加 schema 列）；不接受 image/svg+xml（规避内联脚本 XSS）。 */
  async editPluginMeta(userId: string, id: string, input: { name?: string; description?: string; icon?: string }) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    ensurePluginManager(plugin, membership.teamId, userId, membership.role);
    if (plugin.reviewStatus === 'PENDING') throw conflict('审核中的插件不能编辑，请等待审核完成');

    // 入参归一：name 提供时 trim 后必须非空；description 允许空串；icon 拒绝 svg（含内联脚本风险）。
    const name = input.name === undefined ? undefined : String(input.name).trim();
    if (name !== undefined && !name) throw badRequest('插件名称不能为空');
    const description = input.description === undefined ? undefined : String(input.description);
    const icon = input.icon === undefined ? undefined : String(input.icon).trim();
    if (icon && /^data:image\/svg\+xml/i.test(icon)) throw badRequest('图标不支持 SVG 格式，请使用 PNG/JPG/WebP 或 emoji');
    if (name === undefined && description === undefined && icon === undefined) {
      throw badRequest('至少需要提供一项要修改的字段（名称/描述/图标）');
    }

    // manifest 浅合并：保留 entry/runtime_type/capabilities 等所有未知键，仅覆盖被显式提供的展示字段。
    const baseManifest = (plugin.manifest && typeof plugin.manifest === 'object' && !Array.isArray(plugin.manifest))
      ? plugin.manifest as Record<string, unknown>
      : {};
    const nextManifest: Record<string, unknown> = { ...baseManifest };
    if (name !== undefined) nextManifest.name = name;
    if (description !== undefined) nextManifest.description = description;
    if (icon !== undefined) {
      // 空串视为清除图标（删除 manifest.icon 键），非空写入。
      if (icon) nextManifest.icon = icon;
      else delete nextManifest.icon;
    }

    const updated = await this.prisma.plugin.update({
      where: { id },
      data: {
        // 顶层 name/description 仅当对应入参提供时更新（与 manifest 同步），其余治理字段一律不动。
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        manifest: nextManifest as unknown as Prisma.InputJsonValue,
      },
    });
    // 审计只记改了哪些字段名，不记图标 base64 内容（避免日志膨胀与冗余）。
    const fields = [name !== undefined && 'name', description !== undefined && 'description', icon !== undefined && 'icon'].filter(Boolean);
    await this.audit(userId, 'plugin.meta.edited', 'Plugin', id, { teamId: membership.teamId, fields });
    return { plugin: publicPlugin(updated, membership.teamId) };
  }

  async installMarketplacePlugin(userId: string, id: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin || plugin.status !== 'ENABLED' || plugin.reviewStatus !== 'APPROVED' || !plugin.marketplace || plugin.visibility !== 'PUBLIC') {
      throw notFound('市场插件不存在或不可安装');
    }
    // 修复 PPK-01（critical 付费墙绕过）：此前此路径完全缺失付费校验，
    // 付费插件可被任意已登录用户免费安装、installCount 虚增、作者分成流失。
    // 与 marketplace.service.ts:94-97 的 install 保持契约一致 —— 付费插件必须先有 Purchase。
    if (plugin.priceCents > 0) {
      const bought = await this.prisma.purchase.count({ where: { pluginId: id, buyerUserId: userId } });
      if (bought === 0) {
        throw new AppError(402, 'payment_required', '该插件为付费插件，请先购买');
      }
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
