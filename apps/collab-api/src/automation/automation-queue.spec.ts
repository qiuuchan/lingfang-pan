import { describe, expect, it, vi } from 'vitest';
import { resolveAutomationConfig } from './automation-config';
import { automationControlJob, classifyAutomationRedisPolicy, createAutomationQueueAdapter, type AutomationQueuePort } from './automation-queue';

const row = {
  id: 'outbox-1', kind: 'UPSERT_SCHEDULE' as const, aggregateId: 'schedule-1', generation: 4,
  payload: { secret: 'must-never-enter-a-job', input: { prompt: 'private' } }, attempts: 1, lockedUntil: new Date(),
};

describe('automation queue boundary', () => {
  it('does not construct Redis/BullMQ for feature-off or API-only roles', async () => {
    const factory = vi.fn<() => AutomationQueuePort>();
    const disabled = createAutomationQueueAdapter(resolveAutomationConfig({ AUTOMATION_ENABLED: 'false' }), factory);
    const apiOnly = createAutomationQueueAdapter(resolveAutomationConfig({ AUTOMATION_ENABLED: 'true', AUTOMATION_PROCESS_ROLE: 'api' }), factory);
    expect(factory).not.toHaveBeenCalled();
    expect(disabled.connected).toBe(false);
    expect(apiOnly.connected).toBe(false);
    await expect(disabled.checkReadiness()).resolves.toMatchObject({ status: 'disabled', redis: 'not_required' });
    await expect(apiOnly.checkReadiness()).resolves.toMatchObject({ status: 'api_only', redis: 'not_required' });
  });

  it('creates an infrastructure adapter only through the injected factory', () => {
    const fake = { connected: true } as AutomationQueuePort;
    const factory = vi.fn(() => fake);
    const config = resolveAutomationConfig({
      AUTOMATION_ENABLED: 'true', AUTOMATION_PROCESS_ROLE: 'dispatcher', AUTOMATION_REDIS_URL: 'redis://automation.example/15',
    });
    expect(createAutomationQueueAdapter(config, factory)).toBe(fake);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('projects outbox rows to ID/generation-only deterministic jobs', () => {
    const first = automationControlJob(row);
    const second = automationControlJob({ ...row, payload: { secret: 'different' } });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ name: 'schedule.upsert', data: { schedule_id: 'schedule-1', generation: 4 } });
    expect(JSON.stringify(first)).not.toContain('must-never-enter-a-job');
    expect(JSON.stringify(first)).not.toContain('private');
    expect(first.jobId).not.toContain(':');
  });

  it('fails readiness closed unless persistence and noeviction are both configured', () => {
    expect(classifyAutomationRedisPolicy({ appendOnly: 'yes', savePolicy: '', maxmemoryPolicy: 'noeviction' })).toEqual({
      status: 'ready', persistence: 'safe', evictionPolicy: 'noeviction',
    });
    expect(classifyAutomationRedisPolicy({ appendOnly: 'no', savePolicy: '', maxmemoryPolicy: 'allkeys-lru' })).toEqual({
      status: 'degraded', persistence: 'unsafe', evictionPolicy: 'unsafe',
    });
    expect(classifyAutomationRedisPolicy({})).toEqual({
      status: 'degraded', persistence: 'unknown', evictionPolicy: 'unknown',
    });
  });
});
