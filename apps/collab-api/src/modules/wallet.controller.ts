import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { requireUser } from '../common';
import { EconomyService } from './economy.service';
import { PurchaseDto } from './dto/wallet.dto';

// R2：个人钱包退役。`GET /api/wallet`（个人余额）已下线——余额改团队共享，
// 「团队钱包」页改用 /api/teams/current/balance(-ledger)。
// 仅保留 `POST /api/wallet/purchase`：路径不变（前端调用点无需改 URL），
// 但 service 内部已改为「团队余额扣款」（design §4 / §7 决策 5）。
@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(@Inject(EconomyService) private readonly economy: EconomyService) {}

  @Post('purchase')
  // 购买限流 10 次/分钟/IP（Top9）：事务内多写（扣款+加款+purchase+2流水），高频放大 DB 负载。
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '购买市场付费插件（团队余额结算）' })
  purchase(@Req() req: Request, @Body() body: PurchaseDto) {
    return this.economy.purchase(requireUser(req).id, body.plugin_id);
  }
}