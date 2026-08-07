import { describe, expect, it, vi } from 'vitest';
import {
  createAutomationWorkerConsumers,
  type AutomationConsumerJob,
} from './automation-worker-consumers';

const disabled = {
  enabled: false,
  cloudManualEnabled: false,
  schedulesEnabled: false,
  processRole: 'api' as const,
  redisUrl: null,
  redisPrefix: 'lf:automation',
  connectsToRedis: false,
  runsOutboxDispatcher: false,
  runsWorker: false,
  runsScheduler: false,
  onceMisfireWindowMs: 900_000,
  consecutiveFailureNotifyThreshold: 3,
  teamMaxActiveRuns: 10,
  workflowMaxActiveRuns: 5,
  teamMaxActiveInvocations: 50,
  actionMaxActiveInvocations: 20,
  teamMaxUsagePerMinute: 600,
  actionMaxUsagePerMinute: 120,
};
describe('automation worker consumers', () => {
  it('does not construct BullMQ consumers while feature-off/API-only', () => {
    const factory = vi.fn();
    expect(
      createAutomationWorkerConsumers(
        disabled,
        { action: {} as never, preview: {} as never, schedule: {} as never, control: {} as never },
        factory
      )
    ).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it('routes action jobs and derives repeat occurrence only from BullMQ opts', async () => {
    const handlers = new Map<string, (job: AutomationConsumerJob) => Promise<unknown>>();
    const factory = vi.fn(
      (queue: string, handler: (job: AutomationConsumerJob) => Promise<unknown>) => {
        handlers.set(queue, handler);
        return { close: vi.fn(async () => undefined) };
      }
    );
    const action = { process: vi.fn(async () => ({ outcome: 'SUCCEEDED' })) } as any;
    const preview = { process: vi.fn(async () => ({ outcome: 'SUCCEEDED' })) } as any;
    const schedule = { process: vi.fn(async () => ({ outcome: 'CREATED' })) } as any;
    const control = { process: vi.fn(async () => ({ outcome: 'COORDINATED' })) } as any;
    const config = {
      ...disabled,
      enabled: true,
      processRole: 'worker' as const,
      redisUrl: 'redis://example/15',
      connectsToRedis: true,
      runsWorker: true,
    };
    expect(
      createAutomationWorkerConsumers(config, { action, preview, schedule, control }, factory)
    ).toHaveLength(2);
    await handlers.get('lf-cloud-action')!({
      name: 'action.invoke',
      data: { run_id: 'r', attempt_id: 'a', invocation_id: 'i', plan_sha256: 'p' },
      opts: {},
    });
    await handlers.get('lf-automation-control')!({
      name: 'schedule.repeat_fire',
      data: { schedule_id: 's', generation: 3, scheduler_key: 'schedule-s-g3', prev_millis: 1 },
      opts: { prevMillis: 1234, repeatJobKey: 'schedule-s-g3' },
    });
    await handlers.get('lf-automation-control')!({
      name: 'run.coordinate',
      data: { run_id: 'r', generation: 3 },
      opts: {},
    });
    expect(action.process).toHaveBeenCalledWith(
      { run_id: 'r', attempt_id: 'a', invocation_id: 'i', plan_sha256: 'p' },
      expect.any(AbortSignal)
    );
    expect(schedule.process).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'REPEAT',
        prev_millis: 1234,
        repeat_job_key: 'schedule-s-g3',
      })
    );
    expect(control.process).toHaveBeenCalledWith({
      name: 'run.coordinate',
      data: { run_id: 'r', generation: 3 },
    });
  });
});
