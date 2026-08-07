import { describe, expect, it, vi } from 'vitest';
import {
  AUTOMATION_OUTBOX_MAX_ATTEMPTS,
  AutomationOutboxService,
  automationOutboxBackoffMs,
} from './automation-outbox.service';

describe('AutomationOutboxService', () => {
  it('uses bounded exponential retry delays', () => {
    expect(automationOutboxBackoffMs(1)).toBe(1_000);
    expect(automationOutboxBackoffMs(2)).toBe(2_000);
    expect(automationOutboxBackoffMs(99)).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('completes only a row owned by the current worker lease', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const service = new AutomationOutboxService({ automationOutbox: { updateMany } } as never);
    await expect(service.complete('outbox-1', 'worker-a')).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outbox-1', status: 'PROCESSING', lockedBy: 'worker-a' },
      })
    );
  });

  it('returns stale when another worker already closed the row', async () => {
    const service = new AutomationOutboxService({
      automationOutbox: { findFirst: vi.fn(async () => null) },
    } as never);
    await expect(service.fail('outbox-1', 'worker-a', 'redis_down')).resolves.toBe('STALE');
  });

  it('moves the final failed delivery to dead-letter state', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const service = new AutomationOutboxService({
      automationOutbox: {
        findFirst: vi.fn(async () => ({ attempts: AUTOMATION_OUTBOX_MAX_ATTEMPTS })),
        updateMany,
      },
    } as never);
    await expect(service.fail('outbox-1', 'worker-a', 'redis_down')).resolves.toBe('DEAD');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', lockedBy: null, lockedUntil: null }),
      })
    );
  });
});
