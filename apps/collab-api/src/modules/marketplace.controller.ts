import { Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { clientUpgradeRequired } from '../common';

@ApiTags('Marketplace')
@ApiBearerAuth()
@Controller('marketplace')
export class MarketplaceController {
  @Get('search')
  @ApiOperation({ summary: '搜索公共市场插件' })
  search() {
    throw clientUpgradeRequired();
  }

  @Get('plugins/:id')
  @ApiOperation({ summary: '市场插件详情' })
  detail() {
    throw clientUpgradeRequired();
  }

  @Post('install')
  @ApiOperation({ summary: '安装市场插件到当前团队' })
  install() {
    throw clientUpgradeRequired();
  }

  @Post('rate')
  @ApiOperation({ summary: '为市场插件评分（须先购买/安装）' })
  rate() {
    throw clientUpgradeRequired();
  }
}
