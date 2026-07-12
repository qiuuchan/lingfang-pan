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
import {
  SYSTEM_PLATFORM_ADMIN_ROLE_ID,
  SYSTEM_TEAM_ADMIN_ROLE_CODE,
  teamAdminRoleId,
  teamMemberRoleId,
} from './permissions/permission-codes';
import { AUDIT_CATEGORIES } from './audit-actions';
import {
  adminApplicationDetail,
  adminApplicationDetailSelect,
  type AdminApplicationListQuery,
  adminApplicationSummary,
  adminApplicationSummarySelect,
  applicationTeamSystemRoles,
  buildAdminApplicationListQuery,
} from './admin-applications';
import {
  ADMIN_ACTIVITY_SELECT,
  ADMIN_AUDIT_DETAIL_SELECT,
  ADMIN_AUDIT_SUMMARY_SELECT,
  ADMIN_TEAM_DETAIL_SELECT,
  ADMIN_TEAM_LEDGER_SELECT,
  ADMIN_TEAM_MEMBER_SELECT,
  ADMIN_TEAM_PLUGIN_SELECT,
  ADMIN_TEAM_PURCHASE_SELECT,
  ADMIN_TEAM_SUMMARY_SELECT,
  ADMIN_USER_LOGIN_SELECT,
  ADMIN_USER_OPTION_SELECT,
  ADMIN_USER_SUMMARY_SELECT,
  ADMIN_USER_TEAM_SELECT,
  ADMIN_WALLET_TRANSACTION_SELECT,
  adminAuditDetail,
  adminAuditSummary,
  adminAuditWhere,
  adminTeamOrderBy,
  adminTeamWhere,
  adminUserOrderBy,
  adminUserOption,
  adminUserSummary,
  adminUserWhere,
  normalizeAdminPage,
  type AdminAuditListQuery,
  type AdminPageQuery,
  type AdminTeamListQuery,
  type AdminUserListQuery,
} from './admin-data-loading';

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
    const [
      users,
      teams,
      pendingApplications,
      pendingPluginReviews,
      activePluginPackages,
      activeMarketplaceListings,
      delistedMarketplaceListings,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.team.count(),
      this.prisma.teamAdminApplication.count({ where: { status: 'PENDING' } }),
      this.prisma.pluginRelease.count({ where: { marketReviewStatus: 'PENDING' } }),
      this.prisma.pluginPackage.count({ where: { governanceStatus: 'ACTIVE' } }),
      this.prisma.marketplaceListing.count({ where: { status: 'ACTIVE' } }),
      this.prisma.marketplaceListing.count({ where: { status: 'DELISTED' } }),
    ]);
    return {
      users,
      teams,
      pendingApplications,
      pendingPluginReviews,
      activePluginPackages,
      activeMarketplaceListings,
      delistedMarketplaceListings,
    };
  }

  // 平台级 AI 生成质量看板（调研报告 Top10 / A4）。
  // 数据源：LlmCallLog（relay 每次 AI 调用都写一条，含 status/durationMs/credits，真实且准确）。
  //   - 调用次数：LlmCallLog 总数（无论成功失败，发生过即算一次调用）。
  //   - 成功次数：status = 'success'。
  //   - 失败次数：status in (upstream_error/client_error/no_channel/no_pricing/insufficient_balance)。
  //   - 平均耗时：avg(durationMs)（仅 success，失败请求耗时无质量参考意义）。
  //
  // 历史：首版基于 AuditLog 的 llm_binding.key_decrypted 统计（旧架构：桌面端发起生成会解密 LLM key）。
  // 但灵坊现已改为 relay + JWT 架构（relay.service.ts），AI 调用不再解密 llm_binding key，
  // 导致该审计日志不再产生、调用次数恒为旧值/0。改用 LlmCallLog 后数据准确反映真实调用量。
  async adminGenerationStats(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    // 月度窗口：当前自然月起始 → 现在（取本月初便于运营观察近期质量趋势）。
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    // 失败状态集合（relay executeRelay 的所有非 success 终态）。
    const failStatuses = ['upstream_error', 'client_error', 'no_channel', 'no_pricing', 'insufficient_balance'];
    const [monthCalls, monthSuccess, monthFailed, monthDurationAgg, totalCalls, totalSuccess, totalFailed, totalDurationAgg] = await Promise.all([
      this.prisma.llmCallLog.count({ where: { createdAt: { gte: monthStart } } }),
      this.prisma.llmCallLog.count({ where: { status: 'success', createdAt: { gte: monthStart } } }),
      this.prisma.llmCallLog.count({ where: { status: { in: failStatuses }, createdAt: { gte: monthStart } } }),
      this.prisma.llmCallLog.aggregate({ where: { status: 'success', createdAt: { gte: monthStart } }, _avg: { durationMs: true } }),
      this.prisma.llmCallLog.count({}),
      this.prisma.llmCallLog.count({ where: { status: 'success' } }),
      this.prisma.llmCallLog.count({ where: { status: { in: failStatuses } } }),
      this.prisma.llmCallLog.aggregate({ where: { status: 'success' }, _avg: { durationMs: true } }),
    ]);
    const safeRate = (calls: number, success: number) => (calls > 0 ? Math.round((success / calls) * 1000) / 10 : 0);
    return {
      period: 'current_month',
      month: { calls: monthCalls, success: monthSuccess, failed: monthFailed, successRate: safeRate(monthCalls, monthSuccess) },
      total: { calls: totalCalls, success: totalSuccess, failed: totalFailed, successRate: safeRate(totalCalls, totalSuccess) },
      // 平均耗时：成功调用的 avg(durationMs)，null 时前端不渲染（Prisma 对无匹配行返回 null）。
      avgDurationMs: monthDurationAgg._avg.durationMs ?? null,
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

  async adminUsers(userId: string, query: AdminUserListQuery = {}) {
    await this.auth.ensurePlatformAdmin(userId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where = adminUserWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: adminUserOrderBy(query),
        skip,
        take: pageSize,
        select: ADMIN_USER_SUMMARY_SELECT,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items: rows.map(adminUserSummary), total, page, pageSize };
  }

  async adminUserOptions(userId: string, query: { q?: string; limit?: number } = {}) {
    await this.auth.ensurePlatformAdmin(userId);
    const pageSize = Math.min(50, Math.max(1, Math.floor(query.limit ?? 20)));
    const where = adminUserWhere({ q: query.q, status: 'ACTIVE' });
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: [{ displayName: 'asc' }, { email: 'asc' }, { id: 'asc' }],
      take: pageSize,
      select: ADMIN_USER_OPTION_SELECT,
    });
    const items = rows.map(adminUserOption);
    return { items, total: items.length, page: 1, pageSize };
  }

  async adminCreateUser(actorId: string, input: { email: string; password: string; displayName?: string; platformRole?: 'NONE' | 'PLATFORM_ADMIN' }) {
    await this.auth.ensurePlatformAdmin(actorId);
    const email = input.email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(input.password || 'ChangeMe123!', 12);
    const platformRole = input.platformRole || 'NONE';
    // RBAC 双写：platformRole 枚举 + platformRoleId 同步。
    const platformRoleId = platformRole === 'PLATFORM_ADMIN' ? SYSTEM_PLATFORM_ADMIN_ROLE_ID : null;
    const user = await this.prisma.user.create({ data: { email, passwordHash, displayName: input.displayName || email, platformRole, platformRoleId } });
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
    const data: { displayName?: string; status?: 'ACTIVE' | 'DISABLED'; platformRole?: 'NONE' | 'PLATFORM_ADMIN'; platformRoleId?: string | null; email?: string; passwordHash?: string; tokenVersion?: { increment: number } } = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.status !== undefined) data.status = input.status;
    if (input.platformRole !== undefined) {
      data.platformRole = input.platformRole;
      // RBAC 双写：platformRole 枚举变化时同步 platformRoleId，保持权限守卫解析一致。
      data.platformRoleId = input.platformRole === 'PLATFORM_ADMIN' ? SYSTEM_PLATFORM_ADMIN_ROLE_ID : null;
    }
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

  async adminUserDetail(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: ADMIN_USER_SUMMARY_SELECT,
    });
    if (!user) throw notFound('用户不存在');
    return { user: adminUserSummary(user) };
  }

  async adminUserLogins(actorId: string, id: string, query: AdminPageQuery = {}) {
    await this.auth.ensurePlatformAdmin(actorId);
    await this.ensureAdminUserExists(id);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where: Prisma.AuditLogWhereInput = {
      actorUserId: id,
      action: { startsWith: 'auth.' },
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        select: ADMIN_USER_LOGIN_SELECT,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    const items = rows.map((log) => ({
      id: log.id,
      action: log.action,
      createdAt: log.createdAt,
    }));
    return { items, total, page, pageSize };
  }

  async adminUserTeams(actorId: string, id: string, query: AdminPageQuery = {}) {
    await this.auth.ensurePlatformAdmin(actorId);
    await this.ensureAdminUserExists(id);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where: Prisma.TeamMembershipWhereInput = { userId: id };
    const [rows, total] = await Promise.all([
      this.prisma.teamMembership.findMany({
        where,
        orderBy: [{ joinedAt: 'desc' }, { teamId: 'asc' }],
        skip,
        take: pageSize,
        select: ADMIN_USER_TEAM_SELECT,
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
      team: {
        id: membership.team.id,
        name: membership.team.name,
        slug: membership.team.slug,
        status: membership.team.status,
        balanceCents: membership.team.balanceCents,
      },
    }));
    return { items, total, page, pageSize };
  }

  async adminUserWallet(actorId: string, id: string, query: AdminPageQuery = {}) {
    await this.auth.ensurePlatformAdmin(actorId);
    await this.ensureAdminUserExists(id);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where: Prisma.WalletTransactionWhereInput = { userId: id };
    const [wallet, rows, total] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { userId: id }, select: { balanceCents: true } }),
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        select: ADMIN_WALLET_TRANSACTION_SELECT,
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);
    const items = rows.map((transaction) => ({
      id: transaction.id,
      amountCents: transaction.amountCents,
      direction: transaction.direction,
      reason: transaction.reason,
      pluginId: transaction.pluginId,
      counterpartyUserId: transaction.counterpartyUserId,
      createdAt: transaction.createdAt,
    }));
    return { items, total, page, pageSize, balanceCents: wallet?.balanceCents ?? 0 };
  }

  // 管理员强制重置用户密码：生成临时密码（12 位 base64url 随机串），写库 + 通知用户（站内信 + 邮件），
  // tokenVersion++ 作废所有旧登录 token（强制重新登录）。返回临时密码给 admin 一次性转交（不在审计/邮件外泄）。
  //
  // 安全设计：
  //  - 临时密码用 randomBytes(9) 生成（密码学安全随机源），base64url 字母表无歧义字符，便于人工转抄。
  //  - 临时密码仅在响应里返回一次给操作 admin，审计 metadata 不记录密码值（仅记 {reset: true}）。
  //  - 触发站内通知 + 邮件；邮件失败随响应显式返回，避免管理员误以为通知已送达。
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
    const emailNotice = await this.sendPasswordResetNotice(user.email, resetNoticeHtml);
    return { tempPassword, user: publicUser(user), emailNotice };
  }

  private async sendPasswordResetNotice(email: string, html: string) {
    try {
      await this.mail.sendMail(email, '你的密码已被管理员重置', html);
      return { sent: true, message: '邮件通知已发送' };
    } catch (error) {
      const message = (error as Error).message || '未知错误';
      console.error('[admin.reset_password.mail_failed]', { email, error: message });
      return { sent: false, message: `邮件通知未发送：${message}` };
    }
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
    // RBAC 双写：platformRole 枚举 + platformRoleId 同步。
    const data: { platformRole: 'NONE' | 'PLATFORM_ADMIN'; platformRoleId: string | null; tokenVersion?: { increment: number } } = {
      platformRole: input.platformRole,
      platformRoleId: input.platformRole === 'PLATFORM_ADMIN' ? SYSTEM_PLATFORM_ADMIN_ROLE_ID : null,
    };
    if (input.platformRole === 'NONE') data.tokenVersion = { increment: 1 };
    const user = await this.prisma.user.update({ where: { id }, data });
    await this.audit(actorId, 'admin.user.role_changed', 'User', id, { from: target.platformRole, to: input.platformRole });
    return { user: publicUser(user) };
  }

  async adminActivity(actorId: string, targetUserId: string, query: AdminPageQuery = {}) {
    await this.auth.ensurePlatformAdmin(actorId);
    await this.ensureAdminUserExists(targetUserId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where: Prisma.AuditLogWhereInput = { actorUserId: targetUserId };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        select: ADMIN_ACTIVITY_SELECT,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    const items = rows.map((log) => ({
      id: log.id,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      createdAt: log.createdAt,
    }));
    return { items, total, page, pageSize };
  }

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
        data: { tokenVersion: { increment: 1 } },
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
      this.prisma.plugin.count({ where: { teamId } }),
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
    const where: Prisma.PluginWhereInput = { teamId };
    const [rows, total] = await Promise.all([
      this.prisma.plugin.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        select: ADMIN_TEAM_PLUGIN_SELECT,
      }),
      this.prisma.plugin.count({ where }),
    ]);
    const items = rows.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      status: plugin.status,
      visibility: plugin.visibility,
      reviewStatus: plugin.reviewStatus,
      marketplace: plugin.marketplace,
      priceCents: plugin.priceCents,
      installCount: plugin.installCount,
      createdAt: plugin.createdAt,
      updatedAt: plugin.updatedAt,
    }));
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
      pluginId: purchase.pluginId,
      packageId: purchase.packageId,
      pluginName: purchase.package?.name ?? purchase.plugin?.name ?? '未知插件',
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
    // 允许管理员对草稿(DRAFT)或待审(PENDING)插件直接通过审核。
    // DRAFT 场景：作者未主动提交市场审核时，管理员可在后台插件详情直接上架（跳过作者提交步骤）。
    if (plugin.reviewStatus !== 'PENDING' && plugin.reviewStatus !== 'DRAFT') throw conflict('插件不在审核中且非草稿，无法直接审核');
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
    // Task 7「新版本推送」：重新审核通过（通常是作者改版后重提）且已有用户安装旧版本时，
    // 向每位安装了旧版本的用户推 new_version 通知。首次上架无安装记录 → 不触发。
    // 触发失败不阻塞审核主流程（与上方作者通知同语义）。
    try {
      const installations = await this.prisma.pluginInstallation.findMany({
        where: { pluginId: id, status: 'ENABLED' },
        select: { installedById: true, version: true },
      });
      const newVersion = updated.version;
      for (const inst of installations) {
        if (!inst.installedById || inst.version === newVersion) continue;
        try {
          await this.notifications.create(
            inst.installedById,
            'new_version',
            '插件有新版本',
            `你安装的「${plugin.name}」发布了新版本 v${newVersion}（当前 v${inst.version}），可在插件页更新。`,
            { relatedType: 'Plugin', relatedId: id },
          );
        } catch {
          /* 单条通知失败不影响其它用户 */
        }
      }
    } catch {
      /* 查询安装记录失败不阻塞审核 */
    }
    return { plugin: publicPlugin(updated, updated.teamId || undefined) };
  }

  async adminRejectPlugin(actorId: string, id: string, reason?: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const plugin = await this.prisma.plugin.findUnique({ where: { id } });
    if (!plugin) throw notFound('插件不存在');
    // 同 adminApprovePlugin：允许驳回 DRAFT/PENDING（管理员可对未提交审核的草稿打回并附原因）。
    if (plugin.reviewStatus !== 'PENDING' && plugin.reviewStatus !== 'DRAFT') throw conflict('插件不在审核中且非草稿，无法驳回');
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

  async adminApplications(userId: string, query: AdminApplicationListQuery = {}) {
    await this.auth.ensurePlatformAdmin(userId);
    const { page, pageSize, skip, where } = buildAdminApplicationListQuery(query);
    const [applications, total] = await Promise.all([
      this.prisma.teamAdminApplication.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        select: adminApplicationSummarySelect,
      }),
      this.prisma.teamAdminApplication.count({ where }),
    ]);
    return {
      items: applications.map(adminApplicationSummary),
      total,
      page,
      pageSize,
    };
  }

  async adminApplication(userId: string, id: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const application = await this.prisma.teamAdminApplication.findUnique({
      where: { id },
      select: adminApplicationDetailSelect,
    });
    if (!application) throw notFound('申请不存在');
    return { application: adminApplicationDetail(application) };
  }

  async approveApplication(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const result = await this.prisma.$transaction(async (tx) => {
      const application = await tx.teamAdminApplication.findUnique({
        where: { id },
        select: { id: true, userId: true, teamName: true },
      });
      if (!application) throw notFound('申请不存在');

      const reviewedAt = new Date();
      const claimed = await tx.teamAdminApplication.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'APPROVED', reviewReason: '', reviewedById: actorId, reviewedAt },
      });
      if (claimed.count !== 1) throw conflict('该申请已处理');

      const team = await tx.team.create({
        data: {
          name: application.teamName,
          slug: `${slugify(application.teamName)}-${application.id.slice(0, 6)}`,
        },
      });
      const systemRoles = applicationTeamSystemRoles(team.id);
      for (const role of systemRoles.roles) await tx.role.create({ data: role });
      await tx.teamMembership.create({
        data: {
          teamId: team.id,
          userId: application.userId,
          role: 'TEAM_ADMIN',
          teamRoleId: systemRoles.adminRoleId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'team_admin_application.approved',
          targetType: 'TeamAdminApplication',
          targetId: id,
          metadata: { teamId: team.id },
        },
      });
      return { team, application };
    });

    try {
      await this.notifications.create(
        result.application.userId,
        'application_approved',
        '团队管理员申请已通过',
        `你的团队管理员申请已通过，团队「${result.application.teamName}」已创建。`,
        { relatedType: 'Team', relatedId: result.team.id },
      );
    } catch {
      // 通知失败不回滚已提交的审批事务。
    }
    return { team: result.team };
  }

  async rejectApplication(actorId: string, id: string, reason?: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const reviewReason = typeof reason === 'string' ? reason.trim() : '';
    if (!reviewReason || reviewReason.length > 500) throw badRequest('驳回原因需为 1-500 字');

    const result = await this.prisma.$transaction(async (tx) => {
      const application = await tx.teamAdminApplication.findUnique({
        where: { id },
        select: { id: true, userId: true, teamName: true },
      });
      if (!application) throw notFound('申请不存在');

      const reviewedAt = new Date();
      const claimed = await tx.teamAdminApplication.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REJECTED', reviewReason, reviewedById: actorId, reviewedAt },
      });
      if (claimed.count !== 1) throw conflict('该申请已处理');

      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'team_admin_application.rejected',
          targetType: 'TeamAdminApplication',
          targetId: id,
          metadata: { reason: reviewReason },
        },
      });
      const updated = await tx.teamAdminApplication.findUnique({
        where: { id },
        select: adminApplicationDetailSelect,
      });
      if (!updated) throw notFound('申请不存在');
      return { application, updated };
    });

    try {
      await this.notifications.create(
        result.application.userId,
        'application_rejected',
        '团队管理员申请未通过',
        `你的团队管理员申请未通过：${reviewReason}。`,
        { relatedType: 'TeamAdminApplication', relatedId: id },
      );
    } catch {
      // 通知失败不回滚已提交的审批事务。
    }
    return { application: adminApplicationDetail(result.updated) };
  }

  async auditLogs(userId: string, filters: AdminAuditListQuery = {}) {
    await this.auth.ensurePlatformAdmin(userId);
    const { page, pageSize, skip } = normalizeAdminPage(filters);
    const where = adminAuditWhere(filters);
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        select: ADMIN_AUDIT_SUMMARY_SELECT,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items: rows.map(adminAuditSummary), total, page, pageSize };
  }

  async auditLog(userId: string, id: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const log = await this.prisma.auditLog.findUnique({
      where: { id },
      select: ADMIN_AUDIT_DETAIL_SELECT,
    });
    if (!log) throw notFound('审计日志不存在');
    return { log: adminAuditDetail(log) };
  }

  /**
   * 返回审计分类元数据（key + 中文 + 说明），供前端筛选下拉渲染。
   * 分类 key 与 action 前缀对齐，前端据此构建分类筛选 UI。
   */
  async auditCategories(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    return { categories: AUDIT_CATEGORIES };
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

  private async ensureAdminUserExists(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw notFound('用户不存在');
  }

  private async ensureAdminTeamExists(id: string) {
    const team = await this.prisma.team.findUnique({ where: { id }, select: { id: true } });
    if (!team) throw notFound('团队不存在');
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}
