import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { MarketplaceCommerceService } from './marketplace-commerce.service';
import { MarketplaceCommerceQueryService } from './marketplace-commerce-query.service';
import { MarketplaceSettlementCutoverService } from './marketplace-settlement-cutover.service';
import { AuthService } from './auth.service';
import { RequirePermission } from './auth.decorators';
import {
  MarketplaceCampaignCreateDto,
  MarketplaceDiscountCreateDto,
  MarketplacePriceUpdateDto,
  MarketplacePriceVersionDto,
  MarketplaceRefundRequestDto,
  MarketplaceRefundReviewDto,
  MarketplaceSettlementTriggerDto,
  MarketplaceCutoverGenerationDto,
  MarketplaceCutoverPauseDto,
  MarketplaceBackfillDto,
  MarketplaceOrderQueryDto,
  MarketplaceRefundAdminQueryDto,
} from './dto/marketplace-commerce.dto';

@ApiTags('Marketplace Commerce')
@ApiBearerAuth()
@Controller()
export class MarketplaceCommerceController {
  constructor(
    @Inject(MarketplaceCommerceService) private readonly commerce: MarketplaceCommerceService,
    @Inject(MarketplaceCommerceQueryService) private readonly queries: MarketplaceCommerceQueryService,
    @Inject(MarketplaceSettlementCutoverService) private readonly cutover: MarketplaceSettlementCutoverService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @RequirePermission('team.balance.view')
  @Get('teams/current/plugin-purchases')
  buyerOrders(@Req() req: Request, @Query() query: MarketplaceOrderQueryDto) {
    return this.queries.buyerOrders(requireUser(req).id, query);
  }

  @RequirePermission('team.balance.view')
  @Get('teams/current/marketplace-statement')
  sellerStatement(@Req() req: Request, @Query() query: MarketplaceOrderQueryDto) {
    return this.queries.sellerStatement(requireUser(req).id, query);
  }

  @RequirePermission('team.balance.view')
  @Get('teams/current/marketplace-statement/daily')
  sellerStatementDaily(@Req() req: Request, @Query() query: MarketplaceOrderQueryDto) {
    return this.queries.sellerStatementDaily(requireUser(req).id, query);
  }

  @Get('admin/marketplace/refund-requests')
  refundRequests(@Req() req: Request, @Query() query: MarketplaceRefundAdminQueryDto) {
    return this.queries.adminRefundRequests(requireUser(req).id, query);
  }

  @Get('admin/marketplace/refund-requests/:id')
  refundRequestDetail(@Req() req: Request, @Param('id') id: string) {
    return this.queries.adminRefundRequestDetail(requireUser(req).id, id);
  }

  @Post('plugin-purchases/:id/refund-request')
  requestRefund(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplaceRefundRequestDto) {
    return this.commerce.requestRefund(requireUser(req).id, id, body.reason);
  }

  @Post('admin/marketplace/refund-requests/:id/approve')
  approveRefund(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplaceRefundReviewDto) {
    return this.commerce.approveRefund(requireUser(req).id, id, body.reason ?? '');
  }

  @Post('admin/marketplace/refund-requests/:id/reject')
  rejectRefund(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplaceRefundReviewDto) {
    return this.commerce.rejectRefund(requireUser(req).id, id, body.reason ?? '');
  }

  @Post('admin/marketplace/settlement/trigger')
  async triggerSettlement(@Req() req: Request, @Body() body: MarketplaceSettlementTriggerDto) {
    await this.auth.ensurePlatformAdmin(requireUser(req).id);
    return this.cutover.runSettlementJob(body.now ? new Date(body.now) : new Date(), body.limit ?? 100);
  }

  @Post('admin/marketplace/settlement/cutover/drain')
  async beginSettlementCutover(@Req() req: Request, @Body() body: MarketplaceCutoverGenerationDto) {
    await this.auth.ensurePlatformAdmin(requireUser(req).id);
    return this.cutover.beginDraining(body.expectedGeneration);
  }

  @Post('admin/marketplace/settlement/cutover/activate')
  async activateSettlementCutover(@Req() req: Request, @Body() body: MarketplaceCutoverGenerationDto) {
    await this.auth.ensurePlatformAdmin(requireUser(req).id);
    return this.cutover.activate(body.expectedGeneration);
  }

  @Post('admin/marketplace/settlement/cutover/pause')
  async pauseSettlementCutover(@Req() req: Request, @Body() body: MarketplaceCutoverPauseDto) {
    await this.auth.ensurePlatformAdmin(requireUser(req).id);
    return this.cutover.pause(body.expectedGeneration, body.reason ?? '');
  }

  @Post('admin/marketplace/settlement/cutover/resume')
  async resumeSettlementCutover(@Req() req: Request, @Body() body: MarketplaceCutoverGenerationDto) {
    await this.auth.ensurePlatformAdmin(requireUser(req).id);
    return this.cutover.resume(body.expectedGeneration);
  }

  @Post('admin/marketplace/settlement/backfill')
  async backfillSettlement(@Req() req: Request, @Body() body: MarketplaceBackfillDto) {
    await this.auth.ensurePlatformAdmin(requireUser(req).id);
    return this.cutover.backfillLegacy({ dryRun: body.dryRun, limit: body.limit });
  }

  @Post('admin/marketplace/settlement/reconcile')
  async reconcileSettlement(@Req() req: Request) {
    await this.auth.ensurePlatformAdmin(requireUser(req).id);
    return this.cutover.reconcile({});
  }

  @Get('admin/marketplace/settlement/status')
  async settlementStatus(@Req() req: Request) {
    await this.auth.ensurePlatformAdmin(requireUser(req).id);
    return this.cutover.settlementJobStatus();
  }

  @Get('admin/marketplace/settlement/cutover/status')
  async settlementCutoverStatus(@Req() req: Request) {
    await this.auth.ensurePlatformAdmin(requireUser(req).id);
    return { state: await this.cutover.state(), job: await this.cutover.settlementJobStatus(), scheduler_started: this.cutover.isStarted() };
  }

  @Post('plugin-packages/:id/marketplace-price')
  updatePrice(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplacePriceUpdateDto) {
    return this.commerce.updateListingPrice(requireUser(req).id, id, body.priceCents, body.expectedPriceVersion);
  }

  @Post('plugin-packages/:id/discounts')
  createDiscount(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplaceDiscountCreateDto) {
    return this.commerce.createDiscount(requireUser(req).id, id, {
      priceCents: body.priceCents,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      expectedPriceVersion: body.expectedPriceVersion,
    });
  }

  @Post('marketplace-discounts/:id/cancel')
  cancelDiscount(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplacePriceVersionDto) {
    return this.commerce.cancelDiscount(requireUser(req).id, id, body.expectedPriceVersion);
  }

  @Post('admin/marketplace/campaigns')
  createCampaign(@Req() req: Request, @Body() body: MarketplaceCampaignCreateDto) {
    return this.commerce.createCampaign(requireUser(req).id, {
      slug: body.slug,
      name: body.name,
      description: body.description ?? '',
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      items: body.items,
    });
  }

  @Post('admin/marketplace/campaigns/:id/publish')
  publishCampaign(@Req() req: Request, @Param('id') id: string) {
    return this.commerce.publishCampaign(requireUser(req).id, id);
  }

  @Post('admin/marketplace/campaigns/:id/cancel')
  cancelCampaign(@Req() req: Request, @Param('id') id: string) {
    return this.commerce.cancelCampaign(requireUser(req).id, id);
  }

  @Get('marketplace/campaigns/:id/items/:packageId/attribution-token')
  campaignAttributionToken(@Req() req: Request, @Param('id') id: string, @Param('packageId') packageId: string) {
    return this.commerce.issueCampaignToken(requireUser(req).id, id, packageId);
  }

  @Get('admin/marketplace/campaigns/:id/report')
  campaignReport(@Req() req: Request, @Param('id') id: string) {
    return this.queries.campaignReport(requireUser(req).id, id);
  }
}
