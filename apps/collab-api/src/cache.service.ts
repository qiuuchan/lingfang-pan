import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import net from 'node:net';
import tls from 'node:tls';
import { resolveCacheConfig } from './cache.config';

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  disconnect?(): Promise<void>;
}

export const CACHE_DEFAULT_TTL_MS = 30_000;

type Clock = () => number;

interface MemoryCacheOptions {
  readonly now?: Clock;
}

interface MemoryCacheEntry {
  readonly value: string;
  readonly expiresAt: number;
}

export class AppCacheService implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly store: CacheStore = createMemoryCacheStore()) {}

  async onModuleInit() {
    return undefined;
  }

  async onModuleDestroy() {
    await this.store.disconnect?.();
  }

  async remember<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.store.get(key);
    if (cached !== null) return JSON.parse(cached) as T;
    const value = await loader();
    await this.store.set(key, JSON.stringify(value), ttlMs);
    return value;
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key);
  }

  /** 读原始字符串值（未命中返回 null）。供需要条件写入/手动控制 TTL 的场景（如搜索健康标记/结果缓存）。 */
  async get(key: string): Promise<string | null> {
    return this.store.get(key);
  }

  /** 写原始字符串值 + TTL。与 remember 区分：调用方自行决定是否写、写什么。 */
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.store.set(key, value, ttlMs);
  }
}

@Injectable()
export class CacheService extends AppCacheService {
  constructor() {
    super(createCacheStore(process.env));
  }
}

export function createCacheStore(env: NodeJS.ProcessEnv = process.env): CacheStore {
  const config = resolveCacheConfig(env);
  if (config.driver === 'memory') return createMemoryCacheStore();
  return createRedisCacheStore(config.redisUrl);
}

export function createMemoryCacheStore(options: MemoryCacheOptions = {}): CacheStore {
  const now = options.now ?? Date.now;
  const entries = new Map<string, MemoryCacheEntry>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlMs) {
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

export function createRedisCacheStore(redisUrl: string): CacheStore {
  const client = new RedisRespClient(redisUrl);
  return {
    async get(key) {
      const value = await client.command(['GET', key]);
      return typeof value === 'string' ? value : null;
    },
    async set(key, value, ttlMs) {
      await client.command(['SET', key, value, 'PX', String(ttlMs)]);
    },
    async delete(key) {
      await client.command(['DEL', key]);
    },
    async disconnect() {
      await client.disconnect();
    },
  };
}

class RedisRespClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private connection: Promise<net.Socket | tls.TLSSocket> | null = null;
  private commandQueue = Promise.resolve();
  private buffer = Buffer.alloc(0);

  constructor(private readonly redisUrl: string) {}

  async command(parts: readonly string[]): Promise<unknown> {
    const run = this.commandQueue.then(() => this.executeCommand(parts));
    this.commandQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.connection = null;
    this.buffer = Buffer.alloc(0);
    if (!socket || socket.destroyed) return;
    socket.destroy();
  }

  private async connect(): Promise<net.Socket | tls.TLSSocket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connection) return this.connection;
    this.connection = this.openConnection().finally(() => {
      this.connection = null;
    });
    return this.connection;
  }

  private async executeCommand(parts: readonly string[]): Promise<unknown> {
    const socket = await this.connect();
    socket.write(encodeCommand(parts));
    return this.readValue(socket);
  }

  private async openConnection(): Promise<net.Socket | tls.TLSSocket> {
    const url = new URL(this.redisUrl);
    const port = Number(url.port || 6379);
    const socket = await openSocket(url, port);
    this.socket = socket;
    try {
      await this.authenticate(url);
      await this.selectDatabase(url);
      return socket;
    } catch (error) {
      socket.destroy();
      this.socket = null;
      throw error;
    }
  }

  private async authenticate(url: URL): Promise<void> {
    const password = decodeURIComponent(url.password || '');
    if (!password) return;
    const username = decodeURIComponent(url.username || '');
    await this.sendHandshakeCommand(username ? ['AUTH', username, password] : ['AUTH', password]);
  }

  private async selectDatabase(url: URL): Promise<void> {
    const db = url.pathname.replace(/^\//, '');
    if (!db) return;
    await this.sendHandshakeCommand(['SELECT', db]);
  }

  private async sendHandshakeCommand(parts: readonly string[]): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error('Redis connection not available');
    socket.write(encodeCommand(parts));
    return this.readValue(socket);
  }

  private async readValue(socket: net.Socket | tls.TLSSocket): Promise<unknown> {
    for (;;) {
      const parsed = parseValue(this.buffer);
      if (parsed) {
        this.buffer = this.buffer.subarray(parsed.offset);
        return parsed.value;
      }
      const chunk = await readChunk(socket);
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }
}

function openSocket(url: URL, port: number): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const options = { host: url.hostname, port };
    const socket = url.protocol === 'rediss:' ? tls.connect(options) : net.connect(options);
    socket.once('connect', () => resolve(socket));
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function readChunk(socket: net.Socket | tls.TLSSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve);
    socket.once('error', reject);
    socket.once('end', () => reject(new Error('Redis connection closed')));
  });
}

function encodeCommand(parts: readonly string[]): Buffer {
  const lines = [`*${parts.length}`];
  for (const part of parts) lines.push(`$${Buffer.byteLength(part)}`, part);
  return Buffer.from(`${lines.join('\r\n')}\r\n`);
}

function parseValue(buffer: Buffer): { value: unknown; offset: number } | null {
  if (buffer.length === 0) return null;
  const type = String.fromCharCode(buffer[0]);
  if (type === '+') return parseLine(buffer, (line) => line);
  if (type === ':') return parseLine(buffer, (line) => Number(line));
  if (type === '-') return parseError(buffer);
  if (type === '$') return parseBulk(buffer);
  throw new Error(`Unsupported Redis response type: ${type}`);
}

function parseLine<T>(
  buffer: Buffer,
  map: (line: string) => T
): { value: T; offset: number } | null {
  const end = buffer.indexOf('\r\n');
  if (end < 0) return null;
  return { value: map(buffer.subarray(1, end).toString('utf8')), offset: end + 2 };
}

function parseError(buffer: Buffer): never | null {
  const parsed = parseLine(buffer, (line) => line);
  if (!parsed) return null;
  throw new Error(`Redis error: ${parsed.value}`);
}

function parseBulk(buffer: Buffer): { value: string | null; offset: number } | null {
  const header = parseLine(buffer, (line) => Number(line));
  if (!header) return null;
  if (header.value === -1) return { value: null, offset: header.offset };
  const end = header.offset + header.value;
  if (buffer.length < end + 2) return null;
  return { value: buffer.subarray(header.offset, end).toString('utf8'), offset: end + 2 };
}
