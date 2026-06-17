import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { badRequest, conflict, forbidden, insufficientBalance, notFound, publicUser, slugify } from '../common';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { NotificationService } from './notification.service';
import { publicPlugin } from './plugin-package';
import { auditActionCategory, AUDIT_ACTION_LABEL, AUDIT_CATEGORIES, type AuditCategoryKey } from './audit-actions';

@Injectable()
export class AdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    // MailService 用于 adminResetUserPassword 发送「临时密码 / 重置链接」邮件（与 auth.forgotPassword 同款通道）。
    @Inject(MailService) private readonly mail: MailService,
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

  async adminUpdateUser(actorId: string, id: string, input: { displayName?: string; status?: 'ACTIVE' | 'DISABLED'; platformRole?: 'NONE' | 'PLATFORM_ADMIN'; email?: string; password?: string }) {
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
    // email 改动：归一化（trim+lower）+ 唯一性校验（排除自身）。
    let normalizedEmail: string | undefined;
    if (input.email !== undefined) {
      normalizedEmail = input.email.trim().toLowerCase();
      if (normalizedEmail) {
        const dup = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
        if (dup && dup.id !== id) throw conflict('该邮箱已被其他用户占用');
      }
    }
    // 显式仅取声明字段，避免客户端误传非法键透传进 prisma.user.update。
    const data: { displayName?: string; status?: 'ACTIVE' | 'DISABLED'; platformRole?: 'NONE' | 'PLATFORM_ADMIN'; email?: string; passwordHash?: string; tokenVersion?: { increment: number } } = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.status !== undefined) data.status = input.status;
    if (input.platformRole !== undefined) data.platformRole = input.platformRole;
    if (normalizedEmail !== undefined) data.email = normalizedEmail;
    // password 明文 → bcrypt hash（与 register/login 一致 cost=12）。
    if (input.password !== undefined) {
      if (input.password.length < 8) throw badRequest('密码至少 8 位');
      data.passwordHash = await bcrypt.hash(input.password, 12);
    }
    // 修复 ADMIN-02 / AUTH-01：禁用或降级时自增 tokenVersion，使已签发的旧 token 立即失效。
    // 改 email 或 password 也自增 tokenVersion（强制重新登录，旧 token 作废）。
    if (input.status === 'DISABLED' || input.platformRole === 'NONE' || normalizedEmail !== undefined || input.password !== undefined) {
      data.tokenVersion = { increment: 1 };
    }
    const user = await this.prisma.user.update({ where: { id }, data });
    // 审计：email/password 改动不记明文（脱敏），仅记字段变更标记。
    const auditData: Record<string, unknown> = { ...data };
    if (data.passwordHash) auditData.password = '[changed]';
    delete auditData.passwordHash;
    await this.audit(actorId, 'admin.user.updated', 'User', id, auditData);
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

  // 用户详情聚合视图：登录历史（from AuditLog，含 success/failed/refresh/logout）+ 钱包 + 团队 memberships。
  // 供管理端用户详情抽屉渲染完整画像。全部基于现有表聚合，零新表、零破坏式 DDL。
  //   - 登录历史：actorUserId = userId 的审计记录按时间倒序（含 auth.login.success/failed/token.refreshed/logout）。
  //   - 钱包：一对一关联 Wallet，不存在则 balanceCents: 0。
  //   - 团队 memberships：含 team 字段，按 joinedAt 倒序（最近加入在前）。
  async adminUserDetail(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw notFound('用户不存在');
    // 并发聚合：登录历史（auth.* 审计）+ 钱包 + 团队 memberships + 钱包流水。
    const [loginHistory, wallet, memberships, walletTxs] = await Promise.all([
      // 登录历史：actor=该用户 + action 以 auth. 开头（login.success/failed/token.refreshed/logout/email.verified/password.reset）。
      this.prisma.auditLog.findMany({
        where: { actorUserId: id, action: { startsWith: 'auth.' } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, action: true, metadata: true, createdAt: true },
      }),
      this.prisma.wallet.findUnique({ where: { userId: id } }),
      this.prisma.teamMembership.findMany({
        where: { userId: id },
        include: { team: true },
        orderBy: { joinedAt: 'desc' },
      }),
      // 钱包流水：最近 10 条，便于在用户详情看消费轨迹。
      this.prisma.walletTransaction.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    return {
      user: { ...publicUser(user), createdAt: user.createdAt, emailVerified: user.emailVerified },
      loginHistory: loginHistory.map((l) => ({
        id: l.id,
        action: l.action,
        metadata: l.metadata,
        // createdAt 转 ISO 字符串（与 notification.publicNotification 风格一致）。
        createdAt: l.createdAt.toISOString(),
      })),
      wallet: { balanceCents: wallet?.balanceCents ?? 0 },
      teams: memberships.map((m) => ({
        teamId: m.teamId,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt.toISOString(),
        team: { id: m.team.id, name: m.team.name, slug: m.team.slug, status: m.team.status, balanceCents: m.team.balanceCents },
      })),
      walletTransactions: walletTxs.map((t) => ({
        id: t.id,
        amountCents: t.amountCents,
        direction: t.direction,
        reason: t.reason,
        pluginId: t.pluginId,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  }

  // 管理员强制重置用户密码：生成临时密码（12 位 base64url 随机串），写库 + 通知用户（站内信 + 邮件），
  // tokenVersion++ 作废所有旧登录 token（强制重新登录）。返回临时密码给 admin 一次性转交（不在审计/邮件外泄）。
  //
  // 安全设计：
  //  - 临时密码用 randomBytes(9) 生成（密码学安全随机源），base64url 字母表无歧义字符，便于人工转抄。
  //  - 临时密码仅在响应里返回一次给操作 admin，审计 metadata 不记录密码值（仅记 {reset: true}）。
  //  - 触发站内通知 + 邮件（邮件失败不阻塞主操作，与审核通知同款吞错降级）。
  //  - tokenVersion++ 作废旧 token，避免攻击者继续使用旧会话（与 auth.resetPassword 同款语义）。
  async adminResetUserPassword(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, email: true, displayName: true, status: true } });
    if (!user) throw notFound('用户不存在');
    // 生成临时密码：randomBytes(9) → base64url 恰好 12 字符（72 bits，ceil(72/6)=12，无 padding 截断）。
    // base64url 字母表（A-Z a-z 0-9 - _）无歧义字符，便于人工转抄。
    const tempPassword = randomBytes(9).toString('base64url');
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    // 事务：改密 + tokenVersion++（原子，作废旧 token）+ 审计（审计不记密码值）。
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash, tokenVersion: { increment: 1 } } });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'admin.user.password_reset',
          targetType: 'User',
          targetId: id,
          // 不记录临时密码值（防审计日志泄漏），仅记「已重置」标记 + 邮箱便于追溯。
          metadata: { reset: true, email: user.email },
        },
      });
    });
    // 通知用户：密码已被管理员重置（站内信，触发失败不阻塞主操作）。
    try {
      await this.notifications.create(
        id,
        'password_reset_by_admin',
        '密码已被管理员重置',
        `你的账号密码已被平台管理员重置，请联系管理员获取临时密码并尽快登录后修改。`,
        { relatedType: 'User', relatedId: id },
      );
    } catch {
      // 通知触发失败不阻塞重置主流程。
    }
    // 邮件通知：临时密码不直接发邮件（防邮件泄漏），仅告知「请联系管理员获取临时密码」。
    // 与 auth.forgotPassword 的重置链接模式不同（admin 强制重置不需要邮件链路传递密码）。
    const resetNoticeHtml = `<p>你的账号密码已被平台管理员重置。请使用管理员提供的临时密码登录，并尽快在「账号设置」中修改为你的新密码。</p>`;
    this.mail.sendMail(user.email, '你的密码已被管理员重置', resetNoticeHtml).catch(() => {
      // 邮件发送失败不阻塞主流程（降级吞错，与 mail.sendMail 内部一致）。
    });
    return { tempPassword, user: publicUser(user) };
  }

  // 调整用户平台角色（NONE↔PLATFORM_ADMIN，专用端点）。
  // 与 adminUpdateUser 的 platformRole 字段区别：此端点仅改角色，语义明确；且独立审计 action（admin.user.role_changed）。
  //
  // 安全约束（与 adminUpdateUser 一致）：
  //  - 禁止自改自身（防自降级锁死末位管理员、防自提权绕过审批）。
  //  - 禁止降级最后一个 PLATFORM_ADMIN（保持平台治理可用性）。
  //  - 升级为 PLATFORM_ADMIN：写审计 admin.user.role_changed，metadata 记 from/to。
  //  - 降级为 NONE：tokenVersion++（作废旧 token，防被降级管理员继续用旧 token 操作）。
  async adminUpdateUserPlatformRole(actorId: string, id: string, input: { platformRole: 'NONE' | 'PLATFORM_ADMIN' }) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 禁止自改自身：防自降级（锁死末位管理员）+ 防自提权（绕过审批链）。
    if (id === actorId) throw forbidden('不能调整自己的平台管理员角色');
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true, email: true, displayName: true, platformRole: true, status: true } });
    if (!target) throw notFound('用户不存在');
    // 幂等优化：已是目标角色则不重复写审计，避免无变更操作污染审计日志。
    if (target.platformRole === input.platformRole) {
      return { user: publicUser(target) };
    }
    // 降级（PLATFORM_ADMIN → NONE）时禁止降级最后一个管理员。
    if (input.platformRole === 'NONE' && target.platformRole === 'PLATFORM_ADMIN' && target.status === 'ACTIVE') {
      const remainingAdmins = await this.prisma.user.count({ where: { platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' } });
      if (remainingAdmins <= 1) throw forbidden('不能降级最后一个平台管理员');
    }
    // 降级时 tokenVersion++ 作废旧 token（与 adminUpdateUser 同款语义），升级则不需要（提权不涉及吊销）。
    const data: { platformRole: 'NONE' | 'PLATFORM_ADMIN'; tokenVersion?: { increment: number } } = { platformRole: input.platformRole };
    if (input.platformRole === 'NONE') data.tokenVersion = { increment: 1 };
    const user = await this.prisma.user.update({ where: { id }, data });
    await this.audit(actorId, 'admin.user.role_changed', 'User', id, { from: target.platformRole, to: input.platformRole });
    return { user: publicUser(user) };
  }

  // 管理员操作记录：该管理员作为 actor 的所有审计日志（按时间倒序），供管理员详情页展示操作历史。
  // 复用 auditLogs 的脱敏策略（select 白名单字段，不返 passwordHash/tokenVersion）。
  async adminActivity(actorId: string, targetUserId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const logs = await this.prisma.auditLog.findMany({
      where: { actorUserId: targetUserId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { actor: { select: { id: true, email: true, displayName: true, platformRole: true, status: true } } },
    });
    return { logs };
  }

  async adminTeams(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const teams = await this.prisma.team.findMany({
      orderBy: { createdAt: 'desc' },
      // 组E 性能：无上限的全表扫描在团队数膨胀时拖慢响应并放大内存。take:200 与 adminUsers 一致，
      // 配合前端分页（前端已用 usePagination），足以覆盖管理端首屏。后续如需翻页可加分页 query 参数。
      take: 200,
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

  // 管理端团队成员列表：返回该团队全部成员（含 role/status/joinedAt + 脱敏 user）。
  // 与 adminTeams 一致按 joinedAt asc 排序（先加入在前，便于查看团队组建时间线）。
  // 不做状态过滤：管理端需查看 REMOVED 成员以审计「移除历史」，不同于 currentMembers 仅返回 ACTIVE。
  async adminTeamMembers(userId: string, teamId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const exists = await this.prisma.team.findUnique({ where: { id: teamId }, select: { id: true } });
    if (!exists) throw notFound('团队不存在');
    const memberships = await this.prisma.teamMembership.findMany({
      where: { teamId },
      include: { user: true },
      orderBy: { joinedAt: 'asc' },
    });
    return {
      members: memberships.map((m) => ({ teamId: m.teamId, userId: m.userId, role: m.role, status: m.status, joinedAt: m.joinedAt, user: publicUser(m.user) })),
    };
  }

  // 调整团队成员角色（TEAM_ADMIN↔MEMBER）。平台 Admin 可在任意团队内升降级成员。
  // 与 adminSetTeamAdmin/adminRevokeTeamAdmin 区别：这两个是「指定/撤销」单向操作，
  // 此方法是「双向切换」单一端点，前端成员 tab 直接用 role 下拉切换，无需判断升/降分支。
  async adminUpdateMemberRole(actorId: string, teamId: string, targetUserId: string, input: { role: 'TEAM_ADMIN' | 'MEMBER' }) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 前置存在性校验：update 在记录不存在时抛 P2025，此前被吞成 500（与 adminRevokeTeamAdmin 的 ADMIN-08 修复同源）。
    const existing = await this.prisma.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId: targetUserId } } });
    if (!existing) throw notFound('团队成员关系不存在');
    // 幂等优化：已是目标角色则不重复写审计，避免无变更操作污染审计日志。
    if (existing.role === input.role) return { membership: existing };
    const membership = await this.prisma.teamMembership.update({ where: { teamId_userId: { teamId, userId: targetUserId } }, data: { role: input.role } });
    // action 统一前缀分类（team.member.role_changed）：审计 action 按模块分类，便于 audit-view 筛选。
    await this.audit(actorId, 'team.member.role_changed', 'User', targetUserId, { teamId, from: existing.role, to: input.role });
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

  // 团队详情聚合视图：成员数 + 插件数 + 最近购买记录 + 余额流水摘要。
  // 供管理端详情抽屉展示团队活跃度画像。全部基于现有表聚合，零新表、零破坏式 DDL。
  //   - 成员数：ACTIVE 成员计数（不含 REMOVED）。
  //   - 插件数：该团队拥有的 plugin 总数（teamId 关联）。
  //   - 购买记录：该团队作为买方（buyerTeamId）的最近 10 笔购买。
  //   - 余额流水摘要：CREDIT/DEBIT 合计金额 + 最近 10 条流水。
  async adminTeamDetail(userId: string, teamId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw notFound('团队不存在');
    // 并发聚合：成员计数 + 插件列表 + 购买记录 + 流水聚合 + 最近流水。
    const [memberCount, plugins, purchases, ledgerAgg, recentLedger] = await Promise.all([
      this.prisma.teamMembership.count({ where: { teamId, status: 'ACTIVE' } }),
      // 插件列表仅取治理所需字段，不返 files/manifest（大 Json，列表不需要）。
      this.prisma.plugin.findMany({
        where: { teamId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, name: true, status: true, visibility: true, reviewStatus: true, marketplace: true, priceCents: true, installCount: true, createdAt: true, updatedAt: true },
      }),
      // 购买记录：该团队作为买方的最近交易（含插件名，便于审计展示）。
      this.prisma.purchase.findMany({
        where: { buyerTeamId: teamId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { plugin: { select: { id: true, name: true } } },
      }),
      // 流水聚合：CREDIT 合计 - DEBIT 合计 = 累计净流入（与 balanceCents 互校，发现账实不一致）。
      this.prisma.balanceLedger.groupBy({
        by: ['direction'],
        where: { teamId },
        _sum: { amountCents: true },
      }),
      this.prisma.balanceLedger.findMany({ where: { teamId }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    const creditSum = ledgerAgg.find((g) => g.direction === 'CREDIT')?._sum.amountCents ?? 0;
    const debitSum = ledgerAgg.find((g) => g.direction === 'DEBIT')?._sum.amountCents ?? 0;
    return {
      team,
      memberCount,
      pluginCount: plugins.length,
      plugins,
      purchases: purchases.map((p) => ({ id: p.id, pluginId: p.pluginId, pluginName: p.plugin.name, priceCents: p.priceCents, createdAt: p.createdAt })),
      ledgerSummary: { totalCreditCents: creditSum, totalDebitCents: debitSum, netCents: creditSum - debitSum },
      recentLedger,
    };
  }

  async adminPlugins(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    // 组E 性能：take:200 上限防全表扫描（与 adminUsers/adminTeams 一致，前端已分页）。
    // 不再 include team/author：publicPlugin 仅读 Plugin 标量字段（authorUserId/teamId 已是 Plugin 列），
    // 此前 include author 会过度拉取整行 User（含 passwordHash/tokenVersion），既浪费 IO 又扩大凭据哈希暴露面。
    const plugins = await this.prisma.plugin.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    return { plugins: plugins.map((plugin) => publicPlugin(plugin, plugin.teamId || undefined)) };
  }

  async adminPluginReviewPending(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    // 组E 性能：take:200 上限；移除无用的 team/author include（同 adminPlugins 理由）。
    // reviewStatus PENDING 已有 @@index([reviewStatus, createdAt]) 支撑高效过滤。
    const plugins = await this.prisma.plugin.findMany({
      where: { reviewStatus: 'PENDING' },
      orderBy: { updatedAt: 'asc' },
      take: 200,
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
    // 通知作者：插件审核通过（触发失败不阻塞主操作，仅吞错记日志）。
    if (plugin.authorUserId) {
      try {
        await this.notifications.create(
          plugin.authorUserId,
          'plugin_approved',
          '插件审核通过',
          `你的插件「${plugin.name}」已通过平台审核并上架市场。`,
          { relatedType: 'Plugin', relatedId: id },
        );
      } catch {
        // 通知触发失败不阻塞审核主流程。
      }
    }
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
    // 通知作者：插件审核未通过，附驳回原因（触发失败不阻塞主操作）。
    if (plugin.authorUserId) {
      try {
        await this.notifications.create(
          plugin.authorUserId,
          'plugin_rejected',
          '插件审核未通过',
          `你的插件「${plugin.name}」未通过平台审核：${reviewReason}`,
          { relatedType: 'Plugin', relatedId: id },
        );
      } catch {
        // 通知触发失败不阻塞审核主流程。
      }
    }
    return { plugin: publicPlugin(updated, updated.teamId || undefined) };
  }

  async adminCreatePlugin(actorId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    throw forbidden('插件创建只允许通过本地客户端 Agent 发布流程，不支持管理端新增插件');
  }

  // 扩展插件治理：支持改 name/description/version/priceCents/visibility（现仅 status/marketplace）。
  // 与 adminUpdateTeam 同模式：显式字段白名单 + 仅记录被实际修改的字段到审计 metadata，
  // 杜绝透传 input DTO 引用导致审计 shape 漂移（H5 同类修复）。
  async adminUpdatePlugin(
    actorId: string,
    id: string,
    input: { name?: string; description?: string; version?: string; status?: 'ENABLED' | 'DISABLED'; priceCents?: number; visibility?: 'PRIVATE' | 'TEAM' | 'PUBLIC' },
  ) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 修复 PLUGIN-09：前置存在性校验，此前 plugin.update 在 id 不存在时抛 P2025 被吞成 500。
    const existing = await this.prisma.plugin.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw notFound('插件不存在');
    // 显式字段白名单：仅取声明字段，丢弃客户端误传的非法键（marketplace/reviewStatus 等只能走专用端点）。
    const data: {
      name?: string;
      description?: string;
      version?: string;
      status?: 'ENABLED' | 'DISABLED';
      priceCents?: number;
      visibility?: 'PRIVATE' | 'TEAM' | 'PUBLIC';
    } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.version !== undefined) data.version = input.version;
    if (input.status !== undefined) data.status = input.status;
    if (input.priceCents !== undefined) data.priceCents = Math.max(0, Math.floor(Number(input.priceCents)));
    if (input.visibility !== undefined) data.visibility = input.visibility;
    const plugin = await this.prisma.plugin.update({ where: { id }, data });
    // 审计 metadata 仅记录实际变更字段，便于审计日志回溯精确 diff（避免裸透传 input）。
    await this.audit(actorId, 'admin.plugin.updated', 'Plugin', id, data);
    return { plugin: publicPlugin(plugin, plugin.teamId || undefined) };
  }

  // 下架市场插件：marketplace=false + reviewStatus=DRAFT，与作者编辑草稿（plugin.service.editPluginDraft）
  // 下架后的状态保持一致——下架后回到草稿态，作者可重新编辑并再次提交审核。事务内写审计。
  // 通知作者：插件已被平台下架（触发失败不阻塞主操作）。
  async adminDelistPlugin(actorId: string, id: string, reason?: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id }, select: { id: true, name: true, teamId: true, authorUserId: true, marketplace: true } });
    if (!plugin) throw notFound('插件不存在');
    // 仅对上架市场的插件有下架语义；未上架直接幂等成功返回（避免重复下架产生歧义审计）。
    if (!plugin.marketplace) throw conflict('插件未上架市场，无需下架');
    const reviewReason = reason?.trim() || '平台下架';
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.plugin.update({
        where: { id },
        data: { marketplace: false, reviewStatus: 'DRAFT', reviewReason: '', reviewedById: null, reviewedAt: null },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'admin.plugin.delisted',
          targetType: 'Plugin',
          targetId: id,
          metadata: { teamId: plugin.teamId, reason: reviewReason },
        },
      });
      return next;
    });
    // 通知作者：插件已被平台下架（触发失败不阻塞主操作，仅吞错记日志）。
    if (plugin.authorUserId) {
      try {
        await this.notifications.create(
          plugin.authorUserId,
          'plugin_delisted',
          '插件已被平台下架',
          `你的插件「${plugin.name}」已被平台下架${reviewReason ? `：${reviewReason}` : ''}。`,
          { relatedType: 'Plugin', relatedId: id },
        );
      } catch {
        // 通知触发失败不阻塞下架主流程。
      }
    }
    return { plugin: publicPlugin(updated, updated.teamId || undefined) };
  }

  /** 平台管理员物理删除插件（任意，含已上架）。
   *  级联删 PluginInstallation + Purchase + PluginReview（schema onDelete: Cascade 自动）。
   *  兜底能力：作者不能删的已上架/有购买插件，admin 可删（二次确认 + 审计）。 */
  async adminDeletePlugin(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id }, select: { id: true, name: true, marketplace: true, teamId: true } });
    if (!plugin) throw notFound('插件不存在');
    // 级联删 Installation + Purchase + Review（onDelete: Cascade）+ 物理删 Plugin。
    await this.prisma.plugin.delete({ where: { id } });
    await this.audit(actorId, 'admin.plugin.deleted', 'Plugin', id, { name: plugin.name, wasMarketplace: plugin.marketplace, teamId: plugin.teamId });
    return { id };
  }

  // 插件审核历史：PluginReview 列表（按时间倒序），供详情抽屉渲染审核时间线。
  // include reviewer 用 publicUser 白名单脱敏（与 adminApplications 同类凭据泄漏防护）。
  async adminPluginAuditHistory(userId: string, id: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const existing = await this.prisma.plugin.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw notFound('插件不存在');
    const reviews = await this.prisma.pluginReview.findMany({
      where: { pluginId: id },
      orderBy: { createdAt: 'desc' },
      include: { reviewer: { select: { id: true, email: true, displayName: true, platformRole: true, status: true } } },
    });
    return {
      reviews: reviews.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        reviewer: r.reviewer ? publicUser(r.reviewer) : null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  async adminApplications(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    // include reviewedBy 以便前端展示申请处理人（未处理时为 null）。
    // 安全修复 B1：include: { user: true } 会原样返回整行 User（含 passwordHash/tokenVersion），
    // 经 Nest 序列化泄漏凭据哈希。与 adminUsers 等接口一致，出参按 publicUser 白名单脱敏。
    // 组E 性能：take:200 上限防全表扫描（TeamAdminApplication 表随申请累积膨胀，无上限会拖慢响应）。
    // status/createdAt 已有 @@index([status, createdAt]) 支撑，后续如需按状态过滤可加 where。
    const applications = await this.prisma.teamAdminApplication.findMany({ include: { user: true, reviewedBy: true }, orderBy: { createdAt: 'desc' }, take: 200 });
    return {
      applications: applications.map((a) => ({
        ...a,
        user: publicUser(a.user),
        reviewedBy: a.reviewedBy ? publicUser(a.reviewedBy) : null,
      })),
    };
  }

  async approveApplication(actorId: string, id: string) {
    // createTeamForApplication 内部已 ensurePlatformAdmin + 校验状态，返回建好的团队。
    const team = await this.auth.createTeamForApplication(id, actorId);
    // 通知申请者：团队管理员申请已通过（触发失败不阻塞主操作）。
    // createTeamForApplication 已保证 application 存在且 status 已转 APPROVED，此处直接读申请者 userId。
    const application = await this.prisma.teamAdminApplication.findUnique({ where: { id }, select: { userId: true, teamName: true } });
    if (application?.userId) {
      try {
        await this.notifications.create(
          application.userId,
          'application_approved',
          '团队管理员申请已通过',
          `你的团队管理员申请已通过，团队「${application.teamName}」已创建。`,
          { relatedType: 'Team', relatedId: team.id },
        );
      } catch {
        // 通知触发失败不阻塞主流程。
      }
    }
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
    // 通知申请者：团队管理员申请未通过（触发失败不阻塞主操作）。
    try {
      await this.notifications.create(
        application.userId,
        'application_rejected',
        '团队管理员申请未通过',
        `你的团队管理员申请未通过${reason ? `：${reason}` : ''}。`,
        { relatedType: 'TeamAdminApplication', relatedId: id },
      );
    } catch {
      // 通知触发失败不阻塞主流程。
    }
    return { application: updated };
  }

  /**
   * 审计日志列表（支持分类筛选 + 关键词搜索 + 操作者/对象过滤）。
   *
   * 过滤策略（组D 审计完善）：
   *  - category：按 action 前缀分类筛选。Prisma 无「前缀 LIKE」原生支持，需取该分类下所有已知 action，
   *    再用 action: { in: [...] } 过滤。未注册 action 的分类靠 auditActionCategory 推断，但无法在 DB 层
   *    按「推断分类」过滤（DB 只认 action 字面量）。故分类筛选采用「该分类下所有已注册 + 前缀匹配」组合：
   *    已注册 action 用显式列表，未注册的用 startsWith 前缀（覆盖未来新增的同前缀 action）。
   *  - q：关键词搜索，匹配 action / actor email / targetId（OR 组合）。
   *  - actorId / targetType：精确过滤。
   *  - category + q 同时存在：两组条件 AND 串联（交集），见 AUDIT-OR 修复。
   *
   * 性能：AuditLog 已有 createdAt + actorUserId 索引；action 无索引但 take: 200 + orderBy createdAt desc
   * 使扫描面可控。如未来量大可加 action 索引（非破坏式迁移）。
   */
  async auditLogs(
    userId: string,
    filters: { category?: AuditCategoryKey; q?: string; actorId?: string; targetType?: string } = {},
  ) {
    await this.auth.ensurePlatformAdmin(userId);
    // 安全修复 B2：include: { actor: true } 会原样返回整行 User（含 passwordHash/tokenVersion），
    // 与 adminApplications 同类凭据泄漏。改用 select 显式挑白名单字段，杜绝哈希外泄。
    const where: Prisma.AuditLogWhereInput = {};
    if (filters.actorId) where.actorUserId = filters.actorId;
    if (filters.targetType) where.targetType = filters.targetType;

    // 分类筛选：组合「已注册 action 列表 + 前缀 startsWith」，覆盖注册表与未来同前缀新增。
    // category OR 组：满足该分类下任一 action 条件。
    let categoryConditions: Prisma.AuditLogWhereInput[] | null = null;
    if (filters.category) {
      const prefix = this.categoryPrefix(filters.category);
      const conditions: Prisma.AuditLogWhereInput[] = [];
      if (prefix) conditions.push({ action: { startsWith: prefix } });
      // 已注册的 action（含跨前缀归类，如 platform_admin.bootstrap → system）。
      const registered = this.registeredActionsByCategory(filters.category);
      if (registered.length > 0) conditions.push({ action: { in: registered } });
      if (conditions.length > 0) categoryConditions = conditions;
    }

    // 关键词搜索：action / actor email / targetId 模糊匹配（OR 组合）。
    // actor email 需走 relation 查询（actor 是 User 关联），用 actor: { email: { contains } }。
    let keywordConditions: Prisma.AuditLogWhereInput[] | null = null;
    if (filters.q) {
      const kw = filters.q.trim();
      if (kw) {
        keywordConditions = [
          { action: { contains: kw, mode: 'insensitive' } },
          { targetId: { contains: kw, mode: 'insensitive' } },
          { actor: { email: { contains: kw, mode: 'insensitive' } } },
        ];
      }
    }

    // 修复 AUDIT-OR：此前 category 与 q 的条件被扁平合并进同一个 where.OR，
    // 形成 (category 条件 OR keyword 条件) 的并集，而非预期的 (category) AND (keyword) 交集，
    // 导致管理员同时筛选分类 + 关键词时结果范围被错误扩大。
    // 现按「各自独立 OR 组、整体 AND 串联」构建：
    //  - 两者皆有：where.AND = [ { OR: category }, { OR: keyword } ]（交集，语义正确）。
    //  - 仅其一：where.OR = 该组（与历史单独筛选行为一致）。
    if (categoryConditions && keywordConditions) {
      where.AND = [{ OR: categoryConditions }, { OR: keywordConditions }];
    } else if (categoryConditions) {
      where.OR = categoryConditions;
    } else if (keywordConditions) {
      where.OR = keywordConditions;
    }

    const logs = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { actor: { select: { id: true, email: true, displayName: true, platformRole: true, status: true } } },
    });
    return { logs };
  }

  /**
   * 返回审计分类元数据（key + 中文 + 说明），供前端筛选下拉渲染。
   * 分类 key 与 action 前缀对齐，前端据此构建分类筛选 UI。
   */
  async auditCategories(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    return { categories: AUDIT_CATEGORIES };
  }

  /** 分类 → 主前缀（用于 DB startsWith 过滤，覆盖未来同前缀新增 action）。 */
  private categoryPrefix(category: AuditCategoryKey): string | null {
    const map: Record<AuditCategoryKey, string | null> = {
      auth: 'auth.',
      team: 'team.',
      plugin: 'plugin.',
      marketplace: 'marketplace.',
      wallet: 'wallet.',
      llm: 'llm_binding.',
      admin: 'admin.',
      system: null, // system 含 admin.setting. / platform_admin.，无单一前缀，仅靠注册表。
    };
    return map[category];
  }

  /** 分类 → 该分类下所有已注册 action（含跨前缀归类的，如 team 含 invitation. / team_admin_application.）。 */
  private registeredActionsByCategory(category: AuditCategoryKey): string[] {
    return Object.keys(AUDIT_ACTION_LABEL).filter((action) => auditActionCategory(action) === category);
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}