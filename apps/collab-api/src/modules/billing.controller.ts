// BillingController —— 计费与中转管理端（/api/admin/billing/**）。
//
// 资源池模型重构（2026-06-23）：新增 Pool CRUD；渠道按 kind（CHAT/IMAGE）分列；
// 删除 ModelTierConfig 端点（版本=渠道标签）+ ChannelBinding 端点（改用 Pool 范围）。
// 接入文档（relay-docs）按需求 #4 移入 skill，本控制器不再暴露。
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AppError, requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { ChannelService, PoolService } from './channel.service';
import { PricingService } from './pricing.service';
import { CreditService } from './credit.service';
import {
  ChannelUpsertDto, CreditAdjustDto, PoolUpdateDto, PoolUpsertDto, PricingUpsertDto, TestChatDto, TestImageDto,
} from './dto/billing.dto';
import { PrismaService } from '../prisma.service';
import { normalizeBillingPage, type BillingPageQuery } from './admin-billing-data';

@ApiTags('Billing')
@ApiBearerAuth()
@Controller('admin/billing')
export class BillingController {
  constructor(
    @Inject(PoolService) private readonly pools: PoolService,
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(CreditService) private readonly credits: CreditService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  // === 资源池 ===

  @Get('pools')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '资源池列表' })
  listPools(@Query() query: BillingPageQuery) { return this.pools.adminList(query); }

  @Post('pools')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '创建资源池（SHARED 共享 / DEDICATED 单团队）' })
  createPool(@Req() req: Request, @Body() body: PoolUpsertDto) {
    return this.pools.adminCreate(requireUser(req).id, body);
  }

  @Patch('pools/:id')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '更新资源池（名称/说明）' })
  updatePool(@Req() req: Request, @Param('id') id: string, @Body() body: PoolUpdateDto) {
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
  listChannels(@Query('kind') kind: 'CHAT' | 'IMAGE' | undefined, @Query() query: BillingPageQuery) {
    return this.channels.adminList(kind, query);
  }

  @Get('channels/:id')
  @RequirePermission('platform.billing.channel.manage')
  @ApiOperation({ summary: '渠道详情（按需加载接入参数和模型）' })
  channelDetail(@Param('id') id: string) { return this.channels.adminDetail(id); }

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
  async listPricing(@Query() query: BillingPageQuery & { capability?: string; tier?: 'FAST' | 'PREMIUM' }) {
    const { page, pageSize, skip, q } = normalizeBillingPage(query);
    const where = { ...(query.capability ? { capability: query.capability } : {}), ...(query.tier ? { tier: query.tier } : {}), ...(q ? { OR: [{ model: { contains: q, mode: 'insensitive' as const } }, { label: { contains: q, mode: 'insensitive' as const } }] } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.modelPricing.findMany({ where, orderBy: [{ capability: 'asc' }, { model: 'asc' }], skip, take: pageSize }),
      this.prisma.modelPricing.count({ where }),
    ]);
    return { items, total, page, pageSize };
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
      unit: body.unit as never, pricePerUnit: body.pricePerUnit, tier: body.tier ?? null,
      contextWindow: body.contextWindow ?? null, enabled: body.enabled ?? true,
    };
    const row = existing
      ? await this.prisma.modelPricing.update({ where: { id: existing.id }, data })
      : await this.prisma.modelPricing.create({ data });
    await this.audit(requireUser(req).id, 'admin.pricing.upserted', row.id, { capability: row.capability, model: row.model, tier: row.tier, pricePerUnit: row.pricePerUnit });
    return { pricing: row };
  }

  @Patch('pricing/:id')
  @RequirePermission('platform.billing.pricing.manage')
  @ApiOperation({ summary: '按 ID 更新定价' })
  async updatePricing(@Req() req: Request, @Param('id') id: string, @Body() body: PricingUpsertDto) {
    const existing = await this.prisma.modelPricing.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new AppError(404, 'pricing_not_found', '定价不存在');
    try {
      const row = await this.prisma.modelPricing.update({
        where: { id },
        data: {
          capability: body.capability,
          model: body.model,
          label: body.label ?? '',
          unit: body.unit as never,
          pricePerUnit: body.pricePerUnit,
          tier: body.tier ?? null,
          contextWindow: body.contextWindow ?? null,
          enabled: body.enabled ?? true,
        },
      });
      await this.audit(requireUser(req).id, 'admin.pricing.updated', row.id, { capability: row.capability, model: row.model, tier: row.tier, pricePerUnit: row.pricePerUnit });
      return { pricing: row };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new AppError(409, 'conflict', '同能力、模型与版本的定价已存在');
      throw error;
    }
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

  @Get('credits/teams')
  @RequirePermission('platform.billing.call_log.view')
  @ApiOperation({ summary: '团队灵石余额分页摘要（只读、无账户创建副作用）' })
  async creditTeams(@Query() query: BillingPageQuery & { status?: 'ACTIVE' | 'SUSPENDED' }) {
    const { page, pageSize, skip, q } = normalizeBillingPage(query);
    const where = { ...(query.status ? { status: query.status } : {}), ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { slug: { contains: q, mode: 'insensitive' as const } }] } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.team.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize, select: { id: true, name: true, slug: true, status: true, creditAccount: { select: { balance: true } }, _count: { select: { memberships: true } } } }),
      this.prisma.team.count({ where }),
    ]);
    return { items: rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug, status: row.status, balance: row.creditAccount?.balance ?? 0, memberCount: row._count.memberships })), total, page, pageSize };
  }

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
  async teamLedger(@Param('teamId') teamId: string, @Query() query: BillingPageQuery) {
    const { page, pageSize, skip } = normalizeBillingPage(query);
    const where = { teamId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.creditLedger.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      this.prisma.creditLedger.count({ where }),
    ]);
    return { items, total, page, pageSize };
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
    if (q.clientSource) where.clientSource = q.clientSource;
    if (q.from || q.to) where.createdAt = { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined };
    if (q.q) where.OR = [{ model: { contains: q.q, mode: 'insensitive' } }, { requestId: { contains: q.q, mode: 'insensitive' } }];
    const { page, pageSize, skip } = normalizeBillingPage(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.llmCallLog.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take: pageSize,
      select: {
        id: true, teamId: true, userId: true, clientSource: true, channelId: true, capability: true, tier: true, model: true,
        inputTokens: true, outputTokens: true, images: true, durationMs: true, credits: true, status: true, httpStatus: true,
        errorCode: true, requestId: true, createdAt: true,
        team: { select: { name: true } },
        user: { select: { email: true } },
        channel: { select: { id: true, name: true, pool: { select: { id: true, name: true } } } },
      },
      }),
      this.prisma.llmCallLog.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        ...r,
        poolId: r.channel?.pool?.id ?? null,
        poolName: r.channel?.pool?.name ?? null,
        channelName: r.channel?.name ?? null,
      })), total, page, pageSize,
    };
  }

  @Get('call-logs/:id')
  @RequirePermission('platform.billing.call_log.view')
  @ApiOperation({ summary: '调用日志详情（含脱敏请求摘要与客户端 IP）' })
  async callLogDetail(@Param('id') id: string) {
    const log = await this.prisma.llmCallLog.findUnique({ where: { id }, include: { team: { select: { name: true } }, user: { select: { email: true } }, channel: { select: { id: true, name: true } } } });
    if (!log) throw new AppError(404, 'call_log_not_found', '调用日志不存在');
    return { log };
  }

  private async audit(actorUserId: string, action: string, targetId: string | undefined, metadata: unknown) {
    await this.prisma.auditLog.create({
      data: { actorUserId, action, targetType: 'Billing', targetId: targetId ?? null, metadata: metadata as object },
    });
  }
}
