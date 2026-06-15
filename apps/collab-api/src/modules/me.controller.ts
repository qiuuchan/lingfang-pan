import { Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { requireUser } from '../common';
import { MeService } from './me.service';
import { TeamService } from './team.service';

@ApiTags('Onboarding')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(
    @Inject(TeamService) private readonly team: TeamService,
    @Inject(MeService) private readonly me: MeService,
  ) {}

  @Get('onboarding')
  @ApiOperation({ summary: '获取本地客户端下一步状态' })
  onboarding(@Req() req: Request) {
    return this.team.onboarding(requireUser(req).id);
  }

  @Get('export')
  @ApiOperation({ summary: '导出当前用户全量数据（个人信息/插件/购买/钱包/团队）' })
  exportData(@Req() req: Request) {
    return this.me.exportMyData(requireUser(req).id);
  }

  @Post('delete-account')
  // 注销限流 3 次/分钟/IP：破坏性操作，防误触/轰炸；tokenVersion++ 作废 token 后前端需重新登录。
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: '注销当前账号（软删除：禁用 + 打码邮箱 + 作废 token）' })
  deleteAccount(@Req() req: Request) {
    return this.me.deleteMyAccount(requireUser(req).id);
  }
}
