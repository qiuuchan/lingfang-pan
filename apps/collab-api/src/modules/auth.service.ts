import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt, { type Secret, type SignOptions } from 'jsonwebtoken';
import { PrismaService } from '../prisma.service';
import { badRequest, conflict, forbidden, slugify, unauthorized } from '../common';

export type OnboardingState =
  | 'NEEDS_INVITATION'
  | 'PENDING_APPROVAL'
  | 'APPLICATION_REJECTED'
  | 'TEAM_SPACE'
  | 'TEAM_ADMIN_SPACE'
  | 'PLATFORM_ADMIN_WEB_ONLY';

@Injectable()
export class AuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async register(input: { email: string; password: string; displayName?: string; wantsTeamAdmin?: boolean; teamName?: string; reason?: string }) {
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
    // 事务提交后再读库生成 session（sessionFor 用主 prisma，需读到已提交数据）。
    return this.sessionFor(userId);
  }

  async login(input: { email: string; password: string }) {
    const email = input.email?.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') throw unauthorized('邮箱或密码错误');
    const ok = await bcrypt.compare(input.password || '', user.passwordHash);
    if (!ok) throw unauthorized('邮箱或密码错误');
    return this.sessionFor(user.id);
  }

  async me(userId: string) {
    return this.sessionFor(userId, false);
  }

  async refresh(userId: string) {
    return this.sessionFor(userId);
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