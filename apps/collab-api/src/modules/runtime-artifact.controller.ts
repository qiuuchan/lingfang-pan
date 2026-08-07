import { Body, Controller, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArtifactRefV1 } from '@lingfang/contract';
import type { Request } from 'express';
import { badRequest, requireUser } from '../common';
import { RuntimeArtifactService } from './runtime-artifact.service';

@ApiTags('PluginActionArtifacts')
@ApiBearerAuth()
@Controller('api/plugin-actions/invocations/:invocationId/artifacts')
export class RuntimeArtifactController {
  constructor(@Inject(RuntimeArtifactService) private readonly artifacts: RuntimeArtifactService) {}
  @Post()
  create(
    @Req() req: Request,
    @Param('invocationId') invocationId: string,
    @Body() body: { data_base64?: unknown; media_type?: unknown }
  ) {
    return this.artifacts.createFromInvocation(requireUser(req).id, invocationId, body ?? {});
  }
  @Post('materialize')
  materialize(
    @Req() req: Request,
    @Param('invocationId') invocationId: string,
    @Body() body: { artifact_ref?: unknown }
  ) {
    const ref = ArtifactRefV1.safeParse(body?.artifact_ref);
    if (!ref.success) throw badRequest('ArtifactRef 无效');
    return this.artifacts.materializeForInvocation(requireUser(req).id, invocationId, ref.data);
  }
  @Post('import')
  import(
    @Req() req: Request,
    @Param('invocationId') invocationId: string,
    @Body() body: { artifact_ref?: unknown }
  ) {
    const ref = ArtifactRefV1.safeParse(body?.artifact_ref);
    if (!ref.success) throw badRequest('ArtifactRef 无效');
    return this.artifacts.importForInvocation(requireUser(req).id, invocationId, ref.data);
  }
}
