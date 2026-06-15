import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { requireUser } from '../common';
import { EconomyService } from './economy.service';
import { PurchaseDto } from './dto/wallet.dto';

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(@Inject(EconomyService) private readonly economy: EconomyService) {}

  @Get()
  @ApiOperation({ summary: '当前用户钱包：余额与流水' })
  get(@Req() req: Request) {
    return this.economy.getWallet(requireUser(req).id);
  }

  @Post('purchase')
  // 购买限流 10 次/分钟/IP（Top9）：事务内多写（扣款+加款+purchase+2流水），高频放大 DB 负载。
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '购买市场付费插件（内部账本结算）' })
  purchase(@Req() req: Request, @Body() body: PurchaseDto) {
    return this.economy.purchase(requireUser(req).id, body.plugin_id);
  }
}