// LLM 租户控制器：5 个 /api/llm/* 路由（design.md §4.2）。
// 全局 JwtAuthGuard（security.ts），本控制器不额外声明 @Public。
// 所有方法经 requireUser(req).id 透传 service，鉴权在 service 内（ensureCurrentTeam/ensureTeamAdmin）。
import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { LlmService } from './llm.service';
import { BindingUpsertDto } from './dto/llm.dto';

@ApiTags('LLM')
@ApiBearerAuth()
@Controller('llm')
export class LlmController {
  constructor(private readonly llm: LlmService) {}

  @Get('gateways')
  @ApiOperation({ summary: '网关目录（仅 ENABLED，租户选择用）' })
  gateways(@Req() req: Request) {
    return this.llm.listGatewaysForTenant(requireUser(req).id);
  }

  @Get('binding')
  @ApiOperation({ summary: '当前团队绑定列表（脱敏，零解密）' })
  listBindings(@Req() req: Request) {
    return this.llm.listBindings(requireUser(req).id);
  }

  @Put('binding')
  @ApiOperation({ summary: '保存/更新当前团队绑定（TEAM_ADMIN）' })
  upsertBinding(@Req() req: Request, @Body() body: BindingUpsertDto) {
    return this.llm.upsertBinding(requireUser(req).id, body);
  }

  @Delete('binding/:gatewayId')
  @ApiOperation({ summary: '删除当前团队指定网关绑定（TEAM_ADMIN）' })
  deleteBinding(@Req() req: Request, @Param('gatewayId') gatewayId: string) {
    return this.llm.deleteBinding(requireUser(req).id, gatewayId);
  }

  @Post('binding/:gatewayId/decrypt')
  @ApiOperation({ summary: '解密 apiKey 明文供桌面 CLI 使用（TEAM_ADMIN，强审计）' })
  decryptKey(@Req() req: Request, @Param('gatewayId') gatewayId: string) {
    return this.llm.decryptBindingKey(requireUser(req).id, gatewayId);
  }
}
