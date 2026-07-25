import { describe, expect, it, vi } from 'vitest';
import { AutomationScheduleFireProcessor } from './automation-schedule-fire.processor';

const schedule = {
  id: 'schedule-1', generation: 2, status: 'ACTIVE', schedulerKey: 'schedule-schedule-1-g2', kind: 'DAILY',
  timeZone: 'UTC', localTime: '10:00', dayOfWeek: null, runAt: null, createdByUserId: 'user-1',
};

describe('AutomationScheduleFireProcessor', () => {
  it('does not execute historical Cloud schedules when configured', async () => {
    const findFirst = vi.fn();
    const startScheduled = vi.fn();
    const processor = new AutomationScheduleFireProcessor({ automationSchedule: { findFirst } } as never, { startScheduled } as never, { enabled: true, schedulesEnabled: true } as never);
    await expect(processor.process({ kind: 'ONCE', schedule_id: 'schedule-1', generation: 2, scheduler_key: 'key', scheduled_for: new Date().toISOString(), occurrence_key: 'occurrence' })).resolves.toEqual({ outcome: 'DEPRECATED', run_id: null });
    expect(findFirst).not.toHaveBeenCalled();
    expect(startScheduled).not.toHaveBeenCalled();
  });

  it('ignores a stale generation or scheduler key without creating a run', async () => {
    const startScheduled = vi.fn();
    const processor = new AutomationScheduleFireProcessor({ automationSchedule: { findFirst: vi.fn(async () => null) } } as never, { startScheduled } as never);
    await expect(processor.process({ kind: 'REPEAT', schedule_id: 'schedule-1', generation: 1, scheduler_key: 'old', prev_millis: 1, repeat_job_key: 'old' })).resolves.toEqual({ outcome: 'STALE', run_id: null });
    expect(startScheduled).not.toHaveBeenCalled();
  });

  it('uses prevMillis and repeatJobKey and returns an existing occurrence idempotently', async () => {
    const prisma = {
      automationSchedule: { findFirst: vi.fn(async () => schedule) },
      workflowRun: { findUnique: vi.fn(async () => ({ id: 'run-existing' })) },
    };
    const processor = new AutomationScheduleFireProcessor(prisma as never, { startScheduled: vi.fn() } as never);
    await expect(processor.process({
      kind: 'REPEAT', schedule_id: schedule.id, generation: 2, scheduler_key: schedule.schedulerKey,
      prev_millis: Date.parse('2026-07-20T10:00:00.000Z'), repeat_job_key: schedule.schedulerKey,
    })).resolves.toEqual({ outcome: 'DUPLICATE', run_id: 'run-existing' });
  });

  it('creates one scheduled run and advances recurring nextRunAt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T10:00:30.000Z'));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      automationSchedule: { findFirst: vi.fn(async () => schedule), updateMany },
      workflowRun: { findUnique: vi.fn(async () => null) },
    };
    const startScheduled = vi.fn(async () => ({ run: { id: 'run-new' } }));
    const processor = new AutomationScheduleFireProcessor(prisma as never, { startScheduled } as never);
    await expect(processor.process({
      kind: 'REPEAT', schedule_id: schedule.id, generation: 2, scheduler_key: schedule.schedulerKey,
      prev_millis: Date.parse('2026-07-20T10:00:00.000Z'), repeat_job_key: schedule.schedulerKey,
    })).resolves.toEqual({ outcome: 'CREATED', run_id: 'run-new' });
    expect(startScheduled).toHaveBeenCalledWith('user-1', schedule, new Date('2026-07-20T10:00:00.000Z'), 'schedule-1:g2:2026-07-20T10:00:00.000Z');
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { nextRunAt: new Date('2026-07-21T10:00:00.000Z') } }));
    vi.useRealTimers();
  });
});
