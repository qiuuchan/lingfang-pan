import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { CollabService } from './collab.service';

@ApiTags('Teams')
@ApiBearerAuth()
@Controller('teams/current')
export class TeamsController {
  constructor(@Inject(CollabService) private readonly collab: CollabService) {}

  @Get()
  @ApiOperation({ summary: '当前团队信息' })
  current(@Req() req: Request) {
    return this.collab.currentTeam(requireUser(req).id);
  }

  @Get('members')
  @ApiOperation({ summary: '当前团队成员列表' })
  members(@Req() req: Request) {
    return this.collab.currentMembers(requireUser(req).id);
  }

  @Delete('members/:userId')
  @ApiOperation({ summary: '团队管理员移除普通成员' })
  removeMember(@Req() req: Request, @Param('userId') userId: string) {
    return this.collab.removeMember(requireUser(req).id, userId);
  }

  @Post('invitations')
  @ApiOperation({ summary: '团队管理员生成邀请码' })
  createInvitation(@Req() req: Request, @Body() body: { maxUses?: number; expiresAt?: string }) {
    return this.collab.createInvitation(requireUser(req).id, body);
  }

  @Get('invitations')
  @ApiOperation({ summary: '团队管理员查看邀请码' })
  invitations(@Req() req: Request) {
    return this.collab.listInvitations(requireUser(req).id);
  }

  @Patch('invitations/:id/disable')
  @ApiOperation({ summary: '团队管理员禁用邀请码' })
  disableInvitation(@Req() req: Request, @Param('id') id: string) {
    return this.collab.disableInvitation(requireUser(req).id, id);
  }

  @Get('balance')
  @ApiOperation({ summary: '当前团队余额' })
  balance(@Req() req: Request) {
    return this.collab.balance(requireUser(req).id);
  }

  @Get('balance-ledger')
  @ApiOperation({ summary: '当前团队余额流水' })
  ledger(@Req() req: Request) {
    return this.collab.ledger(requireUser(req).id);
  }

  @Post('consume')
  @ApiOperation({ summary: '消耗团队共享余额' })
  consume(@Req() req: Request, @Body() body: { amountCents: number; reason?: string }) {
    return this.collab.consume(requireUser(req).id, body);
  }
}

@ApiTags('Invitations')
@ApiBearerAuth()
@Controller('invitations')
export class InvitationsController {
  constructor(@Inject(CollabService) private readonly collab: CollabService) {}

  @Post('redeem')
  @ApiOperation({ summary: '普通用户凭邀请码加入团队' })
  redeem(@Req() req: Request, @Body() body: { code: string }) {
    return this.collab.redeemInvitation(requireUser(req).id, body.code);
  }
}