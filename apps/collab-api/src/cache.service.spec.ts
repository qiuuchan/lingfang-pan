import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCacheConfig } from './cache.config';
import { AppCacheService, createMemoryCacheStore, createRedisCacheStore } from './cache.service';

describe('AppCacheService', () => {
  it('caches JSON values within the ttl window', async () => {
    const now = vi.fn(() => 1_000);
    const cache = new AppCacheService(createMemoryCacheStore({ now }));
    const loader = vi.fn(async () => ({ value: 'fresh' }));

    await expect(cache.remember('platform-info', 30_000, loader)).resolves.toEqual({ value: 'fresh' });
    await expect(cache.remember('platform-info', 30_000, loader)).resolves.toEqual({ value: 'fresh' });

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('reloads values after explicit delete', async () => {
    const cache = new AppCacheService(createMemoryCacheStore());
    const loader = vi.fn()
      .mockResolvedValueOnce({ value: 'first' })
      .mockResolvedValueOnce({ value: 'second' });

    await cache.remember('active-provider', 30_000, loader);
    await cache.delete('active-provider');

    await expect(cache.remember('active-provider', 30_000, loader)).resolves.toEqual({ value: 'second' });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('resolveCacheConfig', () => {
  it('uses memory cache by default', () => {
    expect(resolveCacheConfig({})).toEqual({ driver: 'memory', redisUrl: null });
  });

  it('requires REDIS_URL when redis is selected', () => {
    expect(() => resolveCacheConfig({ CACHE_DRIVER: 'redis' })).toThrow('CACHE_DRIVER=redis requires REDIS_URL');
  });

  it('accepts explicit redis configuration', () => {
    expect(resolveCacheConfig({
      CACHE_DRIVER: 'redis',
      REDIS_URL: 'redis://localhost:6379/0',
    })).toEqual({
      driver: 'redis',
      redisUrl: 'redis://localhost:6379/0',
    });
  });
});

describe('createRedisCacheStore', () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(closeServer));
    servers.length = 0;
  });

  it('serializes concurrent commands on one Redis connection', async () => {
    const server = await startRedisLikeServer({
      alpha: 'A',
      beta: 'B',
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP server address');

    const cache = createRedisCacheStore(`redis://127.0.0.1:${address.port}/0`);
    try {
      const [alpha, beta] = await Promise.all([
        cache.get('alpha'),
        cache.get('beta'),
      ]);

      expect(alpha).toBe('A');
      expect(beta).toBe('B');
    } finally {
      await cache.disconnect?.();
    }
  });
});

function startRedisLikeServer(values: Record<string, string>): Promise<net.Server> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    let batchedKeys: string[] = [];
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const parsed = parseRedisCommands(pending);
      pending = parsed.rest;
      for (const command of parsed.commands) {
        if (command[0] === 'SELECT') socket.write('+OK\r\n');
        if (command[0] === 'GET') {
          batchedKeys = [...batchedKeys, command[1]];
          setTimeout(() => {
            if (batchedKeys.length === 0) return;
            const keys = batchedKeys.length > 1 ? [...batchedKeys].reverse() : [...batchedKeys];
            batchedKeys = [];
            socket.write(keys.map((key) => encodeBulk(values[key] ?? '')).join(''));
          }, 10);
        }
      }
    });
  });
  server.on('close', () => sockets.forEach((socket) => socket.destroy()));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function parseRedisCommands(buffer: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const parsed = parseRedisCommand(buffer, offset);
    if (!parsed) break;
    commands.push(parsed.command);
    offset = parsed.offset;
  }
  return { commands, rest: buffer.subarray(offset) };
}

function parseRedisCommand(buffer: Buffer, start: number): { command: string[]; offset: number } | null {
  if (buffer[start] !== 42) return null;
  const countLine = readLine(buffer, start + 1);
  if (!countLine) return null;
  const command: string[] = [];
  let offset = countLine.offset;
  for (let i = 0; i < Number(countLine.line); i += 1) {
    if (buffer[offset] !== 36) return null;
    const lengthLine = readLine(buffer, offset + 1);
    if (!lengthLine) return null;
    const end = lengthLine.offset + Number(lengthLine.line);
    if (buffer.length < end + 2) return null;
    command.push(buffer.subarray(lengthLine.offset, end).toString('utf8'));
    offset = end + 2;
  }
  return { command, offset };
}

function readLine(buffer: Buffer, start: number): { line: string; offset: number } | null {
  const end = buffer.indexOf('\r\n', start);
  if (end < 0) return null;
  return { line: buffer.subarray(start, end).toString('utf8'), offset: end + 2 };
}

function encodeBulk(value: string): string {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
