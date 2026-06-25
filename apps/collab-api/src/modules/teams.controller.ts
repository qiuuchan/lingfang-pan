import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public, requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { TeamService } from './team.service';
import { ConsumeBalanceDto, CreateInvitationDto, RedeemInvitationDto, UpdateTeamProfileDto, UpdateDefaultPoolDto } from './dto/teams.dto';

/**
 * 公开团队发现控制器（Top1「注册即孤儿」解法）。
 * GET /api/teams/public：列出 allowPublicJoin=true + ACTIVE 的团队（发现页）。
 * POST /api/teams/:id/join：用户直接加入公开团队（无需邀请码/审批）。
 * 与 TeamsController 分离：前者挂在 /teams/current（需登录态），此处挂在 /teams 顶层（公开发现）。
 */
@ApiTags('Teams')
@ApiBearerAuth()
@Controller('teams')
export class PublicTeamsController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  @Public()
  // 修复 H2：公开端点默认 60/min/IP 过宽，可被脚本批量爬取团队目录。收紧到 30/min/IP。
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('public')
  @ApiOperation({ summary: '发现公开团队（列出 allowPublicJoin=true + ACTIVE 的团队）' })
  listPublic() {
    return this.team.listPublicTeams();
  }

  // 修复 H2：写操作默认 60/min/IP 过宽，脚本批量注册账号可灌僵尸成员。收紧到 10/min/IP。
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/join')
  @ApiOperation({ summary: '直接加入公开团队（无需邀请码）' })
  join(@Req() req: Request, @Param('id') id: string) {
    return this.team.joinPublicTeam(requireUser(req).id, id);
  }
}

@ApiTags('Teams')
@ApiBearerAuth()
@Controller('teams/current')
export class TeamsController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  @RequirePermission('team.dashboard.view')
  @Get()
  @ApiOperation({ summary: '当前团队信息' })
  current(@Req() req: Request) {
    return this.team.currentTeam(requireUser(req).id);
  }

  @RequirePermission('team.dashboard.view')
  @Get('profile')
  @ApiOperation({ summary: '当前团队公开发现设置（allowPublicJoin + description）' })
  profile(@Req() req: Request) {
    return this.team.currentTeamProfile(requireUser(req).id);
  }

  @RequirePermission('team.profile.update')
  @Patch('profile')
  @ApiOperation({ summary: '团队管理员更新团队公开发现设置' })
  updateProfile(@Req() req: Request, @Body() body: UpdateTeamProfileDto) {
    return this.team.updateTeamProfile(requireUser(req).id, body);
  }

  @RequirePermission('team.member.list')
  @Get('members')
  @ApiOperation({ summary: '当前团队成员列表' })
  members(@Req() req: Request) {
    return this.team.currentMembers(requireUser(req).id);
  }

  @RequirePermission('team.member.remove')
  @Delete('members/:userId')
  @ApiOperation({ summary: '团队管理员移除普通成员' })
  removeMember(@Req() req: Request, @Param('userId') userId: string) {
    return this.team.removeMember(requireUser(req).id, userId);
  }

  @RequirePermission('team.member.invite')
  @Post('invitations')
  @ApiOperation({ summary: '团队管理员生成邀请码' })
  createInvitation(@Req() req: Request, @Body() body: CreateInvitationDto) {
    return this.team.createInvitation(requireUser(req).id, body);
  }

  @RequirePermission('team.member.invite')
  @Get('invitations')
  @ApiOperation({ summary: '团队管理员查看邀请码' })
  invitations(@Req() req: Request) {
    return this.team.listInvitations(requireUser(req).id);
  }

  @RequirePermission('team.member.invite')
  @Patch('invitations/:id/disable')
  @ApiOperation({ summary: '团队管理员禁用邀请码' })
  disableInvitation(@Req() req: Request, @Param('id') id: string) {
    return this.team.disableInvitation(requireUser(req).id, id);
  }

  @RequirePermission('team.balance.view')
  @Get('balance')
  @ApiOperation({ summary: '当前团队余额' })
  balance(@Req() req: Request) {
    return this.team.balance(requireUser(req).id);
  }

  @RequirePermission('team.balance.view')
  @Get('balance-ledger')
  @ApiOperation({ summary: '当前团队余额流水' })
  ledger(@Req() req: Request) {
    return this.team.ledger(requireUser(req).id);
  }

  @RequirePermission('team.balance.consume')
  @Post('consume')
  @ApiOperation({ summary: '消耗团队共享余额' })
  consume(@Req() req: Request, @Body() body: ConsumeBalanceDto) {
    return this.team.consume(requireUser(req).id, body);
  }

  @RequirePermission('team.profile.update')
  @Patch('default-pool')
  @ApiOperation({ summary: '设置团队默认资源池' })
  updateDefaultPool(@Req() req: Request, @Body() body: UpdateDefaultPoolDto) {
    return this.team.updateDefaultPool(requireUser(req).id, body.defaultPoolId);
  }
}

@ApiTags('Invitations')
@ApiBearerAuth()
@Controller('invitations')
export class InvitationsController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  @Post('redeem')
  @ApiOperation({ summary: '普通用户凭邀请码加入团队' })
  redeem(@Req() req: Request, @Body() body: RedeemInvitationDto) {
    return this.team.redeemInvitation(requireUser(req).id, body.code);
  }
}