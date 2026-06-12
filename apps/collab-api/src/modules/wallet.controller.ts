import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { EconomyService } from './economy.service';

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
  @ApiOperation({ summary: '购买市场付费插件（内部账本结算）' })
  purchase(@Req() req: Request, @Body() body: { plugin_id: string }) {
    return this.economy.purchase(requireUser(req).id, body.plugin_id);
  }
}