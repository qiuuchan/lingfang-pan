// BillingController —— 计费与中转管理端（/api/admin/billing/**）。
//
// 资源池模型重构（2026-06-23）：新增 Pool CRUD；渠道按 kind（CHAT/IMAGE）分列；
// 删除 ModelTierConfig 端点（版本=渠道标签）+ ChannelBinding 端点（改用 Pool 范围）。
// 接入文档（relay-docs）按需求 #4 移入 skill，本控制器不再暴露。
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { ChannelService, PoolService } from './channel.service';
import { PricingService } from './pricing.service';
import { CreditService } from './credit.service';
import { PlatformApiKeyService } from './api-key.service';
import {
  ApiKeyCreateDto, ChannelUpsertDto, CreditAdjustDto, PoolUpsertDto, PricingUpsertDto, TestChatDto, TestImageDto,
} from './dto/billing.dto';
import { PrismaService } from '../prisma.service';

@ApiTags('Billing')
@ApiBearerAuth()
@Controller('admin/billing')
export class BillingController {
  constructor(
    @Inject(PoolService) private readonly pools: PoolService,
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(CreditService) private readonly credits: CreditService,
    @Inject(PlatformApiKeyService) private readonly apiKeys: PlatformApiKeyService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  // === 资源池 ===

  @Get('pools')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '资源池列表' })
  listPools() { return this.pools.adminList(); }

  @Post('pools')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '创建资源池（SHARED 共享 / DEDICATED 单团队）' })
  createPool(@Req() req: Request, @Body() body: PoolUpsertDto) {
    return this.pools.adminCreate(requireUser(req).id, body);
  }

  @Patch('pools/:id')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '更新资源池（名称/说明）' })
  updatePool(@Req() req: Request, @Param('id') id: string, @Body() body: PoolUpsertDto) {
    return this.pools.adminUpdate(requireUser(req).id, id, { name: body.name, description: body.description });
  }

  @Delete('pools/:id')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '删除资源池（级联删渠道）' })
  deletePool(@Req() req: Request, @Param('id') id: string) {
    return this.pools.adminDelete(requireUser(req).id, id);
  }

  // === 渠道（按 kind 分列：CHAT 聊天 / IMAGE 生图）===

  @Get('channels')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '渠道列表（可选 kind 过滤 CHAT/IMAGE）' })
  listChannels(@Query('kind') kind?: 'CHAT' | 'IMAGE') {
    return this.channels.adminList(kind);
  }

  @Post('channels')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '创建渠道' })
  createChannel(@Req() req: Request, @Body() body: ChannelUpsertDto) {
    return this.channels.adminCreate(requireUser(req).id, { ...body, upstreamKey: body.upstreamKey ?? '' });
  }

  @Patch('channels/:id')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '更新渠道' })
  updateChannel(@Req() req: Request, @Param('id') id: string, @Body() body: ChannelUpsertDto) {
    return this.channels.adminUpdate(requireUser(req).id, id, { ...body, upstreamKey: body.upstreamKey ?? '' });
  }

  @Delete('channels/:id')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '删除渠道' })
  deleteChannel(@Req() req: Request, @Param('id') id: string) {
    return this.channels.adminDelete(requireUser(req).id, id);
  }

  @Post('channels/:id/test')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '渠道连通性测试（返回可用模型列表）' })
  testChannel(@Req() req: Request, @Param('id') id: string) {
    return this.channels.adminTest(requireUser(req).id, id);
  }

  @Post('channels/:id/test-chat')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '渠道实对话测试（仅 CHAT 渠道）' })
  testChannelChat(@Req() req: Request, @Param('id') id: string, @Body() body: TestChatDto) {
    return this.channels.adminTestChat(requireUser(req).id, id, body.model);
  }

  @Post('channels/:id/test-image')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '渠道生图测试（仅 IMAGE 渠道）' })
  testChannelImage(@Req() req: Request, @Param('id') id: string, @Body() body: TestImageDto) {
    return this.channels.adminTestImage(requireUser(req).id, id, body.model, body.prompt);
  }

  // === 定价（单位：PER_TOKEN_* = 每 1M token）===

  @Get('pricing')
  @RequirePermission('platform.billing.pricing.manage')
  @ApiOperation({ summary: '模型定价列表' })
  async listPricing() {
    const rows = await this.prisma.modelPricing.findMany({ orderBy: [{ capability: 'asc' }, { model: 'asc' }] });
    return { pricing: rows };
  }

  @Post('pricing')
  @RequirePermission('platform.billing.pricing.manage')
  @ApiOperation({ summary: '创建/更新定价（upsert by capability+model+tier）' })
  async upsertPricing(@Req() req: Request, @Body() body: PricingUpsertDto) {
    const existing = await this.prisma.modelPricing.findFirst({
      where: { capability: body.capability, model: body.model, tier: body.tier ?? null },
      select: { id: true },
    });
    const data = {
      capability: body.capability, model: body.model, label: body.label ?? '',
      unit: body.unit as never, pricePerUnit: body.pricePerUnit, tier: body.tier ?? null, enabled: body.enabled ?? true,
    };
    const row = existing
      ? await this.prisma.modelPricing.update({ where: { id: existing.id }, data })
      : await this.prisma.modelPricing.create({ data });
    await this.audit(requireUser(req).id, 'admin.pricing.upserted', row.id, { capability: row.capability, model: row.model, tier: row.tier, pricePerUnit: row.pricePerUnit });
    return { pricing: row };
  }

  @Delete('pricing/:id')
  @RequirePermission('platform.billing.pricing.manage')
  @ApiOperation({ summary: '删除定价' })
  async deletePricing(@Req() req: Request, @Param('id') id: string) {
    await this.prisma.modelPricing.delete({ where: { id } });
    await this.audit(requireUser(req).id, 'admin.pricing.deleted', id, {});
    return { ok: true };
  }

  // === 灵石 ===

  @Get('credits/teams/:teamId')
  @RequirePermission('platform.billing.call_log.view')
  @ApiOperation({ summary: '团队灵石余额' })
  async teamCredits(@Param('teamId') teamId: string) {
    const balance = await this.credits.getBalance(teamId);
    return { teamId, balance };
  }

  @Get('credits/teams/:teamId/ledger')
  @RequirePermission('platform.billing.call_log.view')
  @ApiOperation({ summary: '团队灵石流水' })
  async teamLedger(@Param('teamId') teamId: string) {
    return { ledger: await this.credits.getLedger(teamId, 200) };
  }

  @Post('credits/teams/:teamId/adjustments')
  @RequirePermission('platform.billing.credit.adjust')
  @ApiOperation({ summary: '调整团队灵石' })
  async adjustCredits(@Req() req: Request, @Param('teamId') teamId: string, @Body() body: CreditAdjustDto) {
    const { balance } = await this.credits.adjust({ teamId, amount: body.amount, direction: body.direction, reason: body.reason, actorUserId: requireUser(req).id });
    await this.audit(requireUser(req).id, 'admin.credit.adjusted', teamId, { amount: body.amount, direction: body.direction, reason: body.reason, balance });
    return { teamId, balance };
  }

  // === 调用日志 ===

  @Get('call-logs')
  @RequirePermission('platform.billing.call_log.view')
  @ApiOperation({ summary: '调用日志（多维度查询）' })
  async callLogs(@Req() req: Request) {
    const q = req.query as Record<string, string | undefined>;
    const where: Record<string, unknown> = {};
    if (q.teamId) where.teamId = q.teamId;
    if (q.userId) where.userId = q.userId;
    if (q.capability) where.capability = q.capability;
    if (q.status) where.status = q.status;
    if (q.model) where.model = q.model;
    if (q.apiKeyId) where.apiKeyId = q.apiKeyId;
    if (q.from || q.to) where.createdAt = { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined };
    const take = Math.min(200, Number(q.pageSize) || 50);
    const rows = await this.prisma.llmCallLog.findMany({
      where, orderBy: { createdAt: 'desc' }, take,
      include: { team: { select: { name: true } }, user: { select: { email: true } } },
    });
    return { logs: rows };
  }

  // === API Key 总览 ===

  @Get('api-keys')
  @RequirePermission('platform.billing.api_key.manage')
  @ApiOperation({ summary: '全平台 API Key 总览' })
  adminListApiKeys() { return this.apiKeys.adminList(); }

  @Delete('api-keys/:id')
  @RequirePermission('platform.billing.api_key.manage')
  @ApiOperation({ summary: '吊销任意 API Key' })
  adminRevokeApiKey(@Req() req: Request, @Param('id') id: string) {
    return this.apiKeys.adminRevoke(requireUser(req).id, id);
  }

  private async audit(actorUserId: string, action: string, targetId: string | undefined, metadata: unknown) {
    await this.prisma.auditLog.create({
      data: { actorUserId, action, targetType: 'Billing', targetId: targetId ?? null, metadata: metadata as object },
    });
  }
}
