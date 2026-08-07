import { describe, expect, it, vi } from 'vitest';
import { createAutomationRedisConnection, resolveAutomationConfig } from './automation-config';

describe('resolveAutomationConfig', () => {
  it('keeps the ordinary API feature-off and never constructs Redis', () => {
    const config = resolveAutomationConfig({
      AUTOMATION_ENABLED: 'false',
      AUTOMATION_PROCESS_ROLE: 'not-a-role',
      AUTOMATION_REDIS_URL: 'not-a-url',
      CLOUD_MANUAL_ENABLED: 'true',
      SCHEDULES_ENABLED: 'true',
    });
    const factory = vi.fn();
    expect(createAutomationRedisConnection(config, factory)).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(config).toMatchObject({
      enabled: false,
      cloudManualEnabled: false,
      schedulesEnabled: false,
      processRole: 'api',
      connectsToRedis: false,
    });
  });

  it('allows an enabled API role to write DB/outbox without a Redis dependency', () => {
    const config = resolveAutomationConfig({
      AUTOMATION_ENABLED: '1',
      AUTOMATION_PROCESS_ROLE: 'api',
      CLOUD_MANUAL_ENABLED: 'true',
      SCHEDULES_ENABLED: 'true',
    });
    expect(config).toMatchObject({
      enabled: true,
      cloudManualEnabled: true,
      schedulesEnabled: true,
      redisUrl: null,
      connectsToRedis: false,
    });
  });

  it('requires the dedicated persistent Redis URL only for infrastructure roles', () => {
    expect(() =>
      resolveAutomationConfig({
        AUTOMATION_ENABLED: 'true',
        AUTOMATION_PROCESS_ROLE: 'worker',
      })
    ).toThrow('AUTOMATION_REDIS_URL');

    const config = resolveAutomationConfig({
      AUTOMATION_ENABLED: 'true',
      AUTOMATION_PROCESS_ROLE: 'dispatcher',
      AUTOMATION_REDIS_URL: 'rediss://automation.example/1',
    });
    const connection = { disconnect: vi.fn(async () => undefined) };
    const factory = vi.fn(() => connection);
    expect(createAutomationRedisConnection(config, factory)).toBe(connection);
    expect(factory).toHaveBeenCalledWith('rediss://automation.example/1');
    expect(config.runsOutboxDispatcher).toBe(true);
    expect(config.redisPrefix).toBe('lf:automation');
  });

  it('accepts an isolated Redis prefix and rejects unsafe prefix characters', () => {
    expect(
      resolveAutomationConfig({
        AUTOMATION_ENABLED: 'true',
        AUTOMATION_PROCESS_ROLE: 'worker',
        AUTOMATION_REDIS_URL: 'redis://127.0.0.1:6379/15',
        AUTOMATION_REDIS_PREFIX: 'lf:automation:test:run-1',
      }).redisPrefix
    ).toBe('lf:automation:test:run-1');
    expect(() =>
      resolveAutomationConfig({
        AUTOMATION_ENABLED: 'true',
        AUTOMATION_PROCESS_ROLE: 'worker',
        AUTOMATION_REDIS_URL: 'redis://127.0.0.1:6379/15',
        AUTOMATION_REDIS_PREFIX: 'lf automation *',
      })
    ).toThrow('AUTOMATION_REDIS_PREFIX');
  });
});
