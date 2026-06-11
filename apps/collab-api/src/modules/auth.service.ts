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
    if (!email || !email.includes('@')) throw badRequest('请输入有效邮箱');
    if (!input.password || input.password.length < 8) throw badRequest('密码至少 8 位');
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw conflict('该邮箱已注册');
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: input.displayName?.trim() || email,
      },
    });
    if (input.wantsTeamAdmin) {
      await this.prisma.teamAdminApplication.create({
        data: {
          userId: user.id,
          teamName: input.teamName?.trim() || `${user.displayName} 的团队`,
          reason: input.reason?.trim() || '',
        },
      });
      await this.audit(user.id, 'team_admin_application.created', 'User', user.id, { email });
    }
    return this.sessionFor(user.id);
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
    if (!user) throw unauthorized();
    const application = await this.prisma.teamAdminApplication.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    const membership = user.memberships[0] || null;
    const onboarding: OnboardingState = this.resolveOnboarding(user.platformRole, membership?.role, application?.status);
    const payload = {
      token: includeToken ? this.issueToken(user.id, user.email, user.platformRole) : undefined,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        platformRole: user.platformRole,
        status: user.status,
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

  private issueToken(userId: string, email: string, platformRole: string) {
    const options: SignOptions = { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as SignOptions['expiresIn'] };
    return jwt.sign(
      { sub: userId, email, platformRole },
      (process.env.JWT_SECRET || 'dev-collab-change-me') as Secret,
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