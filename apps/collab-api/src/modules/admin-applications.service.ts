import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { badRequest, conflict, notFound, slugify } from '../common';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';
import {
  adminApplicationDetail,
  adminApplicationDetailSelect,
  type AdminApplicationListQuery,
  adminApplicationSummary,
  adminApplicationSummarySelect,
  applicationTeamSystemRoles,
  buildAdminApplicationListQuery,
} from './admin-applications';

@Injectable()
export class AdminApplicationsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}
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
      await tx.user.update({
        where: { id: application.userId },
        data: { teamContextVersion: { increment: 1 } },
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
}
