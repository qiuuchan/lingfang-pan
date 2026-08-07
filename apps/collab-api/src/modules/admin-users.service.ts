import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { badRequest, conflict, forbidden, notFound, publicUser } from '../common';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { NotificationService } from './notification.service';
import { SYSTEM_PLATFORM_ADMIN_ROLE_ID } from './permissions/permission-codes';
import {
  ADMIN_ACTIVITY_SELECT,
  ADMIN_USER_LOGIN_SELECT,
  ADMIN_USER_OPTION_SELECT,
  ADMIN_USER_SUMMARY_SELECT,
  ADMIN_USER_TEAM_SELECT,
  ADMIN_WALLET_TRANSACTION_SELECT,
  adminUserOption,
  adminUserSummary,
  adminUserWhere,
  adminUserOrderBy,
  normalizeAdminPage,
  type AdminPageQuery,
  type AdminUserListQuery,
} from './admin-data-loading';

@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(MailService) private readonly mail: MailService
  ) {}

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

  async adminCreateUser(
    actorId: string,
    input: {
      email: string;
      password: string;
      displayName?: string;
      platformRole?: 'NONE' | 'PLATFORM_ADMIN';
    }
  ) {
    await this.auth.ensurePlatformAdmin(actorId);
    const email = input.email.trim().toLowerCase();
    if (!input.password) throw badRequest('初始密码不能为空');
    if (input.password.length < 8) throw badRequest('密码至少 8 位');
    const passwordHash = await bcrypt.hash(input.password, 12);
    const platformRole = input.platformRole || 'NONE';
    // RBAC 双写：platformRole 枚举 + platformRoleId 同步。
    const platformRoleId = platformRole === 'PLATFORM_ADMIN' ? SYSTEM_PLATFORM_ADMIN_ROLE_ID : null;
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: input.displayName || email,
        platformRole,
        platformRoleId,
      },
    });
    await this.audit(actorId, 'admin.user.created', 'User', user.id, { email });
    return { user: publicUser(user) };
  }

  async adminUpdateUser(
    actorId: string,
    id: string,
    input: {
      displayName?: string;
      status?: 'ACTIVE' | 'DISABLED';
      platformRole?: 'NONE' | 'PLATFORM_ADMIN';
      email?: string;
      password?: string;
    }
  ) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 修复 ADMIN-09：禁止自降级/自禁用（会锁死末位平台管理员）。
    if (id === actorId && (input.status === 'DISABLED' || input.platformRole === 'NONE')) {
      throw forbidden('不能禁用或降级自己的平台管理员权限');
    }
    // 修复 ADMIN-09：禁止禁用/降级最后一个 PLATFORM_ADMIN。
    if (input.status === 'DISABLED' || input.platformRole === 'NONE') {
      const target = await this.prisma.user.findUnique({
        where: { id },
        select: { platformRole: true, status: true },
      });
      if (target?.platformRole === 'PLATFORM_ADMIN' && target.status === 'ACTIVE') {
        const remainingAdmins = await this.prisma.user.count({
          where: { platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' },
        });
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
    const data: {
      displayName?: string;
      status?: 'ACTIVE' | 'DISABLED';
      platformRole?: 'NONE' | 'PLATFORM_ADMIN';
      platformRoleId?: string | null;
      email?: string;
      passwordHash?: string;
      tokenVersion?: { increment: number };
    } = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.status !== undefined) data.status = input.status;
    if (input.platformRole !== undefined) {
      data.platformRole = input.platformRole;
      // RBAC 双写：platformRole 枚举变化时同步 platformRoleId，保持权限守卫解析一致。
      data.platformRoleId =
        input.platformRole === 'PLATFORM_ADMIN' ? SYSTEM_PLATFORM_ADMIN_ROLE_ID : null;
    }
    if (normalizedEmail !== undefined) data.email = normalizedEmail;
    // password 明文 → bcrypt hash（与 register/login 一致 cost=12）。
    if (input.password !== undefined) {
      if (input.password.length < 8) throw badRequest('密码至少 8 位');
      data.passwordHash = await bcrypt.hash(input.password, 12);
    }
    // 修复 ADMIN-02 / AUTH-01：禁用或降级时自增 tokenVersion，使已签发的旧 token 立即失效。
    // 改 email 或 password 也自增 tokenVersion（强制重新登录，旧 token 作废）。
    if (
      input.status === 'DISABLED' ||
      input.platformRole === 'NONE' ||
      normalizedEmail !== undefined ||
      input.password !== undefined
    ) {
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
    const target = await this.prisma.user.findUnique({
      where: { id },
      select: { platformRole: true, status: true },
    });
    if (target?.platformRole === 'PLATFORM_ADMIN' && target.status === 'ACTIVE') {
      const remainingAdmins = await this.prisma.user.count({
        where: { platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' },
      });
      if (remainingAdmins <= 1) throw forbidden('不能禁用最后一个平台管理员');
    }
    // tokenVersion 自增使旧 token 立即失效（ADMIN-02）；此前旧 token 最长 7 天仍可用。
    const user = await this.prisma.user.update({
      where: { id },
      data: { status: 'DISABLED', tokenVersion: { increment: 1 } },
    });
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
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, displayName: true, status: true },
    });
    if (!user) throw notFound('用户不存在');
    // 生成临时密码：randomBytes(9) → base64url 恰好 12 字符（72 bits，ceil(72/6)=12，无 padding 截断）。
    // base64url 字母表（A-Z a-z 0-9 - _）无歧义字符，便于人工转抄。
    const tempPassword = randomBytes(9).toString('base64url');
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    // 事务：改密 + tokenVersion++（原子，作废旧 token）+ 审计（审计不记密码值）。
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });
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
        { relatedType: 'User', relatedId: id }
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
  async adminUpdateUserPlatformRole(
    actorId: string,
    id: string,
    input: { platformRole: 'NONE' | 'PLATFORM_ADMIN' }
  ) {
    await this.auth.ensurePlatformAdmin(actorId);
    // 禁止自改自身：防自降级（锁死末位管理员）+ 防自提权（绕过审批链）。
    if (id === actorId) throw forbidden('不能调整自己的平台管理员角色');
    const target = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, displayName: true, platformRole: true, status: true },
    });
    if (!target) throw notFound('用户不存在');
    // 幂等优化：已是目标角色则不重复写审计，避免无变更操作污染审计日志。
    if (target.platformRole === input.platformRole) {
      return { user: publicUser(target) };
    }
    // 降级（PLATFORM_ADMIN → NONE）时禁止降级最后一个管理员。
    if (
      input.platformRole === 'NONE' &&
      target.platformRole === 'PLATFORM_ADMIN' &&
      target.status === 'ACTIVE'
    ) {
      const remainingAdmins = await this.prisma.user.count({
        where: { platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' },
      });
      if (remainingAdmins <= 1) throw forbidden('不能降级最后一个平台管理员');
    }
    // 降级时 tokenVersion++ 作废旧 token（与 adminUpdateUser 同款语义），升级则不需要（提权不涉及吊销）。
    // RBAC 双写：platformRole 枚举 + platformRoleId 同步。
    const data: {
      platformRole: 'NONE' | 'PLATFORM_ADMIN';
      platformRoleId: string | null;
      tokenVersion?: { increment: number };
    } = {
      platformRole: input.platformRole,
      platformRoleId:
        input.platformRole === 'PLATFORM_ADMIN' ? SYSTEM_PLATFORM_ADMIN_ROLE_ID : null,
    };
    if (input.platformRole === 'NONE') data.tokenVersion = { increment: 1 };
    const user = await this.prisma.user.update({ where: { id }, data });
    await this.audit(actorId, 'admin.user.role_changed', 'User', id, {
      from: target.platformRole,
      to: input.platformRole,
    });
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

  private async ensureAdminUserExists(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw notFound('用户不存在');
  }

  private async audit(
    actorUserId: string,
    action: string,
    targetType: string,
    targetId?: string,
    metadata?: unknown
  ) {
    await this.prisma.auditLog.create({
      data: { actorUserId, action, targetType, targetId, metadata: metadata as object },
    });
  }
}
