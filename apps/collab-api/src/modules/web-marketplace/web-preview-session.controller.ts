import { Body, Controller, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError, requireUser } from '../../common';
import { WebPreviewSessionService } from './web-preview-session.service';

@Controller('web/plugin-preview')
export class WebPreviewSessionController {
  constructor(
    @Inject(WebPreviewSessionService) private readonly previews: WebPreviewSessionService
  ) {}

  @Post(':packageId/sessions')
  create(@Req() req: Request, @Param('packageId') packageId: string) {
    if (!z.string().uuid().safeParse(packageId).success)
      throw new AppError(400, 'web_plugin_id_invalid', '插件 packageId 无效');
    return this.previews.create(requireUser(req).id, packageId);
  }

  @Post('sessions/:sessionId/consume')
  consume(@Req() req: Request, @Param('sessionId') sessionId: string, @Body() body: unknown) {
    const parsed = z
      .object({ nonce: z.string().min(32).max(256) })
      .strict()
      .safeParse(body);
    if (!parsed.success || !z.string().uuid().safeParse(sessionId).success)
      throw new AppError(400, 'web_preview_handshake_invalid', '预览握手参数无效');
    return this.previews.consume(requireUser(req).id, sessionId, parsed.data.nonce);
  }
}
