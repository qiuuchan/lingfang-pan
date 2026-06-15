import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public, requireUser } from '../common';
import { TeamService } from './team.service';
import { ConsumeBalanceDto, CreateInvitationDto, RedeemInvitationDto, UpdateTeamProfileDto } from './dto/teams.dto';

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
  @Get('public')
  @ApiOperation({ summary: '发现公开团队（列出 allowPublicJoin=true + ACTIVE 的团队）' })
  listPublic() {
    return this.team.listPublicTeams();
  }

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

  @Get()
  @ApiOperation({ summary: '当前团队信息' })
  current(@Req() req: Request) {
    return this.team.currentTeam(requireUser(req).id);
  }

  @Get('profile')
  @ApiOperation({ summary: '当前团队公开发现设置（allowPublicJoin + description）' })
  profile(@Req() req: Request) {
    return this.team.currentTeamProfile(requireUser(req).id);
  }

  @Patch('profile')
  @ApiOperation({ summary: '团队管理员更新团队公开发现设置' })
  updateProfile(@Req() req: Request, @Body() body: UpdateTeamProfileDto) {
    return this.team.updateTeamProfile(requireUser(req).id, body);
  }

  @Get('members')
  @ApiOperation({ summary: '当前团队成员列表' })
  members(@Req() req: Request) {
    return this.team.currentMembers(requireUser(req).id);
  }

  @Delete('members/:userId')
  @ApiOperation({ summary: '团队管理员移除普通成员' })
  removeMember(@Req() req: Request, @Param('userId') userId: string) {
    return this.team.removeMember(requireUser(req).id, userId);
  }

  @Post('invitations')
  @ApiOperation({ summary: '团队管理员生成邀请码' })
  createInvitation(@Req() req: Request, @Body() body: CreateInvitationDto) {
    return this.team.createInvitation(requireUser(req).id, body);
  }

  @Get('invitations')
  @ApiOperation({ summary: '团队管理员查看邀请码' })
  invitations(@Req() req: Request) {
    return this.team.listInvitations(requireUser(req).id);
  }

  @Patch('invitations/:id/disable')
  @ApiOperation({ summary: '团队管理员禁用邀请码' })
  disableInvitation(@Req() req: Request, @Param('id') id: string) {
    return this.team.disableInvitation(requireUser(req).id, id);
  }

  @Get('balance')
  @ApiOperation({ summary: '当前团队余额' })
  balance(@Req() req: Request) {
    return this.team.balance(requireUser(req).id);
  }

  @Get('balance-ledger')
  @ApiOperation({ summary: '当前团队余额流水' })
  ledger(@Req() req: Request) {
    return this.team.ledger(requireUser(req).id);
  }

  @Post('consume')
  @ApiOperation({ summary: '消耗团队共享余额' })
  consume(@Req() req: Request, @Body() body: ConsumeBalanceDto) {
    return this.team.consume(requireUser(req).id, body);
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