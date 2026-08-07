import { describe, expect, it } from 'vitest';
import { SHARED_REALTIME_NAMESPACE, resolveSharedRealtimeConfig } from './shared-realtime.config';
import { SharedRealtimeModule } from './shared-realtime.module';
import { SharedRealtimeGateway } from './shared-realtime.gateway';

describe('resolveSharedRealtimeConfig', () => {
  it('owns the stable plugin shared transport namespace', () => {
    expect(SHARED_REALTIME_NAMESPACE).toBe('/plugin-shared');
  });

  it('keeps feature-off independent from stale Redis configuration', () => {
    expect(
      resolveSharedRealtimeConfig({
        NODE_ENV: 'production',
        PLUGIN_SHARED_REALTIME_ENABLED: 'false',
        PLUGIN_SHARED_REALTIME_REDIS_URL: 'not-a-url',
      })
    ).toEqual({ enabled: false, transport: 'disabled', redisUrl: null });
    const module = SharedRealtimeModule.forRoot({ PLUGIN_SHARED_REALTIME_ENABLED: 'false' });
    expect(module.imports).toEqual([]);
    expect(module.providers).not.toContain(SharedRealtimeGateway);
  });

  it('allows a single-process memory store only outside production', () => {
    expect(
      resolveSharedRealtimeConfig({ NODE_ENV: 'test', PLUGIN_SHARED_REALTIME_ENABLED: 'true' })
    ).toEqual({ enabled: true, transport: 'memory', redisUrl: null });
  });

  it('fails closed when production realtime has no Redis', () => {
    expect(() =>
      resolveSharedRealtimeConfig({
        NODE_ENV: 'production',
        PLUGIN_SHARED_REALTIME_ENABLED: 'true',
      })
    ).toThrow(/REDIS_URL is required/);
  });

  it('selects Redis when an explicit shared realtime URL is present', () => {
    expect(
      resolveSharedRealtimeConfig({
        NODE_ENV: 'production',
        PLUGIN_SHARED_REALTIME_ENABLED: '1',
        PLUGIN_SHARED_REALTIME_REDIS_URL: 'rediss://redis.example/0',
      })
    ).toEqual({ enabled: true, transport: 'redis', redisUrl: 'rediss://redis.example/0' });
  });
});
