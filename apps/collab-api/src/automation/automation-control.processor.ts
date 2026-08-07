import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common';
import { PrismaService } from '../prisma.service';
import { WorkflowRunService } from '../modules/workflow-run.service';
import type { AutomationConfig } from './automation-config';
import type { AutomationQueuePort } from './automation-queue';
import { AutomationSchedulerService } from './automation-scheduler.service';
import { AUTOMATION_CONFIG, AUTOMATION_QUEUE } from './automation.tokens';
import { CloudAbortBus } from './cloud-abort-bus';

export type AutomationControlCommand =
  | { name: 'schedule.upsert'; data: { schedule_id: string; generation: number } }
  | { name: 'schedule.remove'; data: { schedule_id: string; generation: number } }
  | { name: 'run.coordinate'; data: { run_id: string; generation: number } }
  | { name: 'run.cancel'; data: { run_id: string; generation: number } };

@Injectable()
export class AutomationControlProcessor {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTOMATION_CONFIG) private readonly config: AutomationConfig,
    @Inject(AUTOMATION_QUEUE) private readonly queue: AutomationQueuePort,
    private readonly scheduler: AutomationSchedulerService,
    private readonly runs: WorkflowRunService,
    private readonly abortBus: CloudAbortBus
  ) {}

  async process(command: AutomationControlCommand) {
    if (command.name === 'schedule.upsert') {
      if (!this.config.enabled || !this.config.schedulesEnabled)
        throw new AppError(503, 'cloud_disabled', '定时自动化当前已关闭');
      return this.scheduler.upsert(command.data.schedule_id, command.data.generation);
    }
    if (command.name === 'schedule.remove')
      return this.scheduler.remove(command.data.schedule_id, command.data.generation);

    const run = await this.prisma.workflowRun.findUnique({
      where: { id: command.data.run_id },
      include: { attempts: true },
    });
    if (!run || run.executionTarget !== 'CLOUD' || !run.principalUserId)
      return { outcome: 'STALE' as const };
    if (
      run.scheduleGeneration !== null &&
      command.data.generation !== 0 &&
      run.scheduleGeneration !== command.data.generation
    )
      return { outcome: 'STALE' as const };
    if (command.name === 'run.cancel') {
      await this.abortBus.broadcast({ kind: 'RUN', id: run.id, reason: 'workflow run canceled' });
      await this.runs.coordinateCloudCancellation(run.principalUserId, run.id);
      return { outcome: 'CANCELED' as const };
    }
    if (
      !this.config.enabled ||
      (run.triggerKind === 'SCHEDULE'
        ? !this.config.schedulesEnabled
        : !this.config.cloudManualEnabled)
    ) {
      await this.abortBus.broadcast({
        kind: 'KILL_SWITCH',
        id: '*',
        reason: 'cloud kill switch enabled',
      });
      await this.runs.cancel(run.principalUserId, run.id);
      await this.runs.coordinateCloudCancellation(run.principalUserId, run.id);
      return { outcome: 'DISABLED' as const };
    }
    await this.runs.coordinateCloud(run.principalUserId, run.id);
    const attempts = await this.prisma.workflowStepAttempt.findMany({
      where: {
        runId: run.id,
        status: 'RUNNING',
        actionInvocationId: { not: null },
        transportJobId: null,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let published = 0;
    for (const attempt of attempts) {
      await this.queue.publishAction({
        run_id: run.id,
        attempt_id: attempt.id,
        invocation_id: attempt.actionInvocationId!,
        plan_sha256: run.planSha256,
      });
      await this.prisma.workflowStepAttempt.updateMany({
        where: {
          id: attempt.id,
          runId: run.id,
          status: 'RUNNING',
          actionInvocationId: attempt.actionInvocationId,
          transportJobId: null,
        },
        data: { transportJobId: `action-${attempt.actionInvocationId}` },
      });
      published += 1;
    }
    return { outcome: 'COORDINATED' as const, published };
  }
}
