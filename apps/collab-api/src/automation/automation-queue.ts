import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import type { AutomationConfig } from './automation-config';
import type { ClaimedAutomationOutbox } from './automation-outbox.service';

export const AUTOMATION_CONTROL_QUEUE = 'lf-automation-control';
export const CLOUD_ACTION_QUEUE = 'lf-cloud-action';

export type AutomationControlJob =
  | { name: 'schedule.upsert'; data: { schedule_id: string; generation: number }; jobId: string }
  | { name: 'schedule.remove'; data: { schedule_id: string; generation: number }; jobId: string }
  | { name: 'run.coordinate'; data: { run_id: string; generation: number }; jobId: string }
  | { name: 'run.cancel'; data: { run_id: string; generation: number }; jobId: string };

export type CloudActionJob = {
  name: 'action.invoke';
  data:
    | {
        kind?: 'WORKFLOW_ATTEMPT';
        run_id: string;
        attempt_id: string;
        invocation_id: string;
        plan_sha256: string;
      }
    | { kind: 'STANDALONE_PREVIEW'; invocation_id: string };
  jobId: string;
};

export type AutomationRedisReadiness = {
  status: 'disabled' | 'api_only' | 'ready' | 'degraded';
  redis: 'not_required' | 'up' | 'down';
  persistence: 'not_required' | 'safe' | 'unsafe' | 'unknown';
  evictionPolicy: 'not_required' | 'noeviction' | 'unsafe' | 'unknown';
};
export type AutomationWorkerHeartbeat = {
  process_id: string;
  role: 'worker' | 'all';
  updated_at: string;
  ttl_ms: number;
};

export interface AutomationQueuePort {
  readonly connected: boolean;
  publishOutbox(row: ClaimedAutomationOutbox): Promise<void>;
  publishAction(job: CloudActionJob['data']): Promise<void>;
  checkReadiness(): Promise<AutomationRedisReadiness>;
  writeWorkerHeartbeat(heartbeat: AutomationWorkerHeartbeat): Promise<void>;
  listWorkerHeartbeats(): Promise<AutomationWorkerHeartbeat[]>;
  removeWorkerHeartbeat(processId: string): Promise<void>;
  close(): Promise<void>;
}

export function classifyAutomationRedisPolicy(input: {
  appendOnly?: string;
  savePolicy?: string;
  maxmemoryPolicy?: string;
}): Pick<AutomationRedisReadiness, 'status' | 'persistence' | 'evictionPolicy'> {
  const persistence =
    input.appendOnly === 'yes' || Boolean(input.savePolicy?.trim())
      ? ('safe' as const)
      : input.appendOnly !== undefined || input.savePolicy !== undefined
        ? ('unsafe' as const)
        : ('unknown' as const);
  const evictionPolicy =
    input.maxmemoryPolicy === 'noeviction'
      ? ('noeviction' as const)
      : input.maxmemoryPolicy
        ? ('unsafe' as const)
        : ('unknown' as const);
  return {
    status: persistence === 'safe' && evictionPolicy === 'noeviction' ? 'ready' : 'degraded',
    persistence,
    evictionPolicy,
  };
}

function deterministicJobId(kind: string, aggregateId: string, generation: number): string {
  const digest = createHash('sha256')
    .update(`${kind}\0${aggregateId}\0${generation}`)
    .digest('hex')
    .slice(0, 32);
  return `lf-${kind.toLowerCase().replace(/_/g, '-')}-${digest}`;
}

export function automationRedisConnectionName(scope: string, prefix: string): string {
  const safeScope = scope
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 36);
  const prefixDigest = createHash('sha256').update(prefix).digest('hex').slice(0, 12);
  return `lingfang-${safeScope}-${prefixDigest}`;
}

export function automationControlJob(row: ClaimedAutomationOutbox): AutomationControlJob {
  const generation = Math.max(0, Math.trunc(row.generation));
  switch (row.kind) {
    case 'UPSERT_SCHEDULE':
      return {
        name: 'schedule.upsert',
        data: { schedule_id: row.aggregateId, generation },
        jobId: deterministicJobId(row.kind, row.aggregateId, generation),
      };
    case 'REMOVE_SCHEDULE':
      return {
        name: 'schedule.remove',
        data: { schedule_id: row.aggregateId, generation },
        jobId: deterministicJobId(row.kind, row.aggregateId, generation),
      };
    case 'ENQUEUE_RUN':
      return {
        name: 'run.coordinate',
        data: { run_id: row.aggregateId, generation },
        jobId: deterministicJobId(row.kind, row.aggregateId, generation),
      };
    case 'ENQUEUE_ACTION':
      throw new Error('ENQUEUE_ACTION must be published through the action queue');
    case 'CANCEL_RUN':
      return {
        name: 'run.cancel',
        data: { run_id: row.aggregateId, generation },
        jobId: deterministicJobId(row.kind, row.aggregateId, generation),
      };
  }
}

class DisabledAutomationQueueAdapter implements AutomationQueuePort {
  readonly connected = false;

  constructor(private readonly config: AutomationConfig) {}

  async publishOutbox(): Promise<void> {
    throw new Error('automation_queue_not_available_for_process_role');
  }
  async publishAction(): Promise<void> {
    throw new Error('automation_queue_not_available_for_process_role');
  }
  async close(): Promise<void> {}
  async writeWorkerHeartbeat(): Promise<void> {}
  async listWorkerHeartbeats(): Promise<AutomationWorkerHeartbeat[]> {
    return [];
  }
  async removeWorkerHeartbeat(): Promise<void> {}
  async checkReadiness(): Promise<AutomationRedisReadiness> {
    return {
      status: this.config.enabled ? 'api_only' : 'disabled',
      redis: 'not_required',
      persistence: 'not_required',
      evictionPolicy: 'not_required',
    };
  }
}

export type AutomationQueueFactory = (config: AutomationConfig) => AutomationQueuePort;

export function createAutomationQueueAdapter(
  config: AutomationConfig,
  factory: AutomationQueueFactory = (value) => new BullMqAutomationQueueAdapter(value)
): AutomationQueuePort {
  if (!config.connectsToRedis || !config.redisUrl)
    return new DisabledAutomationQueueAdapter(config);
  return factory(config);
}

@Injectable()
export class BullMqAutomationQueueAdapter implements AutomationQueuePort, OnModuleDestroy {
  readonly connected = true;
  private readonly redis: IORedis;
  private readonly controlQueue: Queue;
  private readonly actionQueue: Queue;
  private lastReadyAt = 0;

  constructor(config: AutomationConfig) {
    if (!config.connectsToRedis || !config.redisUrl)
      throw new Error('BullMQ automation adapter requires an infrastructure process role');
    this.redis = new IORedis(config.redisUrl, {
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
      connectionName: automationRedisConnectionName(
        `automation-${config.processRole}`,
        config.redisPrefix
      ),
    });
    this.redis.on('error', () => undefined);
    const connection = this.redis;
    this.controlQueue = new Queue(AUTOMATION_CONTROL_QUEUE, {
      connection,
      prefix: config.redisPrefix,
    });
    this.actionQueue = new Queue(CLOUD_ACTION_QUEUE, { connection, prefix: config.redisPrefix });
  }

  private heartbeatKey(processId: string): string {
    return `${this.controlQueue.opts.prefix}:worker-heartbeat:${processId}`;
  }

  async writeWorkerHeartbeat(heartbeat: AutomationWorkerHeartbeat): Promise<void> {
    await this.redis.set(
      this.heartbeatKey(heartbeat.process_id),
      JSON.stringify(heartbeat),
      'PX',
      heartbeat.ttl_ms
    );
  }

  async listWorkerHeartbeats(): Promise<AutomationWorkerHeartbeat[]> {
    const keys = await this.scanKeys(`${this.controlQueue.opts.prefix}:worker-heartbeat:*`);
    if (!keys.length) return [];
    const values = await this.redis.mget(...keys);
    return values.flatMap((value) => {
      try {
        return value ? [JSON.parse(value) as AutomationWorkerHeartbeat] : [];
      } catch {
        return [];
      }
    });
  }

  async removeWorkerHeartbeat(processId: string): Promise<void> {
    await this.redis.del(this.heartbeatKey(processId));
  }

  async publishOutbox(row: ClaimedAutomationOutbox): Promise<void> {
    await this.assertReadyForPublish();
    const job = automationControlJob(row);
    await this.controlQueue.add(job.name, job.data, {
      jobId: job.jobId,
      attempts: 1,
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
  }

  async publishAction(data: CloudActionJob['data']): Promise<void> {
    await this.assertReadyForPublish();
    const jobId = deterministicJobId('ACTION_INVOKE', data.invocation_id, 0);
    await this.actionQueue.add('action.invoke', data, {
      jobId,
      attempts: 1,
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
  }

  async checkReadiness(): Promise<AutomationRedisReadiness> {
    const probeKey = `lf:automation:readiness:${randomUUID()}`;
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      if ((await this.redis.ping()) !== 'PONG') throw new Error('redis_ping_failed');
      await this.redis.set(probeKey, '1', 'PX', 10_000);
      if ((await this.redis.get(probeKey)) !== '1') throw new Error('redis_probe_failed');
      await this.redis.del(probeKey);
      const [appendOnlyConfig, saveConfig, evictionConfig] = await Promise.all([
        this.redis.config('GET', 'appendonly').catch(() => [] as string[]),
        this.redis.config('GET', 'save').catch(() => [] as string[]),
        this.redis.config('GET', 'maxmemory-policy').catch(() => [] as string[]),
      ]);
      const appendOnly = Array.isArray(appendOnlyConfig) ? appendOnlyConfig[1] : undefined;
      const savePolicy = Array.isArray(saveConfig) ? saveConfig[1] : undefined;
      const policy = Array.isArray(evictionConfig) ? evictionConfig[1] : undefined;
      return {
        ...classifyAutomationRedisPolicy({ appendOnly, savePolicy, maxmemoryPolicy: policy }),
        redis: 'up',
      };
    } catch {
      await this.redis.del(probeKey).catch(() => undefined);
      return {
        status: 'degraded',
        redis: 'down',
        persistence: 'unknown',
        evictionPolicy: 'unknown',
      };
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.controlQueue.close(), this.actionQueue.close()]);
    if (this.redis.status === 'wait' || this.redis.status === 'end') this.redis.disconnect(false);
    else await this.redis.quit().catch(() => this.redis.disconnect(false));
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private async assertReadyForPublish(): Promise<void> {
    if (Date.now() - this.lastReadyAt < 30_000) return;
    const readiness = await this.checkReadiness();
    if (readiness.status !== 'ready') throw new Error('automation_redis_not_ready');
    this.lastReadyAt = Date.now();
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    let cursor = '0';
    const keys: string[] = [];
    do {
      const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');
    return keys;
  }
}
