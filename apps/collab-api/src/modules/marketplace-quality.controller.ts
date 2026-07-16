import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public, requireUser } from '../common';
import { RequirePermission } from './auth.decorators';
import {
  MarketplaceQualityAppealDto,
  MarketplaceFeatureDto,
  MarketplaceQualityRecomputeDto,
  MarketplaceQualityReasonDto,
  MarketplaceRatingDto,
  MarketplaceRatingListQueryDto,
} from './dto/marketplace-quality.dto';
import { MarketplaceQualityService } from './marketplace-quality.service';

@ApiTags('Marketplace Quality')
@ApiBearerAuth()
@Controller()
export class MarketplaceQualityController {
  constructor(@Inject(MarketplaceQualityService) private readonly quality: MarketplaceQualityService) {}

  @Public()
  @Get('marketplace/quality-policy')
  @ApiOperation({ summary: '公开市场质量规则 v1' })
  policy() { return this.quality.policy(); }

  @Put('plugin-packages/:id/marketplace-rating')
  @ApiOperation({ summary: '创建或更新当前团队评分' })
  rate(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplaceRatingDto) {
    return this.quality.rate(requireUser(req).id, id, body);
  }

  @Public()
  @Get('plugin-packages/:id/marketplace-ratings')
  @ApiOperation({ summary: '分页查看公开评分（不暴露团队或用户标识）' })
  ratings(@Param('id') id: string, @Query() query: MarketplaceRatingListQueryDto) {
    return this.quality.ratings(id, query);
  }

  @Get('plugin-packages/:id/quality')
  @ApiOperation({ summary: '作者团队查看当前质量快照和晋级缺口' })
  ownerQuality(@Req() req: Request, @Param('id') id: string) {
    return this.quality.ownerQuality(requireUser(req).id, id);
  }

  @Post('plugin-packages/:id/quality-appeals')
  @ApiOperation({ summary: '作者针对当前质量快照创建申诉工单' })
  appeal(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplaceQualityAppealDto) {
    return this.quality.appeal(requireUser(req).id, id, body.body);
  }

  @RequirePermission('platform.plugin.list_all', 'platform.plugin.review')
  @Post('admin/plugin-packages/:id/quality/recompute')
  @ApiOperation({ summary: '平台管理员对单个插件重新计算质量快照' })
  recompute(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplaceQualityRecomputeDto) {
    return this.quality.recompute(requireUser(req).id, id, body.requestId);
  }

  @RequirePermission('platform.plugin.edit')
  @Post('admin/plugin-packages/:id/feature')
  @ApiOperation({ summary: '平台管理员设置人工精选' })
  feature(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplaceFeatureDto) {
    return this.quality.feature(requireUser(req).id, id, body);
  }

  @RequirePermission('platform.plugin.edit')
  @Delete('admin/plugin-packages/:id/feature')
  @ApiOperation({ summary: '平台管理员取消人工精选' })
  unfeature(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplaceQualityReasonDto) {
    return this.quality.unfeature(requireUser(req).id, id, body.reason);
  }

  @RequirePermission('platform.plugin.edit')
  @Post('admin/plugin-packages/:id/quality-block')
  @ApiOperation({ summary: '平台管理员暂停自动优质资格' })
  block(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplaceQualityReasonDto) {
    return this.quality.setQualityBlocked(requireUser(req).id, id, true, body.reason);
  }

  @RequirePermission('platform.plugin.edit')
  @Delete('admin/plugin-packages/:id/quality-block')
  @ApiOperation({ summary: '平台管理员恢复自动优质资格' })
  unblock(@Req() req: Request, @Param('id') id: string, @Body() body: MarketplaceQualityReasonDto) {
    return this.quality.setQualityBlocked(requireUser(req).id, id, false, body.reason);
  }
}
