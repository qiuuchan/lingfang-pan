// LLM 用户控制器：单 provider 云分发，无 provider 概念。
// 全局 JwtAuthGuard（security.ts），本控制器不额外声明 @Public。
// 所有方法经 requireUser(req).id 透传 service，鉴权在 service 内（ensureCurrentTeam/ensurePlatformAdmin）。
import { Body, Controller, Delete, Get, Inject, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { LlmService } from './llm.service';
import { BindingUpsertDto } from './dto/llm.dto';

@ApiTags('LLM')
@ApiBearerAuth()
@Controller('llm')
export class LlmController {
  // 显式 @Inject(LlmService) token，对齐项目既有 controller 约定（admin/wallet/release 均用显式 token）。
  // 简写注入依赖 emitDecoratorMetadata 反射，当模块内存在含异常依赖链的 provider（如 release）时，
  // 反射解析会拿错 token 导致 this.llm 为 undefined，运行时报 Cannot read 'getActiveProvider'。
  constructor(@Inject(LlmService) private readonly llm: LlmService) {}

  @Get('active-provider')
  @ApiOperation({ summary: '当前启用 provider（应用拉取模型用的 apiUrl + 默认模型）' })
  activeProvider(@Req() req: Request) {
    return this.llm.getActiveProvider(requireUser(req).id);
  }

  @Get('binding')
  @ApiOperation({ summary: '当前用户绑定（单条，脱敏，零解密）' })
  listBindings(@Req() req: Request) {
    return this.llm.listBindings(requireUser(req).id);
  }

  @Put('binding')
  @ApiOperation({ summary: '保存/更新当前用户绑定（按 userId 唯一）' })
  upsertBinding(@Req() req: Request, @Body() body: BindingUpsertDto) {
    return this.llm.upsertBinding(requireUser(req).id, body);
  }

  @Delete('binding')
  @ApiOperation({ summary: '删除当前用户绑定（按 userId 唯一）' })
  deleteBinding(@Req() req: Request) {
    return this.llm.deleteBinding(requireUser(req).id);
  }

  @Post('binding/decrypt')
  @ApiOperation({ summary: '解密当前用户 apiKey 明文供桌面 CLI 使用（按 userId 唯一，强审计）' })
  decryptKey(@Req() req: Request) {
    return this.llm.decryptBindingKey(requireUser(req).id);
  }
}
