import { describe, expect, it, vi } from 'vitest';
import { resolveAutomationConfig } from './automation-config';
import { AutomationControlProcessor } from './automation-control.processor';

describe('AutomationControlProcessor', () => {
  const config = resolveAutomationConfig({
    AUTOMATION_ENABLED: 'true',
    AUTOMATION_PROCESS_ROLE: 'all',
    AUTOMATION_REDIS_URL: 'redis://example/15',
    CLOUD_MANUAL_ENABLED: 'true',
    SCHEDULES_ENABLED: 'true',
  });

  it('executes schedule projection commands instead of ignoring them', async () => {
    const scheduler = {
      upsert: vi.fn(async () => ({ outcome: 'SYNCED' })),
      remove: vi.fn(async () => ({ outcome: 'SYNCED' })),
    } as any;
    const service = new AutomationControlProcessor(
      {} as any,
      config,
      {} as any,
      scheduler,
      {} as any
    );
    await service.process({ name: 'schedule.upsert', data: { schedule_id: 's1', generation: 3 } });
    await service.process({ name: 'schedule.remove', data: { schedule_id: 's1', generation: 4 } });
    expect(scheduler.upsert).toHaveBeenCalledWith('s1', 3);
    expect(scheduler.remove).toHaveBeenCalledWith('s1', 4);
  });

  it('coordinates a run and publishes every untransported invocation', async () => {
    const run = {
      id: 'run-1',
      executionTarget: 'CLOUD',
      principalUserId: 'user-1',
      scheduleGeneration: null,
      triggerKind: 'MANUAL',
      planSha256: 'plan-1',
      attempts: [],
    };
    const prisma = {
      workflowRun: { findUnique: vi.fn(async () => run) },
      workflowStepAttempt: {
        findMany: vi.fn(async () => [{ id: 'attempt-1', actionInvocationId: 'invocation-1' }]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    } as any;
    const queue = { publishAction: vi.fn(async () => undefined) } as any;
    const runs = {
      coordinateCloud: vi.fn(async () => ({ run })),
      coordinateCloudCancellation: vi.fn(),
      cancel: vi.fn(),
    } as any;
    const service = new AutomationControlProcessor(prisma, config, queue, {} as any, runs);
    await expect(
      service.process({ name: 'run.coordinate', data: { run_id: 'run-1', generation: 0 } })
    ).resolves.toEqual({ outcome: 'COORDINATED', published: 1 });
    expect(runs.coordinateCloud).toHaveBeenCalledWith('user-1', 'run-1');
    expect(queue.publishAction).toHaveBeenCalledWith({
      run_id: 'run-1',
      attempt_id: 'attempt-1',
      invocation_id: 'invocation-1',
      plan_sha256: 'plan-1',
    });
  });
});
