import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { MarketplaceCategory, WebPluginCatalogQuery } from '@lingfang/contract';
import { AppError, Public, requireUser } from '../../common';
import { RequirePermission } from '../auth.decorators';
import { MarketplaceCommerceService } from '../marketplace-commerce.service';
import { MarketplaceCommerceQueryService } from '../marketplace-commerce-query.service';
import { MarketplaceOrderQueryDto, MarketplacePurchaseDto } from '../dto/marketplace-commerce.dto';
import { WebMarketplaceService } from './web-marketplace.service';

@ApiTags('Web Plugin Center')
@Controller('web/plugins')
export class WebMarketplaceController {
  constructor(
    @Inject(WebMarketplaceService) private readonly marketplace: WebMarketplaceService,
    @Inject(MarketplaceCommerceService) private readonly commerce: MarketplaceCommerceService,
    @Inject(MarketplaceCommerceQueryService)
    private readonly commerceQueries: MarketplaceCommerceQueryService
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: '匿名浏览公开插件目录' })
  catalog(@Query() query: Record<string, unknown>) {
    const parsed = WebPluginCatalogQuery.safeParse(query);
    if (!parsed.success) {
      throw new AppError(400, 'web_catalog_query_invalid', '插件目录筛选参数无效', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return this.marketplace.catalog(parsed.data);
  }

  @Public()
  @Get('discovery/home')
  @ApiOperation({ summary: '公开市场推荐分组（精选、分类热门、近期优质）' })
  async home(@Query('category') category?: string) {
    if (category !== undefined && !MarketplaceCategory.safeParse(category).success) {
      throw new AppError(400, 'web_catalog_category_invalid', '插件分类无效');
    }
    return this.marketplace.home(category);
  }

  @RequirePermission('team.balance.view')
  @Get('orders/current')
  orders(@Req() req: Request, @Query() query: MarketplaceOrderQueryDto) {
    return this.commerceQueries.buyerOrders(requireUser(req).id, query);
  }

  @RequirePermission('team.plugin.install')
  @Post(':packageId/purchase')
  purchase(
    @Req() req: Request,
    @Param('packageId') packageId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: MarketplacePurchaseDto
  ) {
    return this.commerce.purchaseV2(requireUser(req).id, {
      packageId,
      expectedPriceVersion: body.expectedPriceVersion,
      idempotencyKey,
      campaignToken: body.campaignToken,
    });
  }

  @Public()
  @Get(':packageId')
  @ApiOperation({ summary: '匿名查看公开插件详情' })
  detail(@Param('packageId') packageId: string) {
    if (!z.string().uuid().safeParse(packageId).success) {
      throw new AppError(400, 'web_plugin_id_invalid', '插件 packageId 无效');
    }
    return this.marketplace.detail(packageId);
  }
}
