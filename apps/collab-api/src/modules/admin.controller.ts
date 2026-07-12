import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { clientUpgradeRequired, requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { AdminService } from './admin.service';
import {
  AdminAdjustBalanceDto,
  AdminAuditLogsQueryDto,
  AdminCreateTeamDto,
  AdminCreateUserDto,
  AdminPlatformRoleDto,
  AdminRejectApplicationDto,
  AdminSetTeamAdminDto,
  AdminUpdateMemberRoleDto,
  AdminUpdateTeamDto,
  AdminUpdateTeamStatusDto,
  AdminUpdateUserDto,
} from './dto/admin.dto';
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
    @Inject(ReleaseService) private readonly releases: ReleaseService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  @RequirePermission('platform.dashboard.view')
  @Get('dashboard')
  @ApiOperation({ summary: '管理端指标' })
  dashboard(@Req() req: Request) {
    return this.admin.adminDashboard(requireUser(req).id);
  }

  @RequirePermission('platform.dashboard.view')
  @Get('stats/generation')
  @ApiOperation({ summary: 'AI 生成质量看板（调用次数/成功率）' })
  generationStats(@Req() req: Request) {
    return this.admin.adminGenerationStats(requireUser(req).id);
  }

  @RequirePermission('platform.dashboard.view')
  @Get('stats/finance')
  @ApiOperation({ summary: '财务概览看板（GMV/付费用户/热销插件）' })
  financeStats(@Req() req: Request) {
    return this.admin.adminFinanceStats(requireUser(req).id);
  }

  @RequirePermission('platform.user.list')
  @Get('users')
  @ApiOperation({ summary: '用户列表' })
  users(@Req() req: Request) {
    return this.admin.adminUsers(requireUser(req).id);
  }

  @RequirePermission('platform.user.create')
  @Post('users')
  @ApiOperation({ summary: '创建用户' })
  createUser(@Req() req: Request, @Body() body: AdminCreateUserDto) {
    return this.admin.adminCreateUser(requireUser(req).id, body);
  }

  @RequirePermission('platform.user.update_profile')
  @Patch('users/:id')
  @ApiOperation({ summary: '更新用户' })
  updateUser(@Req() req: Request, @Param('id') id: string, @Body() body: AdminUpdateUserDto) {
    return this.admin.adminUpdateUser(requireUser(req).id, id, body);
  }

  @RequirePermission('platform.user.disable')
  @Delete('users/:id')
  @ApiOperation({ summary: '禁用用户' })
  deleteUser(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminDeleteUser(requireUser(req).id, id);
  }

  @RequirePermission('platform.user.list')
  @Get('users/:id/detail')
  @ApiOperation({ summary: '用户详情（登录历史 + 钱包 + 团队 memberships + 钱包流水）' })
  userDetail(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminUserDetail(requireUser(req).id, id);
  }

  @RequirePermission('platform.user.reset_password')
  @Post('users/:id/reset-password')
  @ApiOperation({ summary: '管理员强制重置用户密码（生成临时密码返给 admin）' })
  resetUserPassword(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminResetUserPassword(requireUser(req).id, id);
  }

  @RequirePermission('platform.user.role.assign')
  @Patch('users/:id/platform-role')
  @ApiOperation({ summary: '调整用户平台角色（NONE↔PLATFORM_ADMIN，禁止自改自身）' })
  updateUserPlatformRole(@Req() req: Request, @Param('id') id: string, @Body() body: AdminPlatformRoleDto) {
    return this.admin.adminUpdateUserPlatformRole(requireUser(req).id, id, body);
  }

  @RequirePermission('platform.team.list')
  @Get('teams')
  @ApiOperation({ summary: '团队列表' })
  teams(@Req() req: Request) {
    return this.admin.adminTeams(requireUser(req).id);
  }

  @RequirePermission('platform.team.create')
  @Post('teams')
  @ApiOperation({ summary: '创建团队' })
  createTeam(@Req() req: Request, @Body() body: AdminCreateTeamDto) {
    return this.admin.adminCreateTeam(requireUser(req).id, body);
  }

  @RequirePermission('platform.team.update')
  @Patch('teams/:id')
  @ApiOperation({ summary: '更新团队' })
  updateTeam(@Req() req: Request, @Param('id') id: string, @Body() body: AdminUpdateTeamDto) {
    return this.admin.adminUpdateTeam(requireUser(req).id, id, body);
  }

  @RequirePermission('platform.team.suspend')
  @Delete('teams/:id')
  @ApiOperation({ summary: '停用团队' })
  deleteTeam(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminDeleteTeam(requireUser(req).id, id);
  }

  @RequirePermission('platform.team.set_admin')
  @Post('teams/:id/admins')
  @ApiOperation({ summary: '指定团队管理员' })
  setTeamAdmin(@Req() req: Request, @Param('id') id: string, @Body() body: AdminSetTeamAdminDto) {
    return this.admin.adminSetTeamAdmin(requireUser(req).id, id, body);
  }

  @RequirePermission('platform.team.set_admin')
  @Delete('teams/:teamId/admins/:userId')
  @ApiOperation({ summary: '撤销团队管理员' })
  revokeTeamAdmin(@Req() req: Request, @Param('teamId') teamId: string, @Param('userId') userId: string) {
    return this.admin.adminRevokeTeamAdmin(requireUser(req).id, teamId, userId);
  }

  @RequirePermission('platform.team.adjust_balance')
  @Post('teams/:teamId/balance-adjustments')
  @ApiOperation({ summary: '调整团队共享余额' })
  adjustBalance(@Req() req: Request, @Param('teamId') teamId: string, @Body() body: AdminAdjustBalanceDto) {
    return this.admin.adminAdjustBalance(requireUser(req).id, teamId, body);
  }

  @RequirePermission('platform.team.list')
  @Get('teams/:id/members')
  @ApiOperation({ summary: '团队成员列表（含 role/status/joinedAt）' })
  teamMembers(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminTeamMembers(requireUser(req).id, id);
  }

  @RequirePermission('platform.team.member.role')
  @Patch('teams/:id/members/:userId/role')
  @ApiOperation({ summary: '调整团队成员角色（TEAM_ADMIN↔MEMBER）' })
  updateMemberRole(@Req() req: Request, @Param('id') id: string, @Param('userId') userId: string, @Body() body: AdminUpdateMemberRoleDto) {
    return this.admin.adminUpdateMemberRole(requireUser(req).id, id, userId, body);
  }

  @RequirePermission('platform.team.suspend')
  @Patch('teams/:id/status')
  @ApiOperation({ summary: '团队启用/停用（ACTIVE/SUSPENDED）' })
  updateTeamStatus(@Req() req: Request, @Param('id') id: string, @Body() body: AdminUpdateTeamStatusDto) {
    return this.admin.adminUpdateTeamStatus(requireUser(req).id, id, body);
  }

  @RequirePermission('platform.team.list')
  @Get('teams/:id/detail')
  @ApiOperation({ summary: '团队详情（成员数 + 插件数 + 购买记录 + 余额流水摘要）' })
  teamDetail(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminTeamDetail(requireUser(req).id, id);
  }

  @RequirePermission('platform.plugin.list_all')
  @Get('plugins')
  @ApiOperation({ summary: '平台插件列表' })
  plugins() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('platform.plugin.review')
  @Get('plugins/review-pending')
  @ApiOperation({ summary: '待审核市场插件列表' })
  reviewPendingPlugins() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('platform.plugin.edit')
  @Post('plugins')
  @ApiOperation({ summary: '拒绝管理端新增平台插件' })
  createPlugin() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('platform.plugin.review')
  @Post('plugins/:id/approve')
  @ApiOperation({ summary: '审核通过市场插件' })
  approvePlugin() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('platform.plugin.review')
  @Post('plugins/:id/reject')
  @ApiOperation({ summary: '驳回市场插件' })
  rejectPlugin() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('platform.plugin.edit')
  @Patch('plugins/:id')
  @ApiOperation({ summary: '更新平台插件（名称/描述/版本/定价/可见性/状态）' })
  updatePlugin() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('platform.plugin.review')
  @Post('plugins/:id/delist')
  @ApiOperation({ summary: '下架市场插件（marketplace=false + reviewStatus=DRAFT + 通知作者）' })
  delistPlugin() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('platform.plugin.delete')
  @Delete('plugins/:id')
  @ApiOperation({ summary: '物理删除插件（admin，任意，含已上架，级联清安装/购买记录）' })
  deletePlugin() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('platform.plugin.list_all')
  @Get('plugins/:id/audit-history')
  @ApiOperation({ summary: '插件审核历史（PluginReview 时间线）' })
  pluginAuditHistory() {
    throw clientUpgradeRequired();
  }

  @RequirePermission('platform.application.review')
  @Get('team-admin-applications')
  @ApiOperation({ summary: '团队管理员申请列表' })
  applications(@Req() req: Request) {
    return this.admin.adminApplications(requireUser(req).id);
  }

  @RequirePermission('platform.application.review')
  @Post('team-admin-applications/:id/approve')
  @ApiOperation({ summary: '审批通过团队管理员申请' })
  approve(@Req() req: Request, @Param('id') id: string) {
    return this.admin.approveApplication(requireUser(req).id, id);
  }

  @RequirePermission('platform.application.review')
  @Post('team-admin-applications/:id/reject')
  @ApiOperation({ summary: '驳回团队管理员申请' })
  reject(@Req() req: Request, @Param('id') id: string, @Body() body: AdminRejectApplicationDto) {
    return this.admin.rejectApplication(requireUser(req).id, id, body.reason);
  }

  @RequirePermission('platform.audit.view')
  @Get('audit-logs')
  @ApiOperation({ summary: '审计日志（支持分类筛选 + 关键词搜索 + 操作者/对象过滤）' })
  auditLogs(@Req() req: Request, @Query() query: AdminAuditLogsQueryDto) {
    return this.admin.auditLogs(requireUser(req).id, query);
  }

  @RequirePermission('platform.audit.view')
  @Get('audit-categories')
  @ApiOperation({ summary: '审计分类元数据（key + 中文 + 说明，供前端筛选下拉）' })
  auditCategories(@Req() req: Request) {
    return this.admin.auditCategories(requireUser(req).id);
  }

  @RequirePermission('platform.audit.view')
  @Get('admins/:id/activity')
  @ApiOperation({ summary: '管理员操作记录（actorUserId 维度的审计日志）' })
  adminActivity(@Req() req: Request, @Param('id') id: string) {
    return this.admin.adminActivity(requireUser(req).id, id);
  }

  // 旧 LLM provider 目录（/admin/llm-providers）已随 BYOK 移除：渠道管理迁移至
  // /api/admin/billing/channels（见 BillingController），旧 LlmService/LlmGateway 删除。

  // === 应用版本发布（平台 Admin 维护，ensurePlatformAdmin 在 ReleaseService 内） ===

  @RequirePermission('platform.release.manage')
  @Get('releases')
  @ApiOperation({ summary: '版本列表（含 DRAFT/PUBLISHED/ARCHIVED 全部状态，Admin）' })
  listReleases(@Req() req: Request, @Query('channel') channel?: 'STABLE' | 'BETA') {
    return this.releases.listAdmin(requireUser(req).id, channel);
  }

  @RequirePermission('platform.release.manage')
  @Post('releases')
  @ApiOperation({ summary: '创建版本（DRAFT，需后续 publish）' })
  createRelease(@Req() req: Request, @Body() body: ReleaseCreateDto) {
    return this.releases.create(requireUser(req).id, body);
  }

  @RequirePermission('platform.release.manage')
  @Patch('releases/:id')
  @ApiOperation({ summary: '更新版本标题/说明' })
  updateRelease(@Req() req: Request, @Param('id') id: string, @Body() body: ReleaseUpdateDto) {
    return this.releases.update(requireUser(req).id, id, body);
  }

  @RequirePermission('platform.release.manage')
  @Post('releases/:id/publish')
  @ApiOperation({ summary: '发布版本（标记 isLatest，事务维护同 channel 唯一）' })
  publishRelease(@Req() req: Request, @Param('id') id: string) {
    return this.releases.publish(requireUser(req).id, id);
  }

  @RequirePermission('platform.release.manage')
  @Post('releases/:id/archive')
  @ApiOperation({ summary: '归档版本（status=ARCHIVED，取消 latest）' })
  archiveRelease(@Req() req: Request, @Param('id') id: string) {
    return this.releases.archive(requireUser(req).id, id);
  }

  @RequirePermission('platform.release.manage')
  @Delete('releases/:id')
  @ApiOperation({ summary: '删除版本（物理删，级联删 assets）' })
  deleteRelease(@Req() req: Request, @Param('id') id: string) {
    return this.releases.deleteRelease(requireUser(req).id, id);
  }

  @RequirePermission('platform.release.manage')
  @Post('releases/:id/assets')
  @ApiOperation({ summary: '登记版本产物（平台/架构/下载链接）' })
  addReleaseAsset(@Req() req: Request, @Param('id') id: string, @Body() body: ReleaseAssetCreateDto) {
    return this.releases.addAsset(requireUser(req).id, id, body);
  }

  @RequirePermission('platform.release.manage')
  @Post('releases/:id/assets/upload')
  @ApiOperation({ summary: '上传安装包文件（自动创建 asset，存 downloads/ 目录，上传时自动计算 SHA-256）' })
  @UseInterceptors(FileFieldsInterceptor(
    [{ name: 'file', maxCount: 1 }],
    { limits: { fileSize: 500 * 1024 * 1024 } },
  ))
  uploadReleaseAsset(
    @Req() req: Request,
    @Param('id') id: string,
    @UploadedFiles() files: { file?: Array<{ originalname: string; buffer?: Buffer; path?: string; size?: number }> },
    @Body() body: { platform?: string; arch?: string },
  ) {
    const file = files?.file?.[0];
    return this.releases.uploadAsset(requireUser(req).id, id, file, body.platform, body.arch);
  }

  @RequirePermission('platform.release.manage')
  @Delete('releases/:id/assets/:assetId')
  @ApiOperation({ summary: '删除版本产物' })
  deleteReleaseAsset(@Req() req: Request, @Param('id') id: string, @Param('assetId') assetId: string) {
    return this.releases.deleteAsset(requireUser(req).id, id, assetId);
  }

  // === 平台设置（ensurePlatformAdmin 在 SettingsService 内） ===

  @RequirePermission('platform.setting.manage')
  @Get('settings')
  @ApiOperation({ summary: '平台设置列表（全 key/value + description）' })
  listSettings(@Req() req: Request) {
    return this.settings.getSettings(requireUser(req).id);
  }

  @RequirePermission('platform.setting.manage')
  @Patch('settings')
  @ApiOperation({ summary: '批量更新平台设置（upsert + 审计）' })
  updateSettings(@Req() req: Request, @Body() body: UpdateSettingsDto) {
    return this.settings.updateSettings(requireUser(req).id, body);
  }

  @RequirePermission('platform.setting.manage')
  @Get('settings/smtp')
  @ApiOperation({ summary: '当前生效的 SMTP 配置（PlatformSetting 优先，.env fallback；密码脱敏）' })
  smtpSettings(@Req() req: Request) {
    return this.settings.getSmtpSettings(requireUser(req).id);
  }

  @RequirePermission('platform.setting.manage')
  @Post('settings/test-email')
  @ApiOperation({ summary: '发送测试邮件验证 SMTP 配置（返成功/失败 + 错误信息）' })
  testEmail(@Req() req: Request, @Body() body: TestEmailDto) {
    return this.settings.testEmail(requireUser(req).id, body.to);
  }

  @RequirePermission('platform.setting.manage')
  @Get('settings/geetest')
  @ApiOperation({ summary: '当前极验配置（captchaId/scenes 明文，captchaKey 脱敏）' })
  geetestSettings(@Req() req: Request) {
    return this.settings.getGeetestSettings(requireUser(req).id);
  }

  @RequirePermission('platform.setting.manage')
  @Post('settings/test-captcha')
  @ApiOperation({ summary: '测试极验配置是否可用（探测接口连通性，返成功/失败 + 错误信息）' })
  testCaptcha(@Req() req: Request) {
    return this.settings.testCaptcha(requireUser(req).id);
  }

  @RequirePermission('platform.setting.manage')
  @Get('settings/gitee')
  @ApiOperation({ summary: '当前 Gitee 更新日志源配置（owner/repo 明文，accessToken 脱敏）' })
  giteeSettings(@Req() req: Request) {
    return this.settings.getGiteeSettings(requireUser(req).id);
  }

  @RequirePermission('platform.setting.manage')
  @Get('settings/search')
  @ApiOperation({ summary: '当前搜索源配置（searxngUrl 明文，tavily/brave 密钥脱敏）' })
  searchSettings(@Req() req: Request) {
    return this.settings.getSearchSettings(requireUser(req).id);
  }

  @RequirePermission('platform.setting.manage')
  @Post('settings/test-gitee')
  @ApiOperation({ summary: '测试 Gitee 配置是否可用（探测 releases 端点连通性，返成功/失败 + 错误信息）' })
  testGitee(@Req() req: Request) {
    return this.settings.testGitee(requireUser(req).id);
  }

  @RequirePermission('platform.setting.manage')
  @Post('settings/reveal-secret')
  @ApiOperation({ summary: '查看敏感配置明文（SMTP 密码 / 极验私钥，需二次密码确认 + 审计）' })
  revealSecret(@Req() req: Request, @Body() body: RevealSecretDto) {
    return this.settings.revealSecret(requireUser(req).id, body);
  }
}
