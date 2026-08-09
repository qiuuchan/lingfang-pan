import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ensureRequestId, requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import {
  AdaptDryRunDto,
  AdminPluginPackageListQueryDto,
  AdminPluginPageQueryDto,
  AdminPluginReasonDto,
  PluginLifecycleReasonDto,
  PluginRuntimeAccessDto,
  StageAdaptationReportDto,
  UpdateMarketplaceListingStatusDto,
  UpdatePluginPackageStatusDto,
  UpdatePluginReleaseStatusDto,
} from './dto/plugin-registry.dto';
import { MarketplacePurchaseDto } from './dto/marketplace-commerce.dto';
import { MarketplaceCommerceService } from './marketplace-commerce.service';
import { SubmitMarketplaceDto } from './dto/plugins.dto';
import { PluginRegistryService } from './plugin-registry.service';
import { MarketplaceDiscoveryService } from './marketplace-discovery.service';
import { type PluginAiPolicyFile } from './plugin-ai-policy';

@ApiTags('Plugin Registry')
@ApiBearerAuth()
@Controller()
export class PluginRegistryController {
  constructor(
    @Inject(PluginRegistryService) private readonly registry: PluginRegistryService,
    @Inject(MarketplaceCommerceService) private readonly commerce: MarketplaceCommerceService,
    @Inject(MarketplaceDiscoveryService) private readonly discovery: MarketplaceDiscoveryService
  ) {}

  @RequirePermission('team.plugin.upload', 'team.plugin.edit_draft')
  @Post('plugin-registry/releases')
  @ApiOperation({ summary: '流式上传 .lfplugin v4 并发布不可变团队版本' })
  publish(
    @Req() req: Request,
    @Headers('x-plugin-package-id') packageId?: string,
    @Headers('content-length') contentLength?: string,
    @Headers('x-plugin-source-kind') sourceKind?: string,
    @Headers('x-plugin-source-label-b64') sourceLabelBase64?: string,
    @Headers('x-client') client?: string,
    @Headers('x-adaptation-report-id') adaptationReportId?: string
  ) {
    return this.registry.publishTeamRelease(
      requireUser(req).id,
      req,
      packageId,
      contentLength ? Number(contentLength) : undefined,
      {
        sourceKind,
        sourceLabelBase64,
        ingestChannel: client?.trim().toLowerCase() === 'desktop' ? 'DESKTOP' : 'API',
        adaptationReportId,
      }
    );
  }

  @RequirePermission('team.plugin.upload')
  @Post('plugin-registry/adaptation-reports')
  @ApiOperation({
    summary: '暂存适配报告换取 reportId（HTTP 头装不下含中文的完整 AdaptationReport）',
  })
  stageAdaptationReport(@Req() req: Request, @Body() body: StageAdaptationReportDto) {
    return this.registry.stageAdaptationReport(requireUser(req).id, body?.report);
  }

  // 干跑会做 AI 策略闸门扫描（成本/CPU 远高于普通查询），限速防脚本滥用。
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('team.plugin.upload')
  @Post('plugin-registry/adapt')
  @ApiOperation({
    summary: '适配检验改造干跑：仅 manifest 符号级校验 + AI 策略闸门（不执行插件、不装依赖）',
  })
  adaptDryRun(@Body() body: AdaptDryRunDto) {
    return this.registry.dryRunAdaptation(body.manifest, (body.files ?? []) as PluginAiPolicyFile[]);
  }

  @RequirePermission('team.plugin.list')
  @Get('plugin-registry/team')
  team(@Req() req: Request) {
    return this.registry.teamCatalog(requireUser(req).id);
  }

  @RequirePermission('team.plugin.list')
  @Get('plugin-registry/manage')
  manage(@Req() req: Request) {
    return this.registry.managementCatalog(requireUser(req).id);
  }

  @Get('plugin-registry/marketplace')
  marketplace(@Req() req: Request) {
    return this.discovery.catalogForTeam(requireUser(req).id);
  }

  @Get('plugin-packages/:id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.registry.packageDetail(requireUser(req).id, id);
  }

  @Get('plugin-releases/:id')
  releaseDetail(@Req() req: Request, @Param('id') id: string) {
    return this.registry.releaseDetail(requireUser(req).id, id);
  }

  @Get('plugin-releases/:id/workflow-upgrades')
  workflowUpgrades(@Req() req: Request, @Param('id') id: string) {
    return this.registry.workflowUpgradeSuggestions(requireUser(req).id, id);
  }

  @Get('plugin-releases/:id/artifact')
  async artifact(@Req() req: Request, @Res() res: Response, @Param('id') id: string) {
    const result = await this.registry.artifactDownload(
      requireUser(req).id,
      id,
      ensureRequestId(req)
    );
    if (result.download.kind === 'redirect') return res.redirect(302, result.download.url);
    res.setHeader('content-type', 'application/vnd.lingfang.plugin+zip');
    res.setHeader('content-length', String(result.download.sizeBytes));
    res.setHeader('x-plugin-sha256', result.release.sha256);
    res.setHeader(
      'content-disposition',
      `attachment; filename="${result.release.packageId}-${result.release.version}.lfplugin"`
    );
    result.download.stream.pipe(res);
  }

  @RequirePermission('team.plugin.submit_marketplace')
  @Post('plugin-releases/:id/submit-marketplace')
  submit(@Req() req: Request, @Param('id') id: string, @Body() body: SubmitMarketplaceDto) {
    return this.registry.submitMarketplace(requireUser(req).id, id, body?.priceCents);
  }

  @RequirePermission('team.plugin.submit_marketplace')
  @Post('plugin-releases/:id/withdraw-marketplace')
  withdraw(@Req() req: Request, @Param('id') id: string, @Body() body: PluginLifecycleReasonDto) {
    return this.registry.withdrawMarketplaceSubmission(requireUser(req).id, id, body?.reason || '');
  }

  @RequirePermission('team.plugin.edit_metadata')
  @Patch('plugin-packages/:id/status')
  packageStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: UpdatePluginPackageStatusDto
  ) {
    return this.registry.updatePackageStatus(requireUser(req).id, id, body.status);
  }

  @RequirePermission('team.plugin.edit_draft')
  @Patch('plugin-releases/:id/status')
  releaseStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: UpdatePluginReleaseStatusDto
  ) {
    return this.registry.updateReleaseStatus(requireUser(req).id, id, body.status);
  }

  @RequirePermission('team.plugin.submit_marketplace')
  @Patch('plugin-packages/:id/marketplace-status')
  marketplaceStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: UpdateMarketplaceListingStatusDto
  ) {
    return this.registry.updateOwnerMarketplaceStatus(
      requireUser(req).id,
      id,
      body.status,
      body.reason || ''
    );
  }

  @Post('plugin-packages/:id/runtime-access')
  runtimeAccess(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: PluginRuntimeAccessDto
  ) {
    return this.registry.runtimeAccess(requireUser(req).id, id, body.releaseId, body.sha256);
  }

  @Post('plugin-releases/:id/report-integrity-failure')
  integrityFailure(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { detail?: string }
  ) {
    return this.registry.reportIntegrityFailure(requireUser(req).id, id, body?.detail || '');
  }

  @RequirePermission('team.plugin.install')
  @Post('plugin-packages/:id/purchase')
  async purchase(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: MarketplacePurchaseDto
  ) {
    const disposition = await this.commerce.purchaseDisposition();
    if (disposition === 'LEGACY')
      return this.registry.purchase(requireUser(req).id, id, body.expectedPriceVersion);
    const result = await this.commerce.purchaseV2(requireUser(req).id, {
      packageId: id,
      expectedPriceVersion: body.expectedPriceVersion,
      idempotencyKey,
      campaignToken: body.campaignToken,
    });
    return { ...result, entitlementId: result.entitlement_id, purchaseId: result.purchase_id };
  }
}

@ApiTags('Admin Plugin Releases')
@ApiBearerAuth()
@Controller('admin/plugin-releases')
export class AdminPluginRegistryController {
  constructor(@Inject(PluginRegistryService) private readonly registry: PluginRegistryService) {}

  @RequirePermission('platform.plugin.list_all')
  @Get()
  list(@Req() req: Request) {
    return this.registry.adminReleases(requireUser(req).id);
  }

  @RequirePermission('platform.plugin.review')
  @Get('review-pending')
  pending(@Req() req: Request) {
    return this.registry.pendingReviews(requireUser(req).id);
  }

  @RequirePermission('platform.plugin.review')
  @Get(':id/artifact')
  async artifact(@Req() req: Request, @Res() res: Response, @Param('id') id: string) {
    const result = await this.registry.adminArtifactDownload(
      requireUser(req).id,
      id,
      ensureRequestId(req)
    );
    if (result.download.kind === 'redirect') return res.redirect(302, result.download.url);
    res.setHeader('content-type', 'application/vnd.lingfang.plugin+zip');
    res.setHeader('content-length', String(result.download.sizeBytes));
    res.setHeader('x-plugin-sha256', result.release.sha256);
    res.setHeader(
      'content-disposition',
      `attachment; filename="${result.release.packageId}-${result.release.version}.lfplugin"`
    );
    result.download.stream.pipe(res);
  }

  @RequirePermission('platform.plugin.list_all', 'platform.plugin.review')
  @Get(':id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.registry.adminReleaseCore(requireUser(req).id, id);
  }

  @RequirePermission('platform.plugin.list_all', 'platform.plugin.review')
  @Get(':id/manifest')
  manifest(@Req() req: Request, @Param('id') id: string) {
    return this.registry.adminReleaseManifest(requireUser(req).id, id);
  }

  @RequirePermission('platform.plugin.list_all', 'platform.plugin.review')
  @Get(':id/files')
  files(@Req() req: Request, @Param('id') id: string, @Query() query: AdminPluginPageQueryDto) {
    return this.registry.adminReleaseFiles(requireUser(req).id, id, query);
  }

  @RequirePermission('platform.plugin.list_all', 'platform.plugin.review')
  @Get(':id/reviews')
  reviews(@Req() req: Request, @Param('id') id: string, @Query() query: AdminPluginPageQueryDto) {
    return this.registry.adminReleaseReviews(requireUser(req).id, id, query);
  }

  @RequirePermission('platform.plugin.review')
  @Post(':id/approve')
  approve(@Req() req: Request, @Param('id') id: string) {
    return this.registry.approveRelease(requireUser(req).id, id);
  }

  @RequirePermission('platform.plugin.review')
  @Post(':id/reject')
  reject(@Req() req: Request, @Param('id') id: string, @Body() body: AdminPluginReasonDto) {
    return this.registry.rejectRelease(requireUser(req).id, id, body.reason);
  }

  @RequirePermission('platform.plugin.review')
  @Post(':id/delist')
  delist(@Req() req: Request, @Param('id') id: string, @Body() body: AdminPluginReasonDto) {
    return this.registry.delistRelease(requireUser(req).id, id, body.reason);
  }
}

@ApiTags('Admin Plugin Packages')
@ApiBearerAuth()
@Controller('admin/plugin-packages')
export class AdminPluginPackageController {
  constructor(@Inject(PluginRegistryService) private readonly registry: PluginRegistryService) {}

  @RequirePermission('platform.plugin.list_all')
  @Get()
  list(@Req() req: Request, @Query() query: AdminPluginPackageListQueryDto) {
    return this.registry.adminPackages(requireUser(req).id, query);
  }

  @RequirePermission('platform.plugin.list_all')
  @Get(':id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.registry.adminPackageDetail(requireUser(req).id, id);
  }

  @RequirePermission('platform.plugin.list_all')
  @Get(':id/releases')
  releases(@Req() req: Request, @Param('id') id: string, @Query() query: AdminPluginPageQueryDto) {
    return this.registry.adminPackageReleases(requireUser(req).id, id, query);
  }

  @RequirePermission('platform.plugin.review')
  @Post(':id/delist')
  delist(@Req() req: Request, @Param('id') id: string, @Body() body: AdminPluginReasonDto) {
    return this.registry.delistPackage(requireUser(req).id, id, body.reason);
  }

  @RequirePermission('platform.plugin.review')
  @Post(':id/relist')
  relist(@Req() req: Request, @Param('id') id: string, @Body() body: PluginLifecycleReasonDto) {
    return this.registry.updatePlatformMarketplaceStatus(
      requireUser(req).id,
      id,
      'ACTIVE',
      body?.reason || ''
    );
  }
}
