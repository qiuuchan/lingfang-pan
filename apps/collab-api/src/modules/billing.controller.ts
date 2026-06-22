// BillingController —— 计费与中转管理端（/api/admin/billing/**）。
//
// 设计（见 docs/billing-and-relay-design.md §6 / §11.5.1）：
//  - 全部 @RequirePermission('platform.billing.*')（RBAC），service 内 ensurePlatformAdmin 兜底。
//  - 渠道/定价/版本/灵石/调用日志/API Key 总览/接入文档。
//  - 接入文档：返回 markdown 字符串（前端用 <Markdown> 渲染）。
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { ChannelService, ChannelRouterService } from './channel.service';
import { PricingService } from './pricing.service';
import { CreditService } from './credit.service';
import { PlatformApiKeyService } from './api-key.service';
import {
  ApiKeyCreateDto,
  ChannelBindingDto,
  ChannelUpsertDto,
  CreditAdjustDto,
  PricingUpsertDto,
  TierConfigDto,
} from './dto/billing.dto';
import { PrismaService } from '../prisma.service';
import { RELAY_DOCS_MARKDOWN } from './relay/docs.content';

@ApiTags('Billing')
@ApiBearerAuth()
@Controller('admin/billing')
export class BillingController {
  constructor(
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(ChannelRouterService) private readonly router: ChannelRouterService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(CreditService) private readonly credits: CreditService,
    @Inject(PlatformApiKeyService) private readonly apiKeys: PlatformApiKeyService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  // === 渠道 ===

  @Get('channels')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '渠道列表' })
  listChannels() {
    return this.channels.adminList();
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

  @Post('channels/:id/bindings')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '添加渠道绑定' })
  addBinding(@Req() req: Request, @Param('id') id: string, @Body() body: ChannelBindingDto) {
    return this.channels.adminAddBinding(requireUser(req).id, id, body.scopeKind, body.scopeId ?? '');
  }

  @Delete('channels/:channelId/bindings/:bindingId')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '删除渠道绑定' })
  removeBinding(@Req() req: Request, @Param('bindingId') bindingId: string) {
    return this.channels.adminRemoveBinding(requireUser(req).id, bindingId);
  }

  @Post('channels/:id/test')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '渠道健康测试（连通性，返回可用模型列表）' })
  testChannel(@Req() req: Request, @Param('id') id: string) {
    return this.channels.adminTest(requireUser(req).id, id);
  }

  @Post('channels/:id/test-chat')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '渠道实对话测试（端到端验证，发一条最小请求）' })
  testChannelChat(@Req() req: Request, @Param('id') id: string, @Body() body: { model: string }) {
    return this.channels.adminTestChat(requireUser(req).id, id, body.model);
  }

  @Post('channels/:id/test-image')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '渠道生图测试（OpenAI 协议，发一次最小生图请求）' })
  testChannelImage(@Req() req: Request, @Param('id') id: string, @Body() body: { model: string; prompt?: string }) {
    return this.channels.adminTestImage(requireUser(req).id, id, body.model, body.prompt);
  }

  // === 定价 ===

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
    // tier 可空：复合唯一键 capability_model_tier 的 tier 列在 Prisma 生成类型里对 null 敏感，
    // 用findFirst+create/update 两段保证幂等（避免直接用复合唯一键 upsert 的类型摩擦）。
    const tier = body.tier ?? null;
    const existing = await this.prisma.modelPricing.findFirst({
      where: { capability: body.capability, model: body.model, tier },
      select: { id: true },
    });
    const data = {
      capability: body.capability,
      model: body.model,
      label: body.label ?? '',
      unit: body.unit as never,
      pricePerUnit: body.pricePerUnit,
      tier,
      enabled: body.enabled ?? true,
    };
    const row = existing
      ? await this.prisma.modelPricing.update({ where: { id: existing.id }, data })
      : await this.prisma.modelPricing.create({ data });
    await this.pricing.invalidate();
    await this.audit(requireUser(req).id, 'admin.pricing.upserted', row.id, { capability: row.capability, model: row.model, tier: row.tier, pricePerUnit: row.pricePerUnit });
    return { pricing: row };
  }

  @Delete('pricing/:id')
  @RequirePermission('platform.billing.pricing.manage')
  @ApiOperation({ summary: '删除定价' })
  async deletePricing(@Req() req: Request, @Param('id') id: string) {
    await this.prisma.modelPricing.delete({ where: { id } });
    await this.pricing.invalidate();
    await this.audit(requireUser(req).id, 'admin.pricing.deleted', id, {});
    return { ok: true };
  }

  // === 版本配置 ===

  @Get('tiers')
  @RequirePermission('platform.billing.tier.manage')
  @ApiOperation({ summary: '模型版本配置列表' })
  async listTiers() {
    const rows = await this.prisma.modelTierConfig.findMany({ orderBy: { tier: 'asc' } });
    return { tiers: rows };
  }

  @Put('tiers/:tier')
  @RequirePermission('platform.billing.tier.manage')
  @ApiOperation({ summary: '更新版本配置（upsert）' })
  async upsertTier(@Req() req: Request, @Param('tier') tier: 'FAST' | 'PREMIUM', @Body() body: TierConfigDto) {
    const row = await this.prisma.modelTierConfig.upsert({
      where: { tier },
      create: {
        tier,
        label: body.label ?? '',
        chatModel: body.chatModel,
        imageModel: body.imageModel ?? null,
        temperature: body.temperature ?? null,
        maxTokens: body.maxTokens ?? null,
      },
      update: {
        label: body.label,
        chatModel: body.chatModel,
        imageModel: body.imageModel,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
      },
    });
    await this.pricing.invalidate();
    await this.audit(requireUser(req).id, 'admin.tier.updated', tier, { chatModel: row.chatModel });
    return { tier: row };
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
  @ApiOperation({ summary: '调整团队灵石（加/扣 + 强审计）' })
  async adjustCredits(@Req() req: Request, @Param('teamId') teamId: string, @Body() body: CreditAdjustDto) {
    const { balance } = await this.credits.adjust({
      teamId,
      amount: body.amount,
      direction: body.direction,
      reason: body.reason,
      actorUserId: requireUser(req).id,
    });
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
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: { team: { select: { name: true } }, user: { select: { email: true } } },
    });
    return { logs: rows };
  }

  @Get('call-logs/:id')
  @RequirePermission('platform.billing.call_log.view')
  @ApiOperation({ summary: '调用日志详情' })
  async callLogDetail(@Param('id') id: string) {
    const row = await this.prisma.llmCallLog.findUnique({ where: { id } });
    return { log: row };
  }

  // === API Key 总览 ===

  @Get('api-keys')
  @RequirePermission('platform.billing.api_key.manage')
  @ApiOperation({ summary: '全平台 API Key 总览' })
  adminListApiKeys() {
    return this.apiKeys.adminList();
  }

  @Delete('api-keys/:id')
  @RequirePermission('platform.billing.api_key.manage')
  @ApiOperation({ summary: '吊销任意 API Key' })
  adminRevokeApiKey(@Req() req: Request, @Param('id') id: string) {
    return this.apiKeys.adminRevoke(requireUser(req).id, id);
  }

  // === 接入文档 ===

  @Get('relay-docs')
  @RequirePermission('platform.billing.relay_docs.view')
  @ApiOperation({ summary: '中转接入文档（markdown）' })
  relayDocs() {
    return { markdown: RELAY_DOCS_MARKDOWN };
  }

  private async audit(actorUserId: string, action: string, targetId: string | undefined, metadata: unknown) {
    await this.prisma.auditLog.create({
      data: { actorUserId, action, targetType: 'Billing', targetId: targetId ?? null, metadata: metadata as object },
    });
  }
}
