import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { AutomationScheduleFireProcessor } from '../modules/automation-schedule-fire.processor';
import { CloudActionWorkerProcessor } from '../modules/cloud-action-worker.processor';
import { CloudPreviewWorkerProcessor } from '../modules/cloud-preview-worker.processor';
import type { AutomationConfig } from './automation-config';
import {
  AUTOMATION_CONTROL_QUEUE,
  automationRedisConnectionName,
  CLOUD_ACTION_QUEUE,
  type CloudActionJob,
} from './automation-queue';
import { AUTOMATION_CONFIG, AUTOMATION_QUEUE } from './automation.tokens';
import type { AutomationQueuePort } from './automation-queue';
import { AutomationControlProcessor } from './automation-control.processor';
import { CloudAbortBus } from './cloud-abort-bus';

export type AutomationConsumerJob = {
  name: string;
  data: Record<string, unknown>;
  opts: { prevMillis?: number; repeatJobKey?: string };
};
export type AutomationConsumerHandle = { close(): Promise<void> };
export type AutomationConsumerFactory = (
  queueName: string,
  handler: (job: AutomationConsumerJob) => Promise<unknown>,
  redisUrl: string,
  redisPrefix: string
) => AutomationConsumerHandle;

function defaultConsumerFactory(
  queueName: string,
  handler: (job: AutomationConsumerJob) => Promise<unknown>,
  redisUrl: string,
  redisPrefix: string
): AutomationConsumerHandle {
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: automationRedisConnectionName(`${queueName}-worker`, redisPrefix),
  });
  connection.on('error', () => undefined);
  const worker = new Worker(
    queueName,
    (job: Job) =>
      handler({
        name: job.name,
        data: job.data as Record<string, unknown>,
        opts: { prevMillis: job.opts.prevMillis, repeatJobKey: job.opts.repeatJobKey },
      }),
    { connection, prefix: redisPrefix }
  );
  worker.on('error', () => undefined);
  return {
    close: async () => {
      await worker.close();
      await connection.quit().catch(() => connection.disconnect(false));
    },
  };
}

export function createAutomationWorkerConsumers(
  config: AutomationConfig,
  handlers: {
    action: CloudActionWorkerProcessor;
    preview: CloudPreviewWorkerProcessor;
    schedule: AutomationScheduleFireProcessor;
    control: AutomationControlProcessor;
  },
  factory: AutomationConsumerFactory = defaultConsumerFactory,
  abortBus?: CloudAbortBus
): AutomationConsumerHandle[] {
  if (!config.runsWorker && !config.runsScheduler) return [];
  if (!config.redisUrl) throw new Error('automation worker requires AUTOMATION_REDIS_URL');
  const aborts =
    abortBus ??
    (factory === defaultConsumerFactory
      ? new CloudAbortBus(config)
      : ({
          run: async <T>(
            _run: string,
            _invocation: string,
            operation: (signal: AbortSignal) => Promise<T>
          ) => operation(new AbortController().signal),
          close: async () => undefined,
        } as CloudAbortBus));
  const control = factory(
    AUTOMATION_CONTROL_QUEUE,
    async (job) => {
      const data = job.data;
      if (job.name === 'schedule.repeat_fire')
        return handlers.schedule.process({
          kind: 'REPEAT',
          schedule_id: String(data.schedule_id),
          generation: Number(data.generation),
          scheduler_key: String(data.scheduler_key),
          prev_millis: Number(job.opts.prevMillis),
          repeat_job_key: String(job.opts.repeatJobKey),
        });
      if (job.name === 'schedule.once_fire')
        return handlers.schedule.process({
          kind: 'ONCE',
          schedule_id: String(data.schedule_id),
          generation: Number(data.generation),
          scheduler_key: String(data.scheduler_key),
          scheduled_for: String(data.scheduled_for),
          occurrence_key: String(data.occurrence_key),
        });
      if (job.name === 'schedule.upsert')
        return handlers.control.process({
          name: 'schedule.upsert',
          data: { schedule_id: String(data.schedule_id), generation: Number(data.generation) },
        });
      if (job.name === 'schedule.remove')
        return handlers.control.process({
          name: 'schedule.remove',
          data: { schedule_id: String(data.schedule_id), generation: Number(data.generation) },
        });
      if (job.name === 'run.coordinate')
        return handlers.control.process({
          name: 'run.coordinate',
          data: { run_id: String(data.run_id), generation: Number(data.generation) },
        });
      if (job.name === 'run.cancel')
        return handlers.control.process({
          name: 'run.cancel',
          data: { run_id: String(data.run_id), generation: Number(data.generation) },
        });
      return { outcome: 'IGNORED' };
    },
    config.redisUrl,
    config.redisPrefix
  );
  if (!config.runsWorker) return [control];
  const action = factory(
    CLOUD_ACTION_QUEUE,
    async (job) => {
      if (job.name !== 'action.invoke') return { outcome: 'IGNORED' };
      const data = job.data as CloudActionJob['data'];
      if (data.kind === 'STANDALONE_PREVIEW') return handlers.preview.process(data.invocation_id);
      const result = await aborts.run(data.run_id, data.invocation_id, (signal) =>
        handlers.action.process(data, signal)
      );
      await handlers.control.process({
        name: 'run.coordinate',
        data: { run_id: data.run_id, generation: 0 },
      });
      return result;
    },
    config.redisUrl,
    config.redisPrefix
  );
  return [
    control,
    {
      close: async () => {
        await action.close();
        await aborts.close();
      },
    },
  ];
}

@Injectable()
export class AutomationWorkerConsumers implements OnModuleInit, OnModuleDestroy {
  private handles: AutomationConsumerHandle[] = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly processId = `${process.pid}-${randomUUID()}`;
  private readonly heartbeatTtlMs = 15_000;
  constructor(
    @Inject(AUTOMATION_CONFIG) private readonly config: AutomationConfig,
    @Inject(AUTOMATION_QUEUE) private readonly queue: AutomationQueuePort,
    private readonly action: CloudActionWorkerProcessor,
    private readonly preview: CloudPreviewWorkerProcessor,
    private readonly schedule: AutomationScheduleFireProcessor,
    private readonly control: AutomationControlProcessor,
    private readonly abortBus: CloudAbortBus
  ) {}
  onModuleInit() {
    this.handles = createAutomationWorkerConsumers(
      this.config,
      {
        action: this.action,
        preview: this.preview,
        schedule: this.schedule,
        control: this.control,
      },
      defaultConsumerFactory,
      this.abortBus
    );
    if (this.config.runsWorker) {
      void this.heartbeat();
      this.heartbeatTimer = setInterval(() => void this.heartbeat(), 5_000);
      this.heartbeatTimer.unref?.();
    }
  }
  async onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.queue.removeWorkerHeartbeat(this.processId).catch(() => undefined);
    await Promise.allSettled(this.handles.map((handle) => handle.close()));
    this.handles = [];
  }
  private async heartbeat() {
    await this.queue
      .writeWorkerHeartbeat({
        process_id: this.processId,
        role: this.config.processRole === 'all' ? 'all' : 'worker',
        updated_at: new Date().toISOString(),
        ttl_ms: this.heartbeatTtlMs,
      })
      .catch(() => undefined);
  }
}
