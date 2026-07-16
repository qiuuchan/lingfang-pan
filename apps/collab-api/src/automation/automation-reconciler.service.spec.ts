import { describe, expect, it, vi } from 'vitest';
import { resolveAutomationConfig } from './automation-config';
import { AutomationReconcilerService } from './automation-reconciler.service';

describe('AutomationReconcilerService', () => {
  const config = resolveAutomationConfig({ AUTOMATION_ENABLED: 'true', AUTOMATION_PROCESS_ROLE: 'scheduler', AUTOMATION_REDIS_URL: 'redis://example/15', SCHEDULES_ENABLED: 'true', AUTOMATION_ONCE_MISFIRE_WINDOW_MS: '60000' });

  it('marks an overdue ONCE schedule MISSED and emits a deduplicated owner notification', async () => {
    const runAt = new Date('2026-07-16T00:00:00.000Z');
    const prisma = {
      automationSchedule: {
        findMany: vi.fn(async () => [{ id: 's1', createdByUserId: 'u1', kind: 'ONCE', runAt, nextRunAt: runAt, generation: 1, schedulerKey: 'schedule-s1-g1', status: 'ACTIVE' }]),
        updateMany: vi.fn(async (args: any) => args.data.status === 'MISSED' ? { count: 1 } : { count: 1 }),
        findUnique: vi.fn(),
      },
      workflowRun: { findMany: vi.fn(async () => []) },
      notification: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'n1' })) },
    } as any;
    const scheduler = { remove: vi.fn(async () => ({ outcome: 'SYNCED' })), upsert: vi.fn() } as any;
    const service = new AutomationReconcilerService(prisma, config, scheduler, { process: vi.fn() } as any, { process: vi.fn() } as any);
    const result = await service.reconcileOnce(new Date('2026-07-16T00:02:00.000Z'));
    expect(result.missed).toBe(1);
    expect(scheduler.remove).toHaveBeenCalledWith('s1', 1);
    expect(prisma.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'u1', type: 'automation_schedule_missed', relatedId: 's1' }) });
  });

  it('coalesces a due recurring projection into one recovery fire and advances the Redis projection', async () => {
    const due = new Date('2026-07-16T00:00:00.000Z');
    const schedule = { id: 's2', createdByUserId: 'u2', kind: 'DAILY', runAt: null, nextRunAt: due, generation: 5, schedulerKey: 'schedule-s2-g5', status: 'ACTIVE' };
    const prisma = {
      automationSchedule: { findMany: vi.fn(async () => [schedule]), updateMany: vi.fn(async () => ({ count: 1 })), findUnique: vi.fn(async () => ({ generation: 5, status: 'ACTIVE' })) },
      workflowRun: { findMany: vi.fn(async () => []) },
      notification: { findFirst: vi.fn(async () => null), create: vi.fn() },
    } as any;
    const fire = { process: vi.fn(async () => ({ outcome: 'CREATED', run_id: 'r1' })) } as any;
    const scheduler = { remove: vi.fn(), upsert: vi.fn(async () => ({ outcome: 'SYNCED' })) } as any;
    const service = new AutomationReconcilerService(prisma, config, scheduler, { process: vi.fn() } as any, fire);
    const result = await service.reconcileOnce(new Date('2026-07-16T00:05:00.000Z'));
    expect(result.recovered).toBe(1);
    expect(fire.process).toHaveBeenCalledWith(expect.objectContaining({ kind: 'RECOVERY', schedule_id: 's2', generation: 5, scheduled_for: due.toISOString() }));
    expect(scheduler.upsert).toHaveBeenCalledWith('s2', 5, new Date('2026-07-16T00:05:00.000Z'));
  });

  it('projects consecutive failures and notifies only once for the same failure episode', async () => {
    const next = new Date('2026-07-17T00:00:00.000Z');
    const schedule = { id: 's3', createdByUserId: 'u3', kind: 'DAILY', runAt: null, nextRunAt: next, generation: 2, schedulerKey: 'schedule-s3-g2', status: 'ACTIVE' };
    const prisma = {
      automationSchedule: { findMany: vi.fn(async () => [schedule]), updateMany: vi.fn(async () => ({ count: 1 })), findUnique: vi.fn(async () => ({ generation: 2, status: 'ACTIVE' })) },
      workflowRun: { findMany: vi.fn()
        .mockResolvedValueOnce([{ id: 'f3', status: 'FAILED' }, { id: 'f2', status: 'FAILED' }, { id: 'f1', status: 'FAILED' }, { id: 'ok0', status: 'SUCCEEDED' }])
        .mockResolvedValueOnce([]) },
      notification: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'n3' })) },
    } as any;
    const scheduler = { remove: vi.fn(), upsert: vi.fn(async () => ({ outcome: 'SYNCED' })) } as any;
    const service = new AutomationReconcilerService(prisma, config, scheduler, { process: vi.fn() } as any, { process: vi.fn() } as any);
    await service.reconcileOnce(new Date('2026-07-16T00:00:00.000Z'));
    expect(prisma.automationSchedule.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { consecutiveFailures: 3 } }));
    expect(prisma.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'automation_schedule_consecutive_failure:ok0', relatedId: 's3' }) });
  });
});
