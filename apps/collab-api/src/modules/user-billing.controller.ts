// UserBillingController —— 前台团队侧计费端点（/api/teams/current/credits）。
//
// 设计（见 docs/billing-and-relay-design.md §11.5.2）：
//  - 团队灵石：/api/teams/current/credits（余额+流水），权限 team.credits.view。
import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { AuthService } from './auth.service';
import { CreditService } from './credit.service';

@ApiTags('UserBilling')
@ApiBearerAuth()
@Controller('teams/current/credits')
export class UserCreditsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CreditService) private readonly credits: CreditService
  ) {}

  @Get()
  @RequirePermission('team.credits.view')
  @ApiOperation({ summary: '当前团队灵石余额' })
  async balance(@Req() req: Request) {
    const user = requireUser(req);
    const membership = await this.auth.ensureTeamMembership(user.id, user.teamId);
    const balance = await this.credits.getBalance(membership.team.id);
    return { teamId: membership.team.id, balance };
  }

  @Get('ledger')
  @RequirePermission('team.credits.view')
  @ApiOperation({ summary: '当前团队灵石流水' })
  async ledger(@Req() req: Request) {
    const user = requireUser(req);
    const membership = await this.auth.ensureTeamMembership(user.id, user.teamId);
    return { ledger: await this.credits.getLedger(membership.team.id, 100) };
  }
}
