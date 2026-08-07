import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError, requireUser } from '../../common';
import { WebCloudTrialService } from './web-cloud-trial.service';

const ActionId = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const Uuid = z.string().uuid();

@Controller('web/plugin-actions')
export class WebCloudTrialController {
  constructor(@Inject(WebCloudTrialService) private readonly trials: WebCloudTrialService) {}
  @Post(':packageId/:actionId/preview')
  start(
    @Req() req: Request,
    @Param('packageId') packageId: string,
    @Param('actionId') actionId: string,
    @Body() body: unknown
  ) {
    if (!Uuid.safeParse(packageId).success || !ActionId.safeParse(actionId).success)
      throw new AppError(400, 'web_preview_target_invalid', 'Cloud Trial 目标无效');
    return this.trials.start(requireUser(req).id, packageId, actionId, body);
  }
  @Get('preview/:invocationId')
  get(@Req() req: Request, @Param('invocationId') invocationId: string) {
    assertInvocationId(invocationId);
    return this.trials.get(requireUser(req).id, invocationId);
  }
  @Post('preview/:invocationId/cancel')
  cancel(@Req() req: Request, @Param('invocationId') invocationId: string) {
    assertInvocationId(invocationId);
    return this.trials.cancel(requireUser(req).id, invocationId);
  }
}

function assertInvocationId(invocationId: string): void {
  if (!Uuid.safeParse(invocationId).success)
    throw new AppError(400, 'web_preview_invocation_id_invalid', 'Cloud Trial invocationId 无效');
}
