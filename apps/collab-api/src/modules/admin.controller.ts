import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { CollabService } from './collab.service';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(@Inject(CollabService) private readonly collab: CollabService) {}

  @Get('dashboard')
  @ApiOperation({ summary: '管理端指标' })
  dashboard(@Req() req: Request) {
    return this.collab.adminDashboard(requireUser(req).id);
  }

  @Get('users')
  @ApiOperation({ summary: '用户列表' })
  users(@Req() req: Request) {
    return this.collab.adminUsers(requireUser(req).id);
  }

  @Post('users')
  @ApiOperation({ summary: '创建用户' })
  createUser(@Req() req: Request, @Body() body: { email: string; password: string; displayName?: string; platformRole?: 'NONE' | 'PLATFORM_ADMIN' }) {
    return this.collab.adminCreateUser(requireUser(req).id, body);
  }

  @Patch('users/:id')
  @ApiOperation({ summary: '更新用户' })
  updateUser(@Req() req: Request, @Param('id') id: string, @Body() body: { displayName?: string; status?: 'ACTIVE' | 'DISABLED'; platformRole?: 'NONE' | 'PLATFORM_ADMIN' }) {
    return this.collab.adminUpdateUser(requireUser(req).id, id, body);
  }

  @Delete('users/:id')
  @ApiOperation({ summary: '禁用用户' })
  deleteUser(@Req() req: Request, @Param('id') id: string) {
    return this.collab.adminDeleteUser(requireUser(req).id, id);
  }

  @Get('teams')
  @ApiOperation({ summary: '团队列表' })
  teams(@Req() req: Request) {
    return this.collab.adminTeams(requireUser(req).id);
  }

  @Post('teams')
  @ApiOperation({ summary: '创建团队' })
  createTeam(@Req() req: Request, @Body() body: { name: string; slug?: string; balanceCents?: number }) {
    return this.collab.adminCreateTeam(requireUser(req).id, body);
  }

  @Patch('teams/:id')
  @ApiOperation({ summary: '更新团队' })
  updateTeam(@Req() req: Request, @Param('id') id: string, @Body() body: { name?: string; status?: 'ACTIVE' | 'SUSPENDED' }) {
    return this.collab.adminUpdateTeam(requireUser(req).id, id, body);
  }

  @Post('teams/:id/admins')
  @ApiOperation({ summary: '指定团队管理员' })
  setTeamAdmin(@Req() req: Request, @Param('id') id: string, @Body() body: { userId: string }) {
    return this.collab.adminSetTeamAdmin(requireUser(req).id, id, body);
  }

  @Delete('teams/:teamId/admins/:userId')
  @ApiOperation({ summary: '撤销团队管理员' })
  revokeTeamAdmin(@Req() req: Request, @Param('teamId') teamId: string, @Param('userId') userId: string) {
    return this.collab.adminRevokeTeamAdmin(requireUser(req).id, teamId, userId);
  }

  @Post('teams/:teamId/balance-adjustments')
  @ApiOperation({ summary: '调整团队共享余额' })
  adjustBalance(@Req() req: Request, @Param('teamId') teamId: string, @Body() body: { amountCents: number; direction: 'CREDIT' | 'DEBIT'; reason?: string }) {
    return this.collab.adminAdjustBalance(requireUser(req).id, teamId, body);
  }

  @Get('plugins')
  @ApiOperation({ summary: '平台插件列表' })
  plugins(@Req() req: Request) {
    return this.collab.adminPlugins(requireUser(req).id);
  }

  @Get('plugins/review-pending')
  @ApiOperation({ summary: '待审核市场插件列表' })
  reviewPendingPlugins(@Req() req: Request) {
    return this.collab.adminPluginReviewPending(requireUser(req).id);
  }

  @Post('plugins')
  @ApiOperation({ summary: '拒绝管理端新增平台插件' })
  createPlugin(@Req() req: Request, @Body() body: { name: string; description?: string; status?: 'ENABLED' | 'DISABLED' }) {
    void body;
    return this.collab.adminCreatePlugin(requireUser(req).id);
  }

  @Post('plugins/:id/approve')
  @ApiOperation({ summary: '审核通过市场插件' })
  approvePlugin(@Req() req: Request, @Param('id') id: string) {
    return this.collab.adminApprovePlugin(requireUser(req).id, id);
  }

  @Post('plugins/:id/reject')
  @ApiOperation({ summary: '驳回市场插件' })
  rejectPlugin(@Req() req: Request, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.collab.adminRejectPlugin(requireUser(req).id, id, body.reason);
  }

  @Patch('plugins/:id')
  @ApiOperation({ summary: '更新平台插件' })
  updatePlugin(@Req() req: Request, @Param('id') id: string, @Body() body: { name?: string; description?: string; status?: 'ENABLED' | 'DISABLED'; priceCents?: number }) {
    return this.collab.adminUpdatePlugin(requireUser(req).id, id, body);
  }

  @Get('team-admin-applications')
  @ApiOperation({ summary: '团队管理员申请列表' })
  applications(@Req() req: Request) {
    return this.collab.adminApplications(requireUser(req).id);
  }

  @Post('team-admin-applications/:id/approve')
  @ApiOperation({ summary: '审批通过团队管理员申请' })
  approve(@Req() req: Request, @Param('id') id: string) {
    return this.collab.approveApplication(requireUser(req).id, id);
  }

  @Post('team-admin-applications/:id/reject')
  @ApiOperation({ summary: '驳回团队管理员申请' })
  reject(@Req() req: Request, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.collab.rejectApplication(requireUser(req).id, id, body.reason);
  }

  @Get('audit-logs')
  @ApiOperation({ summary: '审计日志' })
  auditLogs(@Req() req: Request) {
    return this.collab.auditLogs(requireUser(req).id);
  }
}