import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import { PluginRegistryService } from './plugin-registry.service';

@ApiTags('Plugin Registry')
@ApiBearerAuth()
@Controller()
export class PluginRegistryController {
  constructor(@Inject(PluginRegistryService) private readonly registry: PluginRegistryService) {}

  @RequirePermission('team.plugin.upload')
  @Post('plugin-registry/releases')
  @ApiOperation({ summary: '流式上传 .lfplugin v4 并发布不可变团队版本' })
  publish(
    @Req() req: Request,
    @Headers('x-plugin-package-id') packageId?: string,
    @Headers('content-length') contentLength?: string,
  ) {
    return this.registry.publishTeamRelease(requireUser(req).id, req, packageId, contentLength ? Number(contentLength) : undefined);
  }

  @RequirePermission('team.plugin.list')
  @Get('plugin-registry/team')
  team(@Req() req: Request) {
    return this.registry.teamCatalog(requireUser(req).id);
  }

  @Get('plugin-registry/marketplace')
  marketplace(@Req() req: Request) {
    return this.registry.marketplaceCatalog(requireUser(req).id);
  }

  @Get('plugin-packages/:id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.registry.packageDetail(requireUser(req).id, id);
  }

  @Get('plugin-releases/:id/artifact')
  async artifact(@Req() req: Request, @Res() res: Response, @Param('id') id: string) {
    const result = await this.registry.artifactDownload(requireUser(req).id, id);
    if (result.download.kind === 'redirect') return res.redirect(302, result.download.url);
    res.setHeader('content-type', 'application/vnd.lingfang.plugin+zip');
    res.setHeader('content-length', String(result.download.sizeBytes));
    res.setHeader('x-plugin-sha256', result.release.sha256);
    res.setHeader('content-disposition', `attachment; filename="${result.release.packageId}-${result.release.version}.lfplugin"`);
    result.download.stream.pipe(res);
  }

  @RequirePermission('team.plugin.submit_marketplace')
  @Post('plugin-releases/:id/submit-marketplace')
  submit(@Req() req: Request, @Param('id') id: string, @Body() body: { priceCents?: number }) {
    return this.registry.submitMarketplace(requireUser(req).id, id, body?.priceCents);
  }

  @Post('plugin-packages/:id/runtime-access')
  runtimeAccess(@Req() req: Request, @Param('id') id: string) {
    return this.registry.runtimeAccess(requireUser(req).id, id);
  }

  @Post('plugin-releases/:id/report-integrity-failure')
  integrityFailure(@Req() req: Request, @Param('id') id: string, @Body() body: { detail?: string }) {
    return this.registry.reportIntegrityFailure(requireUser(req).id, id, body?.detail || '');
  }

  @Post('plugin-packages/:id/purchase')
  purchase(@Req() req: Request, @Param('id') id: string) {
    return this.registry.purchase(requireUser(req).id, id);
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
  @Get(':id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.registry.reviewDetail(requireUser(req).id, id);
  }

  @RequirePermission('platform.plugin.review')
  @Post(':id/approve')
  approve(@Req() req: Request, @Param('id') id: string) {
    return this.registry.approveRelease(requireUser(req).id, id);
  }

  @RequirePermission('platform.plugin.review')
  @Post(':id/reject')
  reject(@Req() req: Request, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.registry.rejectRelease(requireUser(req).id, id, body?.reason || '');
  }

  @RequirePermission('platform.plugin.review')
  @Post(':id/delist')
  delist(@Req() req: Request, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.registry.delistRelease(requireUser(req).id, id, body?.reason || '');
  }
}
