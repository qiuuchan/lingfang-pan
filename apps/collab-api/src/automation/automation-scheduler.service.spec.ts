import { describe, expect, it, vi } from 'vitest';
import { resolveAutomationConfig } from './automation-config';
import {
  AutomationSchedulerService,
  type AutomationSchedulerPort,
} from './automation-scheduler.service';

function port(): AutomationSchedulerPort {
  return {
    upsertRecurring: vi.fn(async () => undefined),
    upsertOnce: vi.fn(async () => undefined),
    removeSchedule: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('AutomationSchedulerService', () => {
  const config = resolveAutomationConfig({
    AUTOMATION_ENABLED: 'true',
    AUTOMATION_PROCESS_ROLE: 'scheduler',
    AUTOMATION_REDIS_URL: 'redis://example/15',
    SCHEDULES_ENABLED: 'true',
  });

  it('projects a recurring schedule with an internal six-field cron and marks sync state', async () => {
    const scheduler = port();
    const prisma = {
      automationSchedule: {
        findFirst: vi.fn(async () => ({
          id: 'schedule-1',
          generation: 4,
          schedulerKey: 'schedule-schedule-1-g4',
          kind: 'WEEKLY',
          status: 'ACTIVE',
          runAt: null,
          nextRunAt: new Date('2026-07-20T01:30:00Z'),
          timeZone: 'Asia/Shanghai',
          localTime: '09:30',
          dayOfWeek: 1,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    } as any;
    const service = new AutomationSchedulerService(prisma, config, scheduler);
    await expect(service.upsert('schedule-1', 4)).resolves.toEqual({ outcome: 'SYNCED' });
    expect(scheduler.removeSchedule).toHaveBeenCalledWith('schedule-1', 3);
    expect(scheduler.upsertRecurring).toHaveBeenCalledWith({
      schedulerKey: 'schedule-schedule-1-g4',
      pattern: '0 30 9 * * 1',
      timeZone: 'Asia/Shanghai',
      data: { schedule_id: 'schedule-1', generation: 4, scheduler_key: 'schedule-schedule-1-g4' },
    });
    expect(prisma.automationSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { syncState: 'SYNCED', syncErrorCode: '' } })
    );
  });

  it('projects ONCE with a deterministic occurrence and keeps lifecycle unchanged on sync failure', async () => {
    const scheduler = port();
    vi.mocked(scheduler.upsertOnce).mockRejectedValueOnce(
      new Error('automation_redis_unavailable')
    );
    const runAt = new Date('2026-07-20T00:00:00.000Z');
    const prisma = {
      automationSchedule: {
        findFirst: vi.fn(async () => ({
          id: 'schedule-2',
          generation: 2,
          schedulerKey: 'schedule-schedule-2-g2',
          kind: 'ONCE',
          status: 'ACTIVE',
          runAt,
          nextRunAt: runAt,
          timeZone: null,
          localTime: null,
          dayOfWeek: null,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    } as any;
    const service = new AutomationSchedulerService(prisma, config, scheduler);
    await expect(
      service.upsert('schedule-2', 2, new Date('2026-07-19T23:59:00.000Z'))
    ).rejects.toThrow('automation_redis_unavailable');
    expect(scheduler.upsertOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        delayMs: 60_000,
        data: expect.objectContaining({ occurrence_key: expect.any(String) }),
      })
    );
    expect(prisma.automationSchedule.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { syncState: 'ERROR', syncErrorCode: 'automation_redis_unavailable' },
      })
    );
  });
});
