import { Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { clientUpgradeRequired } from '../common';

// R2：个人钱包退役。`GET /api/wallet`（个人余额）已下线——余额改团队共享，
// 「团队钱包」页改用 /api/teams/current/balance(-ledger)。
// 旧插件购买路径保留为明确的升级响应；v4 购买使用 /api/plugin-packages/:id/purchase。
@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  @Post('purchase')
  // 购买限流 10 次/分钟/IP（Top9）：事务内多写（扣款+加款+purchase+2流水），高频放大 DB 负载。
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '购买市场付费插件（团队余额结算）' })
  purchase() {
    throw clientUpgradeRequired();
  }
}
