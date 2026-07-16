export type SharedRealtimeTransport = 'disabled' | 'memory' | 'redis';
export const SHARED_REALTIME_NAMESPACE = '/plugin-shared';

export interface SharedRealtimeConfig {
  readonly enabled: boolean;
  readonly transport: SharedRealtimeTransport;
  readonly redisUrl: string | null;
}

const DISABLED_CONFIG: SharedRealtimeConfig = Object.freeze({
  enabled: false,
  transport: 'disabled',
  redisUrl: null,
});

export function resolveSharedRealtimeConfig(env: NodeJS.ProcessEnv = process.env): SharedRealtimeConfig {
  const enabled = parseBooleanSwitch(env.PLUGIN_SHARED_REALTIME_ENABLED);
  // Feature-off is a hard dependency barrier: stale Redis settings must not affect REST startup.
  if (!enabled) return DISABLED_CONFIG;

  const redisUrl = optionalRedisUrl(env.PLUGIN_SHARED_REALTIME_REDIS_URL);
  if (env.NODE_ENV === 'production' && !redisUrl) {
    throw new Error('PLUGIN_SHARED_REALTIME_REDIS_URL is required when shared realtime is enabled in production');
  }
  return {
    enabled: true,
    transport: redisUrl ? 'redis' : 'memory',
    redisUrl,
  };
}

function parseBooleanSwitch(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error('PLUGIN_SHARED_REALTIME_ENABLED must be true, false, 1 or 0');
}

function optionalRedisUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^rediss?:\/\//iu.test(value)) {
    throw new Error('PLUGIN_SHARED_REALTIME_REDIS_URL must start with redis:// or rediss://');
  }
  return value;
}
