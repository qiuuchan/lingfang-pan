import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import IORedis from 'ioredis';
import type { Namespace } from 'socket.io';
import { SHARED_REALTIME_CONFIG } from './shared-realtime.tokens';
import type { SharedRealtimeConfig } from './shared-realtime.config';

@Injectable()
export class SharedRealtimeRedisAdapter implements OnModuleDestroy {
  private pubClient: IORedis | null = null;
  private subClient: IORedis | null = null;

  constructor(@Inject(SHARED_REALTIME_CONFIG) private readonly config: SharedRealtimeConfig) {}

  async apply(namespace: Namespace): Promise<void> {
    if (this.config.transport !== 'redis' || !this.config.redisUrl) return;
    const options = {
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: 1,
      connectionName: 'lingfang-plugin-shared-socket-adapter',
    } as const;
    this.pubClient = new IORedis(this.config.redisUrl, options);
    this.subClient = new IORedis(this.config.redisUrl, {
      ...options,
      connectionName: 'lingfang-plugin-shared-socket-subscriber',
    });
    this.pubClient.on('error', () => undefined);
    this.subClient.on('error', () => undefined);
    try {
      await Promise.all([this.pubClient.connect(), this.subClient.connect()]);
      await Promise.all([this.pubClient.ping(), this.subClient.ping()]);
      // redis-adapter intentionally fires several Redis promises without
      // awaiting them (publish/subscription teardown). Attach a rejection
      // observer while preserving the original promise for callers that do
      // await it, otherwise a normal server shutdown becomes an unhandled
      // rejection in ioredis.
      namespace.server.adapter(
        createAdapter(
          handledRedisClient(this.pubClient) as never,
          handledRedisClient(this.subClient) as never
        )
      );
    } catch (error) {
      await this.close();
      throw new Error(
        `shared realtime Redis adapter unavailable: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private async close(): Promise<void> {
    const clients = [this.pubClient, this.subClient];
    this.pubClient = null;
    this.subClient = null;
    await Promise.all(
      clients.map(async (client) => {
        if (!client) return;
        if (client.status === 'wait' || client.status === 'end') client.disconnect(false);
        else await client.quit().catch(() => client.disconnect(false));
      })
    );
  }
}

function handledRedisClient(client: IORedis): IORedis {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args) as unknown;
        if (
          result &&
          typeof result === 'object' &&
          'catch' in result &&
          typeof result.catch === 'function'
        ) {
          void result.catch(() => undefined);
        }
        return result;
      };
    },
  });
}
