// RelayController —— /api/relay/v1/* 模型中转端点（@Public，由 DualAuthGuard 鉴权）。
//
// 设计（见 docs/billing-and-relay-design.md §4.1）：
//  - @Public() 跳过全局 JwtAuthGuard；DualAuthGuard 已在它之前注册，对 /api/relay 路径完成
//    「平台 API Key 或 JWT」双鉴权，并把结果挂在 req.relayAuth。
//  - 收紧限流：relay 是计费咽喉，默认 60/min 过宽，收紧到 30/min/IP（防刷灵石）。
//  - body 透传给 RelayService（按协议 shape 处理），class-validator 不强约束（保留上游兼容字段）。
import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../common';
import { Throttle } from '@nestjs/throttler';
import { RelayService } from './relay.service';

@ApiTags('Relay')
@Controller('relay/v1')
@Public()
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class RelayController {
  constructor(@Inject(RelayService) private readonly relay: RelayService) {}

  @Get('models')
  @ApiOperation({ summary: '列出可用模型版本（仅快速版/高级版）' })
  models(@Req() req: Request) {
    return this.relay.listModels(req);
  }

  @Post('chat/completions')
  @ApiOperation({ summary: 'OpenAI 兼容聊天转发（计费 + 日志）' })
  chatCompletions(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: Record<string, unknown>) {
    return this.relay.chatCompletions(req, res, body);
  }

  @Post('messages')
  @ApiOperation({ summary: 'Anthropic 兼容消息转发（计费 + 日志）' })
  messages(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: Record<string, unknown>) {
    return this.relay.messages(req, res, body);
  }

  @Post('images/generations')
  @ApiOperation({ summary: 'AI 生图转发（按张计费）' })
  images(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: Record<string, unknown>) {
    return this.relay.imageGenerations(req, res, body);
  }

  @Post('images/edits')
  @ApiOperation({ summary: 'AI 生图编辑转发（multipart 透传，按张计费）' })
  imageEdits(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // multipart：body 不能用 @Body（已读为原始 buffer），由 service 处理 rawBody。
    return this.relay.imageEditsPassthrough(req, res);
  }
}
