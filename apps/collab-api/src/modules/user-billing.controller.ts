// UserBillingController —— 前台用户侧计费端点（/api/me/api-keys + /api/teams/current/credits）。
//
// 设计（见 docs/billing-and-relay-design.md §11.5.2）：
//  - API Key 自助：/api/me/api-keys（创建/列表/吊销），归属当前团队。
//  - 团队灵石：/api/teams/current/credits（余额+流水），权限 team.credits.view。
import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { AuthService } from './auth.service';
import { PlatformApiKeyService } from './api-key.service';
import { CreditService } from './credit.service';
import { ApiKeyCreateDto } from './dto/billing.dto';

@ApiTags('UserBilling')
@ApiBearerAuth()
@Controller('me/api-keys')
export class UserApiKeyController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PlatformApiKeyService) private readonly apiKeys: PlatformApiKeyService,
  ) {}

  @Get()
  @ApiOperation({ summary: '当前团队的 API Key 列表（脱敏）' })
  async list(@Req() req: Request) {
    const membership = await this.auth.ensureCurrentTeam(requireUser(req).id);
    return this.apiKeys.listForUser(requireUser(req).id, membership.team.id);
  }

  @Post()
  @ApiOperation({ summary: '创建 API Key（明文仅返回一次）' })
  async create(@Req() req: Request, @Body() body: ApiKeyCreateDto) {
    const membership = await this.auth.ensureCurrentTeam(requireUser(req).id);
    return this.apiKeys.createForUser(requireUser(req).id, membership.team.id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: '吊销当前团队的 API Key' })
  async revoke(@Req() req: Request, @Param('id') id: string) {
    const membership = await this.auth.ensureCurrentTeam(requireUser(req).id);
    return this.apiKeys.revokeForUser(requireUser(req).id, membership.team.id, id);
  }
}

@ApiTags('UserBilling')
@ApiBearerAuth()
@Controller('teams/current/credits')
export class UserCreditsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CreditService) private readonly credits: CreditService,
  ) {}

  @Get()
  @RequirePermission('team.credits.view')
  @ApiOperation({ summary: '当前团队灵石余额' })
  async balance(@Req() req: Request) {
    const membership = await this.auth.ensureCurrentTeam(requireUser(req).id);
    const balance = await this.credits.getBalance(membership.team.id);
    return { teamId: membership.team.id, balance };
  }

  @Get('ledger')
  @RequirePermission('team.credits.view')
  @ApiOperation({ summary: '当前团队灵石流水' })
  async ledger(@Req() req: Request) {
    const membership = await this.auth.ensureCurrentTeam(requireUser(req).id);
    return { ledger: await this.credits.getLedger(membership.team.id, 100) };
  }
}
