import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AutomationOutboxDispatcher } from './automation-outbox-dispatcher';
import { resolveAutomationConfig } from './automation-config';
import {
  AUTOMATION_CONTROL_QUEUE,
  automationRedisConnectionName,
  BullMqAutomationQueueAdapter,
  CLOUD_ACTION_QUEUE,
} from './automation-queue';
import {
  createAutomationWorkerConsumers,
  type AutomationConsumerHandle,
} from './automation-worker-consumers';
import { CloudExecutionQuotaService } from '../modules/cloud-execution-quota.service';
import { CloudAbortBus } from './cloud-abort-bus';

const TEST_REDIS_URL = process.env.AUTOMATION_TEST_REDIS_URL?.trim();
const redisDescribe = TEST_REDIS_URL ? describe : describe.skip;
const resources: Array<() => Promise<unknown>> = [];
let admin: IORedis;
let redisPrefix = '';

function register(close: () => Promise<unknown>): void {
  resources.push(close);
}

async function waitFor(assertion: () => void, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError;
}

async function cleanupOwnedKeys(): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await admin.scan(cursor, 'MATCH', `${redisPrefix}:*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await admin.unlink(...keys);
  } while (cursor !== '0');
}

function config(role: 'dispatcher' | 'worker') {
  return resolveAutomationConfig({
    AUTOMATION_ENABLED: 'true',
    CLOUD_MANUAL_ENABLED: 'true',
    SCHEDULES_ENABLED: 'true',
    AUTOMATION_PROCESS_ROLE: role,
    AUTOMATION_REDIS_URL: TEST_REDIS_URL,
    AUTOMATION_REDIS_PREFIX: redisPrefix,
  });
}

redisDescribe('automation Redis integration', () => {
  beforeAll(async () => {
    const parsed = new URL(TEST_REDIS_URL!);
    const db = Number(parsed.pathname.slice(1));
    if (!Number.isInteger(db) || db < 1)
      throw new Error('AUTOMATION_TEST_REDIS_URL must select a dedicated non-zero Redis DB');
    redisPrefix =
      process.env.AUTOMATION_TEST_REDIS_PREFIX?.trim() ||
      `lf:automation:test:${process.pid}-${randomUUID()}`;
    if (!redisPrefix.startsWith('lf:automation:test:'))
      throw new Error('AUTOMATION_TEST_REDIS_PREFIX must start with lf:automation:test:');
    admin = new IORedis(TEST_REDIS_URL!, {
      connectionName: automationRedisConnectionName('integration-admin', redisPrefix),
    });
    admin.on('error', () => undefined);
    expect(await admin.ping()).toBe('PONG');
    await cleanupOwnedKeys();
  }, 20_000);

  afterEach(async () => {
    await Promise.allSettled(
      resources
        .splice(0)
        .reverse()
        .map((close) => close())
    );
    await cleanupOwnedKeys();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (!admin) return;
    await cleanupOwnedKeys();
    await admin.quit().catch(() => admin.disconnect(false));
  });

  it('publishes an outbox row through real BullMQ and suppresses duplicate delivery', async () => {
    const received: Array<{ name: string; data: unknown }> = [];
    const connection = new IORedis(TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    const worker = new Worker(
      AUTOMATION_CONTROL_QUEUE,
      async (job) => {
        received.push({ name: job.name, data: job.data });
      },
      { connection, prefix: redisPrefix }
    );
    register(async () => {
      await worker.close();
      await connection.quit().catch(() => connection.disconnect(false));
    });
    await worker.waitUntilReady();

    const queue = new BullMqAutomationQueueAdapter(config('dispatcher'));
    register(() => queue.close());
    const claimed = {
      id: 'outbox-1',
      kind: 'ENQUEUE_RUN' as const,
      aggregateId: 'run-1',
      generation: 7,
      payload: { secret: 'never-queued' },
      attempts: 1,
      lockedUntil: new Date(),
    };
    const outbox = {
      claim: vi.fn(async () => [claimed]),
      complete: vi.fn(async () => true),
      fail: vi.fn(),
    };
    const dispatcher = new AutomationOutboxDispatcher(config('dispatcher'), queue, outbox as never);

    await expect(dispatcher.dispatchOnce('redis-worker')).resolves.toMatchObject({ delivered: 1 });
    await waitFor(() => expect(received).toHaveLength(1));
    await expect(dispatcher.dispatchOnce('redis-worker')).resolves.toMatchObject({ delivered: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toEqual([
      { name: 'run.coordinate', data: { run_id: 'run-1', generation: 7 } },
    ]);
    expect(JSON.stringify(received)).not.toContain('never-queued');
  });

  it('tracks two bounded worker heartbeats, expires stale workers, and recovers on refresh', async () => {
    const observer = new BullMqAutomationQueueAdapter(config('worker'));
    const workerA = new BullMqAutomationQueueAdapter(config('worker'));
    const workerB = new BullMqAutomationQueueAdapter(config('worker'));
    register(() => observer.close());
    register(() => workerA.close());
    register(() => workerB.close());
    const heartbeat = (processId: string, ttlMs: number) => ({
      process_id: processId,
      role: 'worker' as const,
      updated_at: new Date().toISOString(),
      ttl_ms: ttlMs,
    });
    await Promise.all([
      workerA.writeWorkerHeartbeat(heartbeat('worker-a', 150)),
      workerB.writeWorkerHeartbeat(heartbeat('worker-b', 150)),
    ]);
    await expect(observer.listWorkerHeartbeats()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ process_id: 'worker-a' }),
        expect.objectContaining({ process_id: 'worker-b' }),
      ])
    );
    await new Promise((resolve) => setTimeout(resolve, 220));
    await expect(observer.listWorkerHeartbeats()).resolves.toEqual([]);
    await workerA.writeWorkerHeartbeat(heartbeat('worker-a', 1_000));
    await expect(observer.listWorkerHeartbeats()).resolves.toEqual([
      expect.objectContaining({ process_id: 'worker-a', role: 'worker' }),
    ]);
  });

  it('routes action jobs to the processor once for duplicate transport publication', async () => {
    const action = { process: vi.fn(async () => ({ outcome: 'SUCCEEDED' })) };
    const preview = { process: vi.fn(async () => ({ outcome: 'SUCCEEDED' })) };
    const schedule = { process: vi.fn(async () => ({ outcome: 'CREATED' })) };
    const control = { process: vi.fn(async () => ({ outcome: 'COORDINATED' })) };
    const handles = createAutomationWorkerConsumers(config('worker'), {
      action: action as never,
      preview: preview as never,
      schedule: schedule as never,
      control: control as never,
    });
    register(async () => {
      await Promise.allSettled(handles.map((handle: AutomationConsumerHandle) => handle.close()));
    });
    const queue = new BullMqAutomationQueueAdapter(config('dispatcher'));
    register(() => queue.close());
    const job = {
      run_id: 'run-action',
      attempt_id: 'attempt-1',
      invocation_id: 'invocation-1',
      plan_sha256: 'a'.repeat(64),
    };

    await queue.publishAction(job);
    await queue.publishAction(job);
    await waitFor(() => expect(action.process).toHaveBeenCalledTimes(1));
    expect(action.process).toHaveBeenCalledWith(job, expect.any(AbortSignal));
  });

  it('suppresses duplicate schedule fire jobs before the schedule processor', async () => {
    const action = { process: vi.fn(async () => ({ outcome: 'SUCCEEDED' })) };
    const preview = { process: vi.fn(async () => ({ outcome: 'SUCCEEDED' })) };
    const schedule = { process: vi.fn(async () => ({ outcome: 'CREATED' })) };
    const control = { process: vi.fn(async () => ({ outcome: 'COORDINATED' })) };
    const handles = createAutomationWorkerConsumers(config('worker'), {
      action: action as never,
      preview: preview as never,
      schedule: schedule as never,
      control: control as never,
    });
    register(async () => {
      await Promise.allSettled(handles.map((handle) => handle.close()));
    });
    const connection = new IORedis(TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    const queue = new Queue(AUTOMATION_CONTROL_QUEUE, { connection, prefix: redisPrefix });
    register(async () => {
      await queue.close();
      await connection.quit().catch(() => connection.disconnect(false));
    });
    const data = {
      schedule_id: 'schedule-1',
      generation: 3,
      scheduler_key: 'schedule-schedule-1-g3',
      scheduled_for: '2026-07-16T08:00:00.000Z',
      occurrence_key: 'occurrence-1',
    };

    await queue.add('schedule.once_fire', data, {
      jobId: 'schedule-once-dedup',
      removeOnComplete: 100,
    });
    await queue.add('schedule.once_fire', data, {
      jobId: 'schedule-once-dedup',
      removeOnComplete: 100,
    });
    await waitFor(() => expect(schedule.process).toHaveBeenCalledTimes(1));
    expect(schedule.process).toHaveBeenCalledWith({ kind: 'ONCE', ...data });
  });

  it('recovers owned BullMQ clients after an exact client disconnect', async () => {
    const action = { process: vi.fn(async () => ({ outcome: 'SUCCEEDED' })) };
    const preview = { process: vi.fn(async () => ({ outcome: 'SUCCEEDED' })) };
    const schedule = { process: vi.fn(async () => ({ outcome: 'CREATED' })) };
    const control = { process: vi.fn(async () => ({ outcome: 'COORDINATED' })) };
    const handles = createAutomationWorkerConsumers(config('worker'), {
      action: action as never,
      preview: preview as never,
      schedule: schedule as never,
      control: control as never,
    });
    register(async () => {
      await Promise.allSettled(handles.map((handle) => handle.close()));
    });
    const queue = new BullMqAutomationQueueAdapter(config('dispatcher'));
    register(() => queue.close());
    await queue.publishAction({
      run_id: 'run-before',
      attempt_id: 'attempt-before',
      invocation_id: 'invocation-before',
      plan_sha256: 'b'.repeat(64),
    });
    await waitFor(() => expect(action.process).toHaveBeenCalledTimes(1));

    const ownedNames = new Set([
      automationRedisConnectionName('automation-dispatcher', redisPrefix),
      automationRedisConnectionName(`${CLOUD_ACTION_QUEUE}-worker`, redisPrefix),
    ]);
    const clientList = String(await admin.client('LIST'));
    const ownedIds = clientList
      .split('\n')
      .filter(Boolean)
      .map((line) => Object.fromEntries(line.split(' ').map((part) => part.split('=', 2))))
      .filter((client) => ownedNames.has(client.name))
      .map((client) => client.id);
    expect(ownedIds.length).toBeGreaterThan(0);
    for (const id of ownedIds) await admin.client('KILL', 'ID', id);

    await queue.publishAction({
      run_id: 'run-after',
      attempt_id: 'attempt-after',
      invocation_id: 'invocation-after',
      plan_sha256: 'c'.repeat(64),
    });
    await waitFor(() => expect(action.process).toHaveBeenCalledTimes(2), 15_000);
  }, 25_000);

  it('enforces endpoint concurrency and rate leases atomically in real Redis', async () => {
    const quota = new CloudExecutionQuotaService({} as never, config('worker'), admin);
    const release = await quota.acquireEndpoint(
      {
        id: 'deployment-concurrency',
        maxConcurrency: 1,
        rateLimitPerMinute: 10,
        timeoutMs: 30_000,
      },
      'invocation-1'
    );
    await expect(
      quota.acquireEndpoint(
        {
          id: 'deployment-concurrency',
          maxConcurrency: 1,
          rateLimitPerMinute: 10,
          timeoutMs: 30_000,
        },
        'invocation-2'
      )
    ).rejects.toMatchObject({ code: 'cloud_quota_exceeded' });
    await release();
    const releaseAfter = await quota.acquireEndpoint(
      {
        id: 'deployment-concurrency',
        maxConcurrency: 1,
        rateLimitPerMinute: 10,
        timeoutMs: 30_000,
      },
      'invocation-2'
    );
    await releaseAfter();

    const releaseRate = await quota.acquireEndpoint(
      { id: 'deployment-rate', maxConcurrency: 2, rateLimitPerMinute: 1, timeoutMs: 30_000 },
      'invocation-3'
    );
    await releaseRate();
    await expect(
      quota.acquireEndpoint(
        { id: 'deployment-rate', maxConcurrency: 2, rateLimitPerMinute: 1, timeoutMs: 30_000 },
        'invocation-4'
      )
    ).rejects.toMatchObject({ code: 'cloud_quota_exceeded' });
  });

  it('broadcasts an in-flight HTTPS abort to two worker processes and keeps late completion stale', async () => {
    const workerA = new CloudAbortBus(config('worker'));
    const workerB = new CloudAbortBus(config('worker'));
    const coordinator = new CloudAbortBus(config('dispatcher'));
    register(() => workerA.close());
    register(() => workerB.close());
    register(() => coordinator.close());
    await Promise.all([workerA.start(), workerB.start(), coordinator.start()]);
    const terminal = {
      status: 'RUNNING' as 'RUNNING' | 'CANCELED' | 'SUCCEEDED',
      completionCasRejected: 0,
    };
    const inFlight = (bus: CloudAbortBus, invocation: string) =>
      bus.run(
        'run-abort-1',
        invocation,
        (signal) =>
          new Promise<'CANCELED'>((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                terminal.status = 'CANCELED';
                resolve('CANCELED');
              },
              { once: true }
            )
          )
      );
    const requests = [inFlight(workerA, 'invocation-a'), inFlight(workerB, 'invocation-b')];
    await waitFor(() => {
      expect(workerA.metrics().active_abort_controllers).toBe(1);
      expect(workerB.metrics().active_abort_controllers).toBe(1);
    });
    expect(
      await coordinator.broadcast({
        kind: 'RUN',
        id: 'run-abort-1',
        reason: 'user canceled workflow',
      })
    ).toBeGreaterThanOrEqual(2);
    await expect(Promise.all(requests)).resolves.toEqual(['CANCELED', 'CANCELED']);
    const lateComplete = () => {
      if (terminal.status !== 'RUNNING') {
        terminal.completionCasRejected += 1;
        return false;
      }
      terminal.status = 'SUCCEEDED';
      return true;
    };
    expect(lateComplete()).toBe(false);
    expect(terminal).toEqual({ status: 'CANCELED', completionCasRejected: 1 });
    expect(workerA.metrics()).toMatchObject({
      active_abort_controllers: 0,
      abort_broadcasts_received: 1,
    });
    expect(workerB.metrics()).toMatchObject({
      active_abort_controllers: 0,
      abort_broadcasts_received: 1,
    });
    expect(coordinator.metrics().abort_broadcasts_published).toBe(1);
  });

  it('traces an allowed scheduled image -> video + music -> aggregate run into shared state', async () => {
    const runId = 'run-e2e-media-1';
    const planSha = 'd'.repeat(64);
    const scheduleId = 'schedule-media-1';
    const ledger = new Map<
      string,
      { status: string; input_artifacts: string[]; output_artifacts: string[] }
    >();
    const grants = new Map<string, Set<string>>();
    const holds = new Set<string>();
    const shared = new Map<string, unknown>();
    const trace: string[] = [];
    let queue!: BullMqAutomationQueueAdapter;
    const grant = (artifactId: string, subject: string) => {
      const subjects = grants.get(artifactId) ?? new Set<string>();
      subjects.add(subject);
      grants.set(artifactId, subjects);
    };
    const artifact = (producer: string, kind: string) => `${runId}:${producer}:${kind}`;
    const publish = (node: string) =>
      queue.publishAction({
        run_id: runId,
        attempt_id: `attempt-${node}`,
        invocation_id: `invocation-${node}`,
        plan_sha256: planSha,
      });
    const action = {
      process: vi.fn(
        async (job: {
          run_id: string;
          attempt_id: string;
          invocation_id: string;
          plan_sha256: string;
        }) => {
          expect(job.run_id).toBe(runId);
          expect(job.plan_sha256).toBe(planSha);
          const node = job.invocation_id.replace('invocation-', '');
          trace.push(node);
          if (node === 'image') {
            const image = artifact('image', 'png');
            ledger.set(node, {
              status: 'SUCCEEDED',
              input_artifacts: [],
              output_artifacts: [image],
            });
            holds.add(`${image}:HANDOFF_PENDING`);
            grant(image, 'invocation-video');
            grant(image, 'invocation-music');
            holds.add(`${image}:EDGE:video`);
            holds.add(`${image}:EDGE:music`);
            holds.delete(`${image}:HANDOFF_PENDING`);
            await Promise.all([publish('video'), publish('music')]);
          } else if (node === 'video' || node === 'music') {
            const image = artifact('image', 'png');
            expect(grants.get(image)?.has(`invocation-${node}`)).toBe(true);
            const output = artifact(node, node === 'video' ? 'mp4' : 'mp3');
            ledger.set(node, {
              status: 'SUCCEEDED',
              input_artifacts: [image],
              output_artifacts: [output],
            });
            grant(output, 'invocation-aggregate');
            holds.add(`${output}:EDGE:aggregate`);
            if (ledger.has('video') && ledger.has('music') && !ledger.has('aggregate-published')) {
              ledger.set('aggregate-published', {
                status: 'QUEUED',
                input_artifacts: [],
                output_artifacts: [],
              });
              await publish('aggregate');
            }
          } else {
            const video = artifact('video', 'mp4');
            const music = artifact('music', 'mp3');
            expect(grants.get(video)?.has('invocation-aggregate')).toBe(true);
            expect(grants.get(music)?.has('invocation-aggregate')).toBe(true);
            const final = artifact('aggregate', 'manifest');
            ledger.set(node, {
              status: 'SUCCEEDED',
              input_artifacts: [video, music],
              output_artifacts: [final],
            });
            grant(final, `${runId}:FINAL_OUTPUT`);
            holds.add(`${final}:FINAL_OUTPUT`);
            shared.set('team-media/render/latest', {
              run_id: runId,
              artifact_id: final,
              video_artifact_id: video,
              music_artifact_id: music,
            });
          }
          return { outcome: 'SUCCEEDED' };
        }
      ),
    };
    const schedule = {
      process: vi.fn(
        async (job: { schedule_id: string; generation: number; occurrence_key: string }) => {
          expect(job.schedule_id).toBe(scheduleId);
          trace.push('schedule');
          await publish('image');
          return { outcome: 'CREATED', run_id: runId };
        }
      ),
    };
    const preview = { process: vi.fn() };
    const control = { process: vi.fn() };
    const handles = createAutomationWorkerConsumers(config('worker'), {
      action: action as never,
      preview: preview as never,
      schedule: schedule as never,
      control: control as never,
    });
    register(async () => {
      await Promise.allSettled(handles.map((handle) => handle.close()));
    });
    queue = new BullMqAutomationQueueAdapter(config('dispatcher'));
    register(() => queue.close());
    const connection = new IORedis(TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    const controlQueue = new Queue(AUTOMATION_CONTROL_QUEUE, { connection, prefix: redisPrefix });
    register(async () => {
      await controlQueue.close();
      await connection.quit().catch(() => connection.disconnect(false));
    });
    const entitlement = {
      team_id: 'team-media',
      package_ids: ['package-image', 'package-video', 'package-music', 'package-aggregate'],
      active: true,
    };
    const governance = {
      decision_id: 'policy-decision-media-1',
      allowed: true,
      operations: ['trigger_schedule', 'run_workflow', 'execute_cloud', 'shared_data_write'],
    };
    expect(entitlement.active).toBe(true);
    expect(governance.allowed).toBe(true);
    await controlQueue.add(
      'schedule.once_fire',
      {
        schedule_id: scheduleId,
        generation: 1,
        scheduler_key: `${scheduleId}-g1`,
        scheduled_for: '2026-07-16T08:00:00.000Z',
        occurrence_key: 'media-occurrence-1',
      },
      { jobId: 'media-schedule-fire-1' }
    );
    await waitFor(() => expect(shared.has('team-media/render/latest')).toBe(true), 15_000);
    expect(trace[0]).toBe('schedule');
    expect(trace.indexOf('image')).toBeGreaterThan(0);
    expect(new Set(trace.slice(2, 4))).toEqual(new Set(['video', 'music']));
    expect(trace.at(-1)).toBe('aggregate');
    expect(ledger.get('aggregate')).toMatchObject({
      status: 'SUCCEEDED',
      output_artifacts: [`${runId}:aggregate:manifest`],
    });
    expect(shared.get('team-media/render/latest')).toEqual({
      run_id: runId,
      artifact_id: `${runId}:aggregate:manifest`,
      video_artifact_id: `${runId}:video:mp4`,
      music_artifact_id: `${runId}:music:mp3`,
    });
    expect(grants.get(`${runId}:aggregate:manifest`)).toContain(`${runId}:FINAL_OUTPUT`);
    expect(holds).toContain(`${runId}:aggregate:manifest:FINAL_OUTPUT`);
  }, 25_000);
});
