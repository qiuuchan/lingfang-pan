import { describe, expect, it, vi } from 'vitest';
import { resolveAutomationConfig } from './automation-config';
import { AutomationOutboxDispatcher } from './automation-outbox-dispatcher';

const claimed = {
  id: 'outbox-1', kind: 'ENQUEUE_RUN' as const, aggregateId: 'run-1', generation: 0,
  payload: { secret: 'not-for-redis' }, attempts: 1, lockedUntil: new Date(),
};

describe('AutomationOutboxDispatcher', () => {
  it('publishes then closes the exact leased outbox row', async () => {
    const queue = { publishOutbox: vi.fn(async () => undefined) };
    const outbox = {
      claim: vi.fn(async () => [claimed]),
      complete: vi.fn(async () => true),
      fail: vi.fn(),
    };
    const dispatcher = new AutomationOutboxDispatcher(
      resolveAutomationConfig({ AUTOMATION_ENABLED: 'true', AUTOMATION_PROCESS_ROLE: 'dispatcher', AUTOMATION_REDIS_URL: 'redis://example/15' }),
      queue as never,
      outbox as never,
    );
    await expect(dispatcher.dispatchOnce('worker-a')).resolves.toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0, stale: 0 });
    expect(queue.publishOutbox).toHaveBeenCalledWith(claimed);
    expect(outbox.complete).toHaveBeenCalledWith('outbox-1', 'worker-a');
    expect(outbox.fail).not.toHaveBeenCalled();
  });

  it('keeps DB truth pending when queue publication fails', async () => {
    const outbox = {
      claim: vi.fn(async () => [claimed]),
      complete: vi.fn(),
      fail: vi.fn(async () => 'RETRY' as const),
    };
    const dispatcher = new AutomationOutboxDispatcher(
      resolveAutomationConfig({ AUTOMATION_ENABLED: 'true', AUTOMATION_PROCESS_ROLE: 'dispatcher', AUTOMATION_REDIS_URL: 'redis://example/15' }),
      { publishOutbox: vi.fn(async () => { throw new Error('redis contains sensitive connection detail'); }) } as never,
      outbox as never,
    );
    await expect(dispatcher.dispatchOnce('worker-a')).resolves.toEqual({ claimed: 1, delivered: 0, retried: 1, dead: 0, stale: 0 });
    expect(outbox.complete).not.toHaveBeenCalled();
    expect(outbox.fail).toHaveBeenCalledWith('outbox-1', 'worker-a', 'automation_queue_unavailable');
  });

  it('does not start a timer in the ordinary API role', () => {
    vi.useFakeTimers();
    const dispatcher = new AutomationOutboxDispatcher(
      resolveAutomationConfig({ AUTOMATION_ENABLED: 'true', AUTOMATION_PROCESS_ROLE: 'api' }),
      {} as never,
      { claim: vi.fn() } as never,
    );
    dispatcher.onModuleInit();
    expect(vi.getTimerCount()).toBe(0);
    dispatcher.onModuleDestroy();
    vi.useRealTimers();
  });
});
