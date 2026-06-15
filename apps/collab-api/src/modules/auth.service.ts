import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt, { type Secret, type SignOptions } from 'jsonwebtoken';
import { PrismaService } from '../prisma.service';
import { badRequest, conflict, forbidden, slugify, unauthorized } from '../common';
import { MailService } from './mail.service';
import { GeetestService, type GeetestCaptchaParams } from './geetest.service';

export type OnboardingState =
  | 'NEEDS_INVITATION'
  | 'PENDING_APPROVAL'
  | 'APPLICATION_REJECTED'
  | 'TEAM_SPACE'
  | 'TEAM_ADMIN_SPACE'
  | 'PLATFORM_ADMIN_WEB_ONLY';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(GeetestService) private readonly geetest: GeetestService,
  ) {}

  /**
   * 组C 极验验证码校验守卫：供 login/register/forgotPassword 复用。
   * - 后端配置了 geetestCaptchaId 时强制校验：captcha 缺失或校验失败 → throw badRequest('请先完成验证码')。
   * - 未配置极验 → 直接跳过（开发态不强制，前端也不显验证码）。
   * 极验 API 异常时 GeetestService.validate 自身降级放行（容灾，不阻断登录），此处无需重复处理。
   */
  private async requireCaptcha(captcha?: Partial<GeetestCaptchaParams>): Promise<void> {
    const configured = await this.geetest.isConfigured();
    if (!configured) return;
    const ok = await this.geetest.validate(captcha);
    if (!ok) throw badRequest('请先完成验证码');
  }

  async register(input: { email: string; password: string; displayName?: string; wantsTeamAdmin?: boolean; teamName?: string; reason?: string; captcha?: Partial<GeetestCaptchaParams> }) {
    // 组C 极验：配置极验后强制校验验证码（在所有业务逻辑之前，避免无效请求消耗 DB 查询）。
    await this.requireCaptcha(input.captcha);
    const email = input.email?.trim().toLowerCase();
    // 邮箱格式与密码长度校验已下沉到 RegisterDto（@IsEmail / @MinLength(8)），
    // 此前重复的手动校验移除以保持单一来源；归一化 trim/lowercase 保留。
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw conflict('该邮箱已注册');
    const passwordHash = await bcrypt.hash(input.password, 12);
    // 修复 AUTH-03：此前 user.create 与 teamAdminApplication.create/audit 非原子，
    // application.create 失败会留孤儿 user。包进事务保证一致性。
    const userId = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          displayName: input.displayName?.trim() || email,
        },
      });
      // 注册审计：actor=新用户自身，targetType=User（与 team_admin_application.created 事务内并列）。
      await tx.auditLog.create({ data: { actorUserId: user.id, action: 'auth.register', targetType: 'User', targetId: user.id, metadata: { email } } });
      if (input.wantsTeamAdmin) {
        await tx.teamAdminApplication.create({
          data: {
            userId: user.id,
            teamName: input.teamName?.trim() || `${user.displayName} 的团队`,
            reason: input.reason?.trim() || '',
          },
        });
        await tx.auditLog.create({ data: { actorUserId: user.id, action: 'team_admin_application.created', targetType: 'User', targetId: user.id, metadata: { email } } });
      }
      return user.id;
    });
    // 注册后异步发送邮箱验证邮件（失败不影响注册成功，降级 console.log 兜底）。
    // 首版不阻断登录：emailVerified 仅作标记，前端据 session 提示去验证。
    await this.sendVerificationEmail(userId, email).catch((error) => {
      console.error('[mail.verification_send_failed]', { userId, email, error: (error as Error).message });
    });
    // 事务提交后再读库生成 session（sessionFor 用主 prisma，需读到已提交数据）。
    return this.sessionFor(userId);
  }

  /**
   * 发送邮箱验证邮件：签发独立 verify token（scope=email_verify，TTL 24h，复用 JWT_SECRET），
   * 调 MailService.sendEmailVerification 发统一品牌模板邮件。
   * verify_link 形如 <base>/?verify_token=xxx，由前端解析后调 verify-email 端点完成验证。
   */
  private async sendVerificationEmail(userId: string, email: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true, emailVerified: true } });
    // 已验证的用户不重发（幂等，避免重复邮件骚扰）。
    if (!user || user.emailVerified) return;
    const token = this.issueVerifyToken(userId, email, user.tokenVersion);
    const baseUrl = (process.env.EMAIL_VERIFY_BASE_URL || '').replace(/\/+$/, '');
    const link = baseUrl ? `${baseUrl}/?verify_token=${encodeURIComponent(token)}` : `/?verify_token=${encodeURIComponent(token)}`;
    await this.mail.sendEmailVerification(email, link);
  }

  async login(input: { email: string; password: string; captcha?: Partial<GeetestCaptchaParams> }) {
    // 组C 极验：配置极验后强制校验验证码（在查用户之前，避免无效请求消耗 DB 查询）。
    await this.requireCaptcha(input.captcha);
    const email = input.email?.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    // 登录失败统一审计：actorUserId 可为 null（用户不存在时），便于安全审计追踪暴力破解尝试。
    // 不在错误消息中区分「用户不存在」与「密码错误」（防探测），但审计记录 email 供管理员追溯。
    if (!user || user.status !== 'ACTIVE') {
      await this.prisma.auditLog.create({ data: { actorUserId: null, action: 'auth.login.failed', targetType: 'User', targetId: user?.id ?? null, metadata: { email, reason: user ? 'account_inactive' : 'user_not_found' } } });
      throw unauthorized('邮箱或密码错误');
    }
    // 组B 账户级锁定：与 throttler（IP 限流）正交。lockedUntil 未过期直接拒绝并返剩余分钟，
    // 防分布式 IP 池对单账户的暴力爆破。user_not_found/account_inactive 分支不在此校验（无 user 行）。
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const remainingMinutes = this.remainingLockMinutes(user.lockedUntil);
      await this.prisma.auditLog.create({ data: { actorUserId: user.id, action: 'auth.login.locked', targetType: 'User', targetId: user.id, metadata: { email, remainingMinutes } } });
      throw forbidden(`账户已锁定，请 ${remainingMinutes} 分钟后再试`);
    }
    const ok = await bcrypt.compare(input.password || '', user.passwordHash);
    if (!ok) {
      // 组B 密码错误累计：failedLoginAttempts++，达阈值则设 lockedUntil 并审计 auth.login.locked。
      // 阈值/锁定期由 PlatformSetting 可配（缺省 5 次 / 15min）；事务保证 attempts 与 lockedUntil 原子落库。
      await this.recordFailedLogin(user.id, email);
      await this.prisma.auditLog.create({ data: { actorUserId: user.id, action: 'auth.login.failed', targetType: 'User', targetId: user.id, metadata: { email, reason: 'wrong_password' } } });
      throw unauthorized('邮箱或密码错误');
    }
    // 登录成功审计：actor=用户自身，记录成功事件便于安全合规追溯（此前完全缺失）。
    // 组B 成功后重置失败计数与锁定状态（清零 failedLoginAttempts、置空 lockedUntil）。
    await this.resetFailedLogin(user.id);
    await this.prisma.auditLog.create({ data: { actorUserId: user.id, action: 'auth.login.success', targetType: 'User', targetId: user.id, metadata: { email } } });
    return this.sessionFor(user.id);
  }

  /**
   * 组B：读取账户级锁定阈值与锁定时长（均来自 PlatformSetting，Admin 可调）。
   * - maxLoginAttempts：连续密码错误达该次数触发锁定，默认 5。
   * - lockDurationMinutes：锁定持续分钟数，默认 15。
   * 读取失败或值非法时降级为默认值（不阻断登录主流程），与极验等容灾语义一致。
   */
  private async getLockConfig(): Promise<{ maxAttempts: number; lockMinutes: number }> {
    const defaults = { maxAttempts: 5, lockMinutes: 15 };
    try {
      const rows = await this.prisma.platformSetting.findMany({
        where: { key: { in: ['maxLoginAttempts', 'lockDurationMinutes'] } },
        select: { key: true, value: true },
      });
      const map = new Map(rows.map((r) => [r.key, r.value] as const));
      const maxAttempts = Number.parseInt(map.get('maxLoginAttempts') ?? '', 10);
      const lockMinutes = Number.parseInt(map.get('lockDurationMinutes') ?? '', 10);
      return {
        maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : defaults.maxAttempts,
        lockMinutes: Number.isFinite(lockMinutes) && lockMinutes > 0 ? lockMinutes : defaults.lockMinutes,
      };
    } catch {
      // PlatformSetting 读取失败降级为默认值，登录主流程不中断（容灾优先于精确阈值）。
      return defaults;
    }
  }

  /** 组B：将 lockedUntil 折算为向上取整的剩余分钟数（最少 1，避免提示「0 分钟」误导）。 */
  private remainingLockMinutes(lockedUntil: Date): number {
    const ms = lockedUntil.getTime() - Date.now();
    return Math.max(1, Math.ceil(ms / 60_000));
  }

  /**
   * 组B：记录一次密码错误——failedLoginAttempts 自增，达阈值则置 lockedUntil。
   * update 仅写 attempts/lockedUntil，不碰 passwordHash/tokenVersion（与重置密码逻辑解耦）。
   * 触发锁定时落 auth.login.locked 审计（与 login 入口已锁定时的审计同一 action，便于聚合统计）。
   */
  private async recordFailedLogin(userId: string, email: string) {
    const { maxAttempts, lockMinutes } = await this.getLockConfig();
    // 先读当前 attempts 计算下一次累计值，决定是否跨过阈值触发锁定。
    // 不用原子 increment + 条件判断是因 Prisma 无法在单条 update 内「自增并按新值条件置锁定」，
    // 故采用「读-算-写」两步：并发场景下最坏多算一两次错误，但锁定仍会触发（安全侧偏向锁定）。
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: { failedLoginAttempts: true } });
    const nextAttempts = (row?.failedLoginAttempts ?? 0) + 1;
    const nowOverThreshold = nextAttempts >= maxAttempts;
    await this.prisma.user.update({
      where: { id: userId },
      data: nowOverThreshold
        ? { failedLoginAttempts: nextAttempts, lockedUntil: new Date(Date.now() + lockMinutes * 60_000) }
        : { failedLoginAttempts: nextAttempts },
    });
    if (nowOverThreshold) {
      await this.prisma.auditLog.create({ data: { actorUserId: userId, action: 'auth.login.locked', targetType: 'User', targetId: userId, metadata: { email, attempts: nextAttempts, lockMinutes } } });
    }
  }

  /** 组B：登录成功后重置失败计数与锁定状态（failedLoginAttempts=0、lockedUntil=null）。
   *  写失败不阻塞登录主流程（session 签发优先于计数复位），降级吞错；下次密码错误仍会正常累计。 */
  private async resetFailedLogin(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    }).catch(() => {
      // 重置失败不阻塞登录主流程（session 签发优先），降级吞错；下次失败仍会正常累计。
    });
  }

  async me(userId: string) {
    return this.sessionFor(userId, false);
  }

  async refresh(userId: string) {
    // token 刷新审计：记录滑动续签事件（actor=用户自身），便于安全审计追踪会话活跃度。
    // 失败（sessionFor 抛 unauthorized）时不审计，与 login.failed 区分（refresh 失败多为 token 过期，非恶意）。
    await this.prisma.auditLog.create({ data: { actorUserId: userId, action: 'auth.token.refreshed', targetType: 'User', targetId: userId } }).catch(() => {
      // 审计写入失败不阻塞 refresh 主流程（token 续签优先于审计），降级吞错。
    });
    return this.sessionFor(userId);
  }

  /**
   * 退出登录审计（POST /auth/logout）。
   * 当前版本为无状态 JWT，logout 仅客户端清理 + 审计记录，不在服务端维护 token 黑名单。
   * 审计写入失败不阻塞响应（降级吞错，logout 优先返回成功）。
   */
  async logout(userId: string) {
    await this.prisma.auditLog.create({ data: { actorUserId: userId, action: 'auth.logout', targetType: 'User', targetId: userId } }).catch(() => {
      // 审计写入失败不阻塞 logout 响应。
    });
    return { ok: true };
  }

  /**
   * 找回密码（Top5 解法）：生成短 TTL（15min）的 reset token，发送重置链接邮件。
   *
   * 安全设计：无论邮箱是否注册都返回「链接已发送」——不泄漏邮箱是否注册（防探测枚举）。
   * 仅当邮箱确实存在时才真正发邮件；不存在的邮箱静默跳过（前端无感知差异）。
   * reset token 为独立 JWT（scope='pwd_reset'），与登录 token 分离，复用 JWT_SECRET 签名。
   * token 内嵌 userId，reset-password 时校验 + 改密 + tokenVersion++（作废所有旧登录 token）。
   */
  async forgotPassword(input: { email: string; captcha?: Partial<GeetestCaptchaParams> }) {
    // 组C 极验：配置极验后强制校验验证码（在查用户之前，避免无效请求消耗 DB 查询）。
    await this.requireCaptcha(input.captcha);
    const email = input.email?.trim().toLowerCase();
    if (!email) throw badRequest('请输入邮箱');
    const user = await this.prisma.user.findUnique({ where: { email } });
    // 邮箱不存在/已禁用：静默跳过，不抛错（防邮箱探测）。前端统一提示「链接已发送」。
    if (user && user.status === 'ACTIVE') {
      // 修复 H1/H3：reset token 内嵌签发时的 tokenVersion，resetPassword 校验时与库比对。
      // 这样既防重放（改密后 tokenVersion++，旧 reset token 校验失败），
      // 也覆盖降级场景（admin 改 status 或 platformRole 时已 tokenVersion++，旧 reset token 同步失效）。
      const token = this.issueResetToken(user.id, email, user.tokenVersion);
      const baseUrl = (process.env.PASSWORD_RESET_BASE_URL || '').replace(/\/+$/, '');
      // 重置链接：前端路由 ?reset_token=xxx（Auth.tsx 解析后弹「重置密码」对话框）。
      // baseUrl 未配时降级为只带 token 的相对路径（开发期 console.log 可见完整 token）。
      const link = baseUrl ? `${baseUrl}/?reset_token=${encodeURIComponent(token)}` : `/?reset_token=${encodeURIComponent(token)}`;
      await this.mail.sendPasswordReset(email, link);
    }
    return { ok: true, message: '若该邮箱已注册，重置链接已发送' };
  }

  /**
   * 重置密码（Top5 解法）：校验 reset token → 改密 → tokenVersion++（作废所有旧登录 token）。
   * tokenVersion 自增确保：密码被改后，攻击者即便持有旧的登录 JWT 也会在 JwtAuthGuard 校验时失效。
   */
  async resetPassword(input: { token: string; newPassword: string }) {
    if (!input.token) throw badRequest('重置链接无效');
    if (!input.newPassword || input.newPassword.length < 8) throw badRequest('新密码至少 8 位');
    // 校验 reset token：复用 JWT_SECRET，限定 scope=pwd_reset，TTL 15min（issueResetToken 内置）。
    const secret = process.env.JWT_SECRET;
    if (!secret) throw unauthorized('服务端未配置密钥');
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(input.token, secret as Secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    } catch {
      throw badRequest('重置链接已过期或无效');
    }
    if (payload.scope !== 'pwd_reset' || !payload.sub) throw badRequest('重置链接无效');

    const userId = String(payload.sub);
    // 修复 H1/H3：加载当前 tokenVersion 与 status，与 reset token 内嵌的 tokenVersion 比对。
    // - 重放防护：resetPassword 成功后 tokenVersion++，旧 reset token（内嵌旧 tokenVersion）校验失败。
    // - 降级覆盖：admin 改 status/platformRole 时已 tokenVersion++，旧 reset token 同步失效。
    const userRow = await this.prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true, status: true } });
    if (!userRow || userRow.status !== 'ACTIVE') throw badRequest('账号不可用，重置失败');
    const tokenVersionInPayload = Number(payload.tokenVersion);
    if (!Number.isFinite(tokenVersionInPayload) || tokenVersionInPayload !== userRow.tokenVersion) {
      throw badRequest('重置链接已失效，请重新申请');
    }
    const passwordHash = await bcrypt.hash(input.newPassword, 12);
    // 事务：改密 + tokenVersion++ 原子完成（两者必须一起生效，否则改密但旧 token 仍可用）。
    // tokenVersion 加入 where 条件作为乐观锁：并发重放时仅第一个命中，第二个 count=0 抛错。
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: userId, status: 'ACTIVE', tokenVersion: userRow.tokenVersion },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });
      if (updated.count === 0) throw badRequest('重置链接已失效，请重新申请');
      return tx.user.findUniqueOrThrow({ where: { id: userId } });
    });
    await this.prisma.auditLog.create({
      data: { actorUserId: user.id, action: 'auth.password.reset', targetType: 'User', targetId: user.id, metadata: { email: user.email } },
    });
    return { ok: true, message: '密码已重置，请使用新密码登录' };
  }

  /**
   * 验证邮箱（verify-email 端点）：校验 verify token → 标记 emailVerified = now。
   *
   * 安全设计（与 reset-password 一致）：
   *  - verify token 为独立 JWT（scope=email_verify，TTL 24h，复用 JWT_SECRET）。
   *  - 校验 payload.scope === 'email_verify' 且 sub 存在。
   *  - tokenVersion 比对：账号被禁用 / 降级后 tokenVersion 已自增，旧 verify token 同步失效（降级覆盖）。
   *  - 幂等：已验证用户重复调用直接返回成功（不报错，便于前端重试）。
   *  - 不阻断登录：首版 emailVerified 仅作标记，verify-email 是用户主动触发的补充验证。
   */
  async verifyEmail(input: { token: string }) {
    if (!input.token) throw badRequest('验证链接无效');
    const secret = process.env.JWT_SECRET;
    if (!secret) throw unauthorized('服务端未配置密钥');
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(input.token, secret as Secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    } catch {
      throw badRequest('验证链接已过期或无效');
    }
    if (payload.scope !== 'email_verify' || !payload.sub) throw badRequest('验证链接无效');

    const userId = String(payload.sub);
    const userRow = await this.prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true, status: true, emailVerified: true } });
    if (!userRow || userRow.status !== 'ACTIVE') throw badRequest('账号不可用，验证失败');
    // 幂等：已验证直接成功返回（不报错，前端重试友好）。
    if (userRow.emailVerified) return { ok: true, message: '邮箱已验证', alreadyVerified: true };
    const tokenVersionInPayload = Number(payload.tokenVersion);
    if (!Number.isFinite(tokenVersionInPayload) || tokenVersionInPayload !== userRow.tokenVersion) {
      throw badRequest('验证链接已失效，请重新申请');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerified: new Date() },
    });
    await this.prisma.auditLog.create({
      data: { actorUserId: userId, action: 'auth.email.verified', targetType: 'User', targetId: userId },
    });
    return { ok: true, message: '邮箱验证成功' };
  }

  /**
   * 重发验证邮件（resend-verification 端点）：登录态用户主动触发。
   * 幂等：已验证用户返回已验证提示（不发邮件，避免骚扰）。
   * 邮件发送失败不影响响应（降级 console.log 兜底，前端统一提示「验证邮件已发送」）。
   */
  async resendVerification(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, status: true, emailVerified: true, tokenVersion: true } });
    if (!user || user.status !== 'ACTIVE') throw unauthorized('账号不可用');
    if (user.emailVerified) return { ok: true, message: '邮箱已验证，无需重发', alreadyVerified: true };
    await this.sendVerificationEmail(userId, user.email).catch((error) => {
      console.error('[mail.resend_verification_failed]', { userId, email: user.email, error: (error as Error).message });
    });
    return { ok: true, message: '验证邮件已发送，请查收' };
  }

  private async sessionFor(userId: string, includeToken = true) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { memberships: { where: { status: 'ACTIVE' }, include: { team: true }, orderBy: { joinedAt: 'desc' } } },
    });
    // 修复 AUTH-01：/auth/me 与 /auth/refresh 共享此入口，必须校验 status，
    // 否则被禁用用户可凭旧 token 经 refresh 永久续命（login 已校验但 sessionFor 此前缺失）。
    if (!user || user.status !== 'ACTIVE') throw unauthorized();
    const application = await this.prisma.teamAdminApplication.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    const membership = user.memberships[0] || null;
    const onboarding: OnboardingState = this.resolveOnboarding(user.platformRole, membership?.role, application?.status);
    const payload = {
      token: includeToken ? this.issueToken(user.id, user.email, user.platformRole, user.tokenVersion) : undefined,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        platformRole: user.platformRole,
        status: user.status,
        tokenVersion: user.tokenVersion,
        // 邮箱验证状态：null=未验证（前端提示去验证），非 null=已验证时间。
        emailVerified: user.emailVerified,
      },
      team: membership ? { id: membership.team.id, name: membership.team.name, slug: membership.team.slug, role: membership.role } : null,
      application: application ? { id: application.id, status: application.status, teamName: application.teamName, reviewReason: application.reviewReason } : null,
      onboarding,
    };
    return payload;
  }

  private resolveOnboarding(platformRole: string, teamRole?: string, applicationStatus?: string): OnboardingState {
    if (platformRole === 'PLATFORM_ADMIN') return 'PLATFORM_ADMIN_WEB_ONLY';
    if (teamRole === 'TEAM_ADMIN') return 'TEAM_ADMIN_SPACE';
    if (teamRole === 'MEMBER') return 'TEAM_SPACE';
    if (applicationStatus === 'PENDING') return 'PENDING_APPROVAL';
    if (applicationStatus === 'REJECTED') return 'APPLICATION_REJECTED';
    return 'NEEDS_INVITATION';
  }

  private issueToken(userId: string, email: string, platformRole: string, tokenVersion: number) {
    const options: SignOptions = { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as SignOptions['expiresIn'] };
    // payload 携带 tokenVersion，JwtAuthGuard 校验时与库比对实现吊销（ADMIN-02/AUTH-01）。
    // 与 main.ts 启动断言 + security.ts 的 JwtAuthGuard 对齐：JWT_SECRET 缺失时直接抛错而非回退弱默认值
    // （XSEC-04 / AUTH-04）。生产环境由 main.ts fail-fast 兜底；开发环境 .env 必须配置合法密钥。
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET 未配置，无法签发 token');
    return jwt.sign(
      { sub: userId, email, platformRole, tokenVersion },
      secret as Secret,
      options,
    );
  }

  /**
   * 签发密码重置 token：独立于登录 token，scope=pwd_reset 标记用途，TTL 15min。
   * 复用 JWT_SECRET 签名（与登录 token 同密钥不同 scope，互不混淆）。
   *
   * 修复 H1/H3：token 内嵌签发时的 tokenVersion。resetPassword 改密时 tokenVersion++，
   * 使旧 reset token（携带旧 tokenVersion）校验失败，实现一次性语义：
   *  - 重放防护：链接泄漏后第二次提交，tokenVersion 已变，校验失败。
   *  - 降级覆盖：admin 改 status/platformRole 同步 tokenVersion++，旧 reset token 失效。
   */
  private issueResetToken(userId: string, email: string, tokenVersion: number) {
    const options: SignOptions = { expiresIn: '15m' };
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET 未配置，无法签发重置 token');
    return jwt.sign({ sub: userId, email, scope: 'pwd_reset', tokenVersion }, secret as Secret, options);
  }

  /**
   * 签发邮箱验证 token：独立于登录 token，scope=email_verify 标记用途，TTL 24h。
   * 复用 JWT_SECRET 签名（与登录 token 同密钥不同 scope，互不混淆）。
   *
   * tokenVersion 内嵌：账号被禁用 / 降级后 tokenVersion 自增，旧 verify token 校验失败（降级覆盖）。
   * 邮箱验证不涉及密码变更，无需一次性语义（用户可重复点击链接验证），故不在此自增 tokenVersion。
   */
  private issueVerifyToken(userId: string, email: string, tokenVersion: number) {
    const options: SignOptions = { expiresIn: '24h' };
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET 未配置，无法签发验证 token');
    return jwt.sign({ sub: userId, email, scope: 'email_verify', tokenVersion }, secret as Secret, options);
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }

  async ensureCurrentTeam(userId: string) {
    const membership = await this.prisma.teamMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { team: true, user: true },
      orderBy: { joinedAt: 'desc' },
    });
    if (!membership) throw forbidden('请先加入团队');
    // 修复 TEAM-03：SUSPENDED 团队的成员不应能继续消耗余额/生成邀请码/操作成员。
    // 此前所有 team.service 接口经此入口但都不校验 team.status，与 plugin.service.ts:17 已认可的语义对齐。
    if (membership.team.status !== 'ACTIVE') throw forbidden('团队当前不可用');
    return membership;
  }

  async ensureTeamAdmin(userId: string) {
    const membership = await this.ensureCurrentTeam(userId);
    if (membership.role !== 'TEAM_ADMIN') throw forbidden('仅团队管理员可操作');
    return membership;
  }

  async ensurePlatformAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.platformRole !== 'PLATFORM_ADMIN') throw forbidden('仅平台管理员可操作');
    return user;
  }

  async createTeamForApplication(applicationId: string, reviewerId: string) {
    await this.ensurePlatformAdmin(reviewerId);
    const application = await this.prisma.teamAdminApplication.findUnique({ where: { id: applicationId }, include: { user: true } });
    if (!application) throw badRequest('申请不存在');
    if (application.status !== 'PENDING') throw conflict('该申请已处理');
    const slug = `${slugify(application.teamName)}-${application.id.slice(0, 6)}`;
    return this.prisma.$transaction(async (tx) => {
      const team = await tx.team.create({ data: { name: application.teamName, slug } });
      await tx.teamMembership.create({ data: { teamId: team.id, userId: application.userId, role: 'TEAM_ADMIN' } });
      await tx.teamAdminApplication.update({
        where: { id: application.id },
        data: { status: 'APPROVED', reviewedById: reviewerId, reviewedAt: new Date() },
      });
      await tx.auditLog.create({ data: { actorUserId: reviewerId, action: 'team_admin_application.approved', targetType: 'TeamAdminApplication', targetId: application.id, metadata: { teamId: team.id } } });
      return team;
    });
  }
}