export type CacheDriver = 'memory' | 'redis';

export type CacheConfig =
  | { readonly driver: 'memory'; readonly redisUrl: null }
  | { readonly driver: 'redis'; readonly redisUrl: string };

export function resolveCacheConfig(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  const driver = parseCacheDriver(env.CACHE_DRIVER);
  if (driver === 'memory') return { driver, redisUrl: null };
  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl) throw new Error('CACHE_DRIVER=redis requires REDIS_URL');
  if (!/^rediss?:\/\//i.test(redisUrl))
    throw new Error('REDIS_URL must start with redis:// or rediss://');
  return { driver, redisUrl };
}

function parseCacheDriver(raw: string | undefined): CacheDriver {
  if (!raw || raw.trim().length === 0) return 'memory';
  const value = raw.trim().toLowerCase();
  if (value === 'memory' || value === 'redis') return value;
  throw new Error('CACHE_DRIVER must be memory or redis');
}
