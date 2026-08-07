import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type {
  WorkflowExecutorClaimRequest,
  WorkflowPreflightRequest,
  WorkflowRunCreateRequest,
  WorkflowRunListRequest,
  WorkflowRunStatus,
} from '@lingfang/contract';
import type { Request } from 'express';
import type { Response } from 'express';
import { badRequest, requireUser } from '../common';
import { WorkflowRunService } from './workflow-run.service';

type WorkflowRunStatusValue = WorkflowRunStatus;
const RUN_STATUSES = new Set<WorkflowRunStatusValue>([
  'PENDING',
  'RUNNING',
  'FAILING',
  'SUCCEEDED',
  'FAILED',
  'CANCELING',
  'CANCELED',
]);

@ApiTags('WorkflowRuns')
@ApiBearerAuth()
@Controller('api/workflows/runs')
export class WorkflowRunController {
  constructor(@Inject(WorkflowRunService) private readonly runs: WorkflowRunService) {}
  @Post('preflight') preflight(
    @Req() req: Request,
    @Headers('x-workflow-executor-token') token: string | undefined,
    @Body() body: WorkflowPreflightRequest
  ) {
    return this.runs.preflight(requireUser(req).id, body, token);
  }
  @Post() start(
    @Req() req: Request,
    @Headers('x-workflow-executor-token') token: string | undefined,
    @Body() body: WorkflowRunCreateRequest
  ) {
    return this.runs.start(requireUser(req).id, body, token);
  }
  @Get() list(
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string,
    @Query('status') rawStatus?: string
  ) {
    const parsedLimit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100)
      throw badRequest('工作流运行列表 limit 必须是 1-100 的整数');
    if (rawStatus && !RUN_STATUSES.has(rawStatus as WorkflowRunStatusValue))
      throw badRequest('工作流运行状态筛选无效');
    const query: WorkflowRunListRequest = {
      limit: parsedLimit,
      ...(cursor ? { cursor } : {}),
      ...(rawStatus ? { status: rawStatus as WorkflowRunStatusValue } : {}),
    };
    return this.runs.list(requireUser(req).id, query);
  }
  @Get(':id') get(@Req() req: Request, @Param('id') id: string) {
    return this.runs.get(requireUser(req).id, id);
  }
  @Get(':id/results/:artifactId') async result(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Param('artifactId') artifactId: string
  ) {
    const result = await this.runs.resultArtifact(requireUser(req).id, id, artifactId);
    if (result.download.kind === 'redirect') return res.redirect(302, result.download.url);
    res.setHeader('content-type', result.artifact.mediaType);
    res.setHeader('content-length', String(result.download.sizeBytes));
    res.setHeader('x-artifact-sha256', result.artifact.sha256);
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('content-disposition', `attachment; filename="${result.artifact.id}"`);
    result.download.stream.pipe(res);
  }
  @Post(':id/results/:artifactId/import') importPreview(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('artifactId') artifactId: string
  ) {
    return this.runs.importPreviewArtifact(requireUser(req).id, id, artifactId);
  }
  @Post(':id/cancel') cancel(@Req() req: Request, @Param('id') id: string) {
    return this.runs.cancel(requireUser(req).id, id);
  }
}

@ApiTags('WorkflowExecutor')
@ApiBearerAuth()
@Controller('api/workflows/executor')
export class WorkflowExecutorController {
  constructor(@Inject(WorkflowRunService) private readonly runs: WorkflowRunService) {}
  @Post('claim') claim(
    @Req() req: Request,
    @Headers('x-workflow-executor-token') session: string | undefined,
    @Body() body: WorkflowExecutorClaimRequest
  ) {
    return this.runs.claimReady(requireUser(req).id, body.run_id, session || '');
  }
  @Post('attempts/:id/heartbeat') heartbeat(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('x-workflow-executor-token') session: string | undefined,
    @Headers('x-workflow-attempt-lease-token') lease: string | undefined
  ) {
    return this.runs.heartbeatLease(requireUser(req).id, id, session || '', lease || '');
  }
  @Post('attempts/:id/complete') complete(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('x-workflow-executor-token') session: string | undefined,
    @Headers('x-workflow-attempt-lease-token') lease: string | undefined,
    @Body() body: { output: Record<string, unknown> }
  ) {
    return this.runs.completeLeased(
      requireUser(req).id,
      id,
      session || '',
      lease || '',
      body.output
    );
  }
  @Post('attempts/:id/fail') fail(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('x-workflow-executor-token') session: string | undefined,
    @Headers('x-workflow-attempt-lease-token') lease: string | undefined,
    @Body() body: { code?: string; message?: string }
  ) {
    return this.runs.failLeased(
      requireUser(req).id,
      id,
      session || '',
      lease || '',
      body.code || 'workflow_step_failed',
      body.message || '工作流步骤失败'
    );
  }
}
