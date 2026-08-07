import { Body, Controller, Headers, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { requireUser } from '../common';
import { DesktopExecutorSessionService } from './desktop-executor-session.service';
@ApiTags('DesktopExecutorSessions')
@ApiBearerAuth()
@Controller('api/workflows/desktop-executor-sessions')
export class DesktopExecutorSessionController {
  constructor(
    @Inject(DesktopExecutorSessionService) private readonly sessions: DesktopExecutorSessionService
  ) {}
  @Post() create(@Req() req: Request, @Body() body: { device_id: string; inventory: unknown[] }) {
    return this.sessions.create(requireUser(req).id, body.device_id, body.inventory);
  }
  @Post(':id/heartbeat') heartbeat(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('x-workflow-executor-token') token: string | undefined,
    @Body() body: { inventory: unknown[] }
  ) {
    return this.sessions.heartbeat(requireUser(req).id, id, token || '', body.inventory);
  }
  @Post(':id/revoke') revoke(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('x-workflow-executor-token') token: string | undefined
  ) {
    return this.sessions.revoke(requireUser(req).id, id, token);
  }
}
