import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { AdminService } from './admin.service';
import { LlmService } from './llm.service';
import {
  AdminAdjustBalanceDto,
  AdminAuditLogsQueryDto,
  AdminCreatePluginDto,
  AdminCreateTeamDto,
  AdminCreateUserDto,
  AdminPlatformRoleDto,
  AdminRejectApplicationDto,
  AdminRejectPluginDto,
  AdminSetTeamAdminDto,
  AdminUpdateMemberRoleDto,
  AdminUpdatePluginDto,
  AdminUpdateTeamDto,
  AdminUpdateTeamStatusDto,
  AdminUpdateUserDto,
} from './dto/admin.dto';
import { ProviderCreateDto, ProviderUpdateDto } from './dto/llm.dto';
import { ReleaseAssetCreateDto, ReleaseCreateDto, ReleaseUpdateDto } from './dto/release.dto';
import { RevealSecretDto, UpdateSettingsDto, TestEmailDto } from './dto/settings.dto';
import { ReleaseService } from './release.service';
import { SettingsService } from './settings.service';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(ReleaseService) private readonly releases: ReleaseService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: '管理端指标' })
  dashboard(@Req() req: Request) {
    return this.admin.adminDashboard(requireUser(req).id);
  }

  @Get('stats/generation')
  @ApiOperation({ summary: 'AI 生成质量看板（调用次数/成功率）' })
  generationStats(@Req() req: Request) {
    return this.admin.adminGenerationStats(requireUser(req).id);
  }

  @Get('stats/finance')
  @ApiOperation({ summary: '财务概览看板（GMV/付费用户/热销插件）' })
  financeStats(@Req() req: Request) {
    return this.admin.adminFinanceStats(requireUser(req).id);
  }

  @Get('users')
  @ApiOperation({ summary: '用户列表' })
  users(@Req() req: Request) {
    return this.admin.adminUsers(requireUser(req).id);
  }

  @Post('users')
  @ApiOperation({ summary: '创建用户' })
  createUser(@Req() req: Request, @Body() body: AdminCreateUserDto) {
    return this.admin.adminCreateUser(requireUser(req).id, body);
  }

  @Patch('users/:id')
  @ApiOperation({ summary: '更新用户' })
  updateUser(@Req() req: Request, @Param('id') id: string, @Body() body: AdminUpdateUserDto) {
    return this.admin.adminUpdateUser(requireUser(req).id, id, body);
  }

  @Delete('users/:id')
  @ApiOperation({ summary: '禁用用户' })
  deleteUser(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminDeleteUser(requireUser(req).id, id);
  }

  @Get('users/:id/detail')
  @ApiOperation({ summary: '用户详情（登录历史 + 钱包 + 团队 memberships + 钱包流水）' })
  userDetail(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminUserDetail(requireUser(req).id, id);
  }

  @Post('users/:id/reset-password')
  @ApiOperation({ summary: '管理员强制重置用户密码（生成临时密码返给 admin）' })
  resetUserPassword(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminResetUserPassword(requireUser(req).id, id);
  }

  @Patch('users/:id/platform-role')
  @ApiOperation({ summary: '调整用户平台角色（NONE↔PLATFORM_ADMIN，禁止自改自身）' })
  updateUserPlatformRole(@Req() req: Request, @Param('id') id: string, @Body() body: AdminPlatformRoleDto) {
    return this.admin.adminUpdateUserPlatformRole(requireUser(req).id, id, body);
  }

  @Get('teams')
  @ApiOperation({ summary: '团队列表' })
  teams(@Req() req: Request) {
    return this.admin.adminTeams(requireUser(req).id);
  }

  @Post('teams')
  @ApiOperation({ summary: '创建团队' })
  createTeam(@Req() req: Request, @Body() body: AdminCreateTeamDto) {
    return this.admin.adminCreateTeam(requireUser(req).id, body);
  }

  @Patch('teams/:id')
  @ApiOperation({ summary: '更新团队' })
  updateTeam(@Req() req: Request, @Param('id') id: string, @Body() body: AdminUpdateTeamDto) {
    return this.admin.adminUpdateTeam(requireUser(req).id, id, body);
  }

  @Delete('teams/:id')
  @ApiOperation({ summary: '停用团队' })
  deleteTeam(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminDeleteTeam(requireUser(req).id, id);
  }

  @Post('teams/:id/admins')
  @ApiOperation({ summary: '指定团队管理员' })
  setTeamAdmin(@Req() req: Request, @Param('id') id: string, @Body() body: AdminSetTeamAdminDto) {
    return this.admin.adminSetTeamAdmin(requireUser(req).id, id, body);
  }

  @Delete('teams/:teamId/admins/:userId')
  @ApiOperation({ summary: '撤销团队管理员' })
  revokeTeamAdmin(@Req() req: Request, @Param('teamId') teamId: string, @Param('userId') userId: string) {
    return this.admin.adminRevokeTeamAdmin(requireUser(req).id, teamId, userId);
  }

  @Post('teams/:teamId/balance-adjustments')
  @ApiOperation({ summary: '调整团队共享余额' })
  adjustBalance(@Req() req: Request, @Param('teamId') teamId: string, @Body() body: AdminAdjustBalanceDto) {
    return this.admin.adminAdjustBalance(requireUser(req).id, teamId, body);
  }

  @Get('teams/:id/members')
  @ApiOperation({ summary: '团队成员列表（含 role/status/joinedAt）' })
  teamMembers(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminTeamMembers(requireUser(req).id, id);
  }

  @Patch('teams/:id/members/:userId/role')
  @ApiOperation({ summary: '调整团队成员角色（TEAM_ADMIN↔MEMBER）' })
  updateMemberRole(@Req() req: Request, @Param('id') id: string, @Param('userId') userId: string, @Body() body: AdminUpdateMemberRoleDto) {
    return this.admin.adminUpdateMemberRole(requireUser(req).id, id, userId, body);
  }

  @Patch('teams/:id/status')
  @ApiOperation({ summary: '团队启用/停用（ACTIVE/SUSPENDED）' })
  updateTeamStatus(@Req() req: Request, @Param('id') id: string, @Body() body: AdminUpdateTeamStatusDto) {
    return this.admin.adminUpdateTeamStatus(requireUser(req).id, id, body);
  }

  @Get('teams/:id/detail')
  @ApiOperation({ summary: '团队详情（成员数 + 插件数 + 购买记录 + 余额流水摘要）' })
  teamDetail(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminTeamDetail(requireUser(req).id, id);
  }

  @Get('plugins')
  @ApiOperation({ summary: '平台插件列表' })
  plugins(@Req() req: Request) {
    return this.admin.adminPlugins(requireUser(req).id);
  }

  @Get('plugins/review-pending')
  @ApiOperation({ summary: '待审核市场插件列表' })
  reviewPendingPlugins(@Req() req: Request) {
    return this.admin.adminPluginReviewPending(requireUser(req).id);
  }

  @Post('plugins')
  @ApiOperation({ summary: '拒绝管理端新增平台插件' })
  createPlugin(@Req() req: Request, @Body() body: AdminCreatePluginDto) {
    void body;
    return this.admin.adminCreatePlugin(requireUser(req).id);
  }

  @Post('plugins/:id/approve')
  @ApiOperation({ summary: '审核通过市场插件' })
  approvePlugin(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminApprovePlugin(requireUser(req).id, id);
  }

  @Post('plugins/:id/reject')
  @ApiOperation({ summary: '驳回市场插件' })
  rejectPlugin(@Req() req: Request, @Param('id') id: string, @Body() body: AdminRejectPluginDto) {
    return this.admin.adminRejectPlugin(requireUser(req).id, id, body.reason);
  }

  @Patch('plugins/:id')
  @ApiOperation({ summary: '更新平台插件（名称/描述/版本/定价/可见性/状态）' })
  updatePlugin(@Req() req: Request, @Param('id') id: string, @Body() body: AdminUpdatePluginDto) {
    return this.admin.adminUpdatePlugin(requireUser(req).id, id, body);
  }

  @Post('plugins/:id/delist')
  @ApiOperation({ summary: '下架市场插件（marketplace=false + reviewStatus=DRAFT + 通知作者）' })
  delistPlugin(@Req() req: Request, @Param('id') id: string, @Body() body: AdminRejectPluginDto) {
    return this.admin.adminDelistPlugin(requireUser(req).id, id, body.reason);
  }

  @Get('plugins/:id/audit-history')
  @ApiOperation({ summary: '插件审核历史（PluginReview 时间线）' })
  pluginAuditHistory(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminPluginAuditHistory(requireUser(req).id, id);
  }

  @Get('team-admin-applications')
  @ApiOperation({ summary: '团队管理员申请列表' })
  applications(@Req() req: Request) {
    return this.admin.adminApplications(requireUser(req).id);
  }

  @Post('team-admin-applications/:id/approve')
  @ApiOperation({ summary: '审批通过团队管理员申请' })
  approve(@Req() req: Request, @Param('id') id: string) {
    return this.admin.approveApplication(requireUser(req).id, id);
  }

  @Post('team-admin-applications/:id/reject')
  @ApiOperation({ summary: '驳回团队管理员申请' })
  reject(@Req() req: Request, @Param('id') id: string, @Body() body: AdminRejectApplicationDto) {
    return this.admin.rejectApplication(requireUser(req).id, id, body.reason);
  }

  @Get('audit-logs')
  @ApiOperation({ summary: '审计日志（支持分类筛选 + 关键词搜索 + 操作者/对象过滤）' })
  auditLogs(@Req() req: Request, @Query() query: AdminAuditLogsQueryDto) {
    return this.admin.auditLogs(requireUser(req).id, query);
  }

  @Get('audit-categories')
  @ApiOperation({ summary: '审计分类元数据（key + 中文 + 说明，供前端筛选下拉）' })
  auditCategories(@Req() req: Request) {
    return this.admin.auditCategories(requireUser(req).id);
  }

  @Get('admins/:id/activity')
  @ApiOperation({ summary: '管理员操作记录（actorUserId 维度的审计日志）' })
  adminActivity(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminActivity(requireUser(req).id, id);
  }

  // === LLM provider 目录（平台 Admin 维护，ensurePlatformAdmin 在 LlmService 内） ===

  @Get('llm-providers')
  @ApiOperation({ summary: 'provider 列表（含 isActive + 全字段）' })
  listLlmProviders(@Req() req: Request) {
    return this.llm.adminListProviders(requireUser(req).id);
  }

  @Post('llm-providers')
  @ApiOperation({ summary: '新建 provider（isActive 通过 activate 端点设）' })
  createLlmProvider(@Req() req: Request, @Body() body: ProviderCreateDto) {
    return this.llm.adminCreateProvider(requireUser(req).id, body);
  }

  @Patch('llm-providers/:id')
  @ApiOperation({ summary: '更新 provider（全可选字段，isActive 不在此改）' })
  updateLlmProvider(@Req() req: Request, @Param('id') id: string, @Body() body: ProviderUpdateDto) {
    return this.llm.adminUpdateProvider(requireUser(req).id, id, body);
  }

  @Delete('llm-providers/:id')
  @ApiOperation({ summary: '删除 provider（active 的拒绝删）' })
  deleteLlmProvider(@Req() req: Request, @Param('id') id: string) {
    return this.llm.adminDeleteProvider(requireUser(req).id, id);
  }

  @Patch('llm-providers/:id/activate')
  @ApiOperation({ summary: '设为当前启用（事务维护唯一 active）' })
  activateLlmProvider(@Req() req: Request, @Param('id') id: string) {
    return this.llm.adminActivateProvider(requireUser(req).id, id);
  }

  // === 应用版本发布（平台 Admin 维护，ensurePlatformAdmin 在 ReleaseService 内） ===

  @Post('releases')
  @ApiOperation({ summary: '创建版本（DRAFT，需后续 publish）' })
  createRelease(@Req() req: Request, @Body() body: ReleaseCreateDto) {
    return this.releases.create(requireUser(req).id, body);
  }

  @Patch('releases/:id')
  @ApiOperation({ summary: '更新版本标题/说明' })
  updateRelease(@Req() req: Request, @Param('id') id: string, @Body() body: ReleaseUpdateDto) {
    return this.releases.update(requireUser(req).id, id, body);
  }

  @Post('releases/:id/publish')
  @ApiOperation({ summary: '发布版本（标记 isLatest，事务维护同 channel 唯一）' })
  publishRelease(@Req() req: Request, @Param('id') id: string) {
    return this.releases.publish(requireUser(req).id, id);
  }

  @Post('releases/:id/archive')
  @ApiOperation({ summary: '归档版本（status=ARCHIVED，取消 latest）' })
  archiveRelease(@Req() req: Request, @Param('id') id: string) {
    return this.releases.archive(requireUser(req).id, id);
  }

  @Post('releases/:id/assets')
  @ApiOperation({ summary: '登记版本产物（平台/架构/下载链接）' })
  addReleaseAsset(@Req() req: Request, @Param('id') id: string, @Body() body: ReleaseAssetCreateDto) {
    return this.releases.addAsset(requireUser(req).id, id, body);
  }

  @Delete('releases/:id/assets/:assetId')
  @ApiOperation({ summary: '删除版本产物' })
  deleteReleaseAsset(@Req() req: Request, @Param('id') id: string, @Param('assetId') assetId: string) {
    return this.releases.deleteAsset(requireUser(req).id, id, assetId);
  }

  // === 平台设置（ensurePlatformAdmin 在 SettingsService 内） ===

  @Get('settings')
  @ApiOperation({ summary: '平台设置列表（全 key/value + description）' })
  listSettings(@Req() req: Request) {
    return this.settings.getSettings(requireUser(req).id);
  }

  @Patch('settings')
  @ApiOperation({ summary: '批量更新平台设置（upsert + 审计）' })
  updateSettings(@Req() req: Request, @Body() body: UpdateSettingsDto) {
    return this.settings.updateSettings(requireUser(req).id, body);
  }

  @Get('settings/smtp')
  @ApiOperation({ summary: '当前生效的 SMTP 配置（PlatformSetting 优先，.env fallback；密码脱敏）' })
  smtpSettings(@Req() req: Request) {
    return this.settings.getSmtpSettings(requireUser(req).id);
  }

  @Post('settings/test-email')
  @ApiOperation({ summary: '发送测试邮件验证 SMTP 配置（返成功/失败 + 错误信息）' })
  testEmail(@Req() req: Request, @Body() body: TestEmailDto) {
    return this.settings.testEmail(requireUser(req).id, body.to);
  }

  @Get('settings/geetest')
  @ApiOperation({ summary: '当前极验配置（captchaId/scenes 明文，captchaKey 脱敏）' })
  geetestSettings(@Req() req: Request) {
    return this.settings.getGeetestSettings(requireUser(req).id);
  }

  @Post('settings/test-captcha')
  @ApiOperation({ summary: '测试极验配置是否可用（探测接口连通性，返成功/失败 + 错误信息）' })
  testCaptcha(@Req() req: Request) {
    return this.settings.testCaptcha(requireUser(req).id);
  }

  @Get('settings/gitee')
  @ApiOperation({ summary: '当前 Gitee 更新日志源配置（owner/repo 明文，accessToken 脱敏）' })
  giteeSettings(@Req() req: Request) {
    return this.settings.getGiteeSettings(requireUser(req).id);
  }

  @Post('settings/test-gitee')
  @ApiOperation({ summary: '测试 Gitee 配置是否可用（探测 releases 端点连通性，返成功/失败 + 错误信息）' })
  testGitee(@Req() req: Request) {
    return this.settings.testGitee(requireUser(req).id);
  }

  @Post('settings/reveal-secret')
  @ApiOperation({ summary: '查看敏感配置明文（SMTP 密码 / 极验私钥，需二次密码确认 + 审计）' })
  revealSecret(@Req() req: Request, @Body() body: RevealSecretDto) {
    return this.settings.revealSecret(requireUser(req).id, body);
  }
}