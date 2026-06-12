import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { MarketplaceService } from './marketplace.service';

@ApiTags('Marketplace')
@ApiBearerAuth()
@Controller('marketplace')
export class MarketplaceController {
  constructor(@Inject(MarketplaceService) private readonly market: MarketplaceService) {}

  @Get('search')
  @ApiOperation({ summary: '搜索公共市场插件' })
  search(@Req() req: Request, @Query('q') q: string, @Query('sort') sort: string) {
    return this.market.search(requireUser(req).id, q || '', sort || 'installs');
  }

  @Get('plugins/:id')
  @ApiOperation({ summary: '市场插件详情' })
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.market.detail(requireUser(req).id, id);
  }

  @Post('install')
  @ApiOperation({ summary: '安装市场插件到当前团队' })
  install(@Req() req: Request, @Body() body: { plugin_id: string }) {
    return this.market.install(requireUser(req).id, body.plugin_id);
  }

  @Post('rate')
  @ApiOperation({ summary: '为市场插件评分（须先购买/安装）' })
  rate(@Req() req: Request, @Body() body: { plugin_id: string; score: number; comment?: string }) {
    return this.market.rate(requireUser(req).id, body.plugin_id, Number(body.score), body.comment || '');
  }
}