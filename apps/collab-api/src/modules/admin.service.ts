import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { NotificationService } from './notification.service';
import { type AdminApplicationListQuery } from './admin-applications';
import { AdminTeamsService } from './admin-teams.service';
import { AdminUsersService } from './admin-users.service';
import { AdminApplicationsService } from './admin-applications.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminAuditService } from './admin-audit.service';
import {
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
    @Inject(MailService) private readonly mail: MailService
  ) {
    // 团队管理簇委托给 AdminTeamsService（见 admin-teams.service.ts）。
    // 用户管理簇委托给 AdminUsersService（见 admin-users.service.ts）。
    // 构造函数参数保持不变，既有控制器与单测契约零改动。
    this.teams = new AdminTeamsService(this.prisma, this.auth);
    this.users = new AdminUsersService(this.prisma, this.auth, this.notifications, this.mail);
    this.applications = new AdminApplicationsService(this.prisma, this.auth, this.notifications);
    this.dashboard = new AdminDashboardService(this.prisma, this.auth);
    this.audit = new AdminAuditService(this.prisma, this.auth);
  }

  private readonly teams: AdminTeamsService;
  private readonly users: AdminUsersService;
  private readonly applications: AdminApplicationsService;
  private readonly dashboard: AdminDashboardService;
  private readonly audit: AdminAuditService;

  // === 看板/统计簇：委托给 AdminDashboardService（实现见 admin-dashboard.service.ts）===
  async adminDashboard(userId: string) {
    return this.dashboard.adminDashboard(userId);
  }

  async adminGenerationStats(userId: string) {
    return this.dashboard.adminGenerationStats(userId);
  }

  async adminFinanceStats(userId: string) {
    return this.dashboard.adminFinanceStats(userId);
  }

  // === 用户管理簇：委托给 AdminUsersService（实现见 admin-users.service.ts）===
  async adminUsers(userId: string, query: AdminUserListQuery = {}) {
    return this.users.adminUsers(userId, query);
  }

  async adminUserOptions(userId: string, query: { q?: string; limit?: number } = {}) {
    return this.users.adminUserOptions(userId, query);
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
    return this.users.adminCreateUser(actorId, input);
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
    return this.users.adminUpdateUser(actorId, id, input);
  }

  async adminDeleteUser(actorId: string, id: string) {
    return this.users.adminDeleteUser(actorId, id);
  }

  async adminUserDetail(actorId: string, id: string) {
    return this.users.adminUserDetail(actorId, id);
  }

  async adminUserLogins(actorId: string, id: string, query: AdminPageQuery = {}) {
    return this.users.adminUserLogins(actorId, id, query);
  }

  async adminUserTeams(actorId: string, id: string, query: AdminPageQuery = {}) {
    return this.users.adminUserTeams(actorId, id, query);
  }

  async adminUserWallet(actorId: string, id: string, query: AdminPageQuery = {}) {
    return this.users.adminUserWallet(actorId, id, query);
  }

  async adminResetUserPassword(actorId: string, id: string) {
    return this.users.adminResetUserPassword(actorId, id);
  }

  async adminUpdateUserPlatformRole(
    actorId: string,
    id: string,
    input: { platformRole: 'NONE' | 'PLATFORM_ADMIN' }
  ) {
    return this.users.adminUpdateUserPlatformRole(actorId, id, input);
  }

  async adminActivity(actorId: string, targetUserId: string, query: AdminPageQuery = {}) {
    return this.users.adminActivity(actorId, targetUserId, query);
  }

  // === 团队管理簇：委托给 AdminTeamsService（实现见 admin-teams.service.ts）===
  async adminTeams(userId: string, query: AdminTeamListQuery = {}) {
    return this.teams.adminTeams(userId, query);
  }

  async adminCreateTeam(
    actorId: string,
    input: { name: string; slug?: string; balanceCents?: number }
  ) {
    return this.teams.adminCreateTeam(actorId, input);
  }

  async adminUpdateTeam(
    actorId: string,
    id: string,
    input: { name?: string; status?: 'ACTIVE' | 'SUSPENDED'; defaultPoolId?: string | null }
  ) {
    return this.teams.adminUpdateTeam(actorId, id, input);
  }

  async adminDeleteTeam(actorId: string, id: string) {
    return this.teams.adminDeleteTeam(actorId, id);
  }

  async adminSetTeamAdmin(actorId: string, teamId: string, input: { userId: string }) {
    return this.teams.adminSetTeamAdmin(actorId, teamId, input);
  }

  async adminRevokeTeamAdmin(actorId: string, teamId: string, targetUserId: string) {
    return this.teams.adminRevokeTeamAdmin(actorId, teamId, targetUserId);
  }

  async adminAdjustBalance(
    actorId: string,
    teamId: string,
    input: { amountCents: number; direction: 'CREDIT' | 'DEBIT'; reason?: string }
  ) {
    return this.teams.adminAdjustBalance(actorId, teamId, input);
  }

  async adminTeamMembers(
    userId: string,
    teamId: string,
    query: AdminPageQuery & { q?: string } = {}
  ) {
    return this.teams.adminTeamMembers(userId, teamId, query);
  }

  async adminUpdateMemberRole(
    actorId: string,
    teamId: string,
    targetUserId: string,
    input: { role?: 'TEAM_ADMIN' | 'MEMBER'; roleId?: string }
  ) {
    return this.teams.adminUpdateMemberRole(actorId, teamId, targetUserId, input);
  }

  async adminUpdateTeamStatus(
    actorId: string,
    teamId: string,
    input: { status: 'ACTIVE' | 'SUSPENDED' }
  ) {
    return this.teams.adminUpdateTeamStatus(actorId, teamId, input);
  }

  async adminTeamDetail(userId: string, teamId: string) {
    return this.teams.adminTeamDetail(userId, teamId);
  }

  async adminTeamPlugins(userId: string, teamId: string, query: AdminPageQuery = {}) {
    return this.teams.adminTeamPlugins(userId, teamId, query);
  }

  async adminTeamPurchases(userId: string, teamId: string, query: AdminPageQuery = {}) {
    return this.teams.adminTeamPurchases(userId, teamId, query);
  }

  async adminTeamLedger(userId: string, teamId: string, query: AdminPageQuery = {}) {
    return this.teams.adminTeamLedger(userId, teamId, query);
  }

  // === 应用管理簇：委托给 AdminApplicationsService（实现见 admin-applications.service.ts）===
  async adminApplications(userId: string, query: AdminApplicationListQuery = {}) {
    return this.applications.adminApplications(userId, query);
  }

  async adminApplication(userId: string, id: string) {
    return this.applications.adminApplication(userId, id);
  }

  async approveApplication(actorId: string, id: string) {
    return this.applications.approveApplication(actorId, id);
  }

  async rejectApplication(actorId: string, id: string, reason?: string) {
    return this.applications.rejectApplication(actorId, id, reason);
  }

  // === 审计簇：委托给 AdminAuditService（实现见 admin-audit.service.ts）===
  async auditLogs(userId: string, filters: AdminAuditListQuery = {}) {
    return this.audit.auditLogs(userId, filters);
  }

  async auditLog(userId: string, id: string) {
    return this.audit.auditLog(userId, id);
  }

  async auditCategories(userId: string) {
    return this.audit.auditCategories(userId);
  }
}
