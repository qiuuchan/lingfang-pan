import { Injectable, OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';
import type { AutomationConfig } from './automation-config';

type AbortMessage = {
  kind: 'RUN' | 'INVOCATION' | 'KILL_SWITCH';
  id: string;
  reason: string;
  issued_at: string;
};
export const cloudAbortChannel = (prefix: string) => `${prefix}:cloud-abort:v1`;

@Injectable()
export class CloudAbortBus implements OnModuleDestroy {
  private publisher?: IORedis;
  private subscriber?: IORedis;
  private readonly active = new Map<string, Set<AbortController>>();
  private received = 0;
  private published = 0;
  constructor(private readonly config: AutomationConfig) {}
  async start() {
    if (!this.config.redisUrl || !this.config.enabled) return;
    if (this.subscriber) return;
    this.publisher = new IORedis(this.config.redisUrl, {
      connectionName: `lingfang-cloud-abort-pub-${process.pid}`,
    });
    this.subscriber = new IORedis(this.config.redisUrl, {
      connectionName: `lingfang-cloud-abort-sub-${process.pid}`,
    });
    this.publisher.on('error', () => undefined);
    this.subscriber.on('error', () => undefined);
    await this.subscriber.subscribe(cloudAbortChannel(this.config.redisPrefix));
    this.subscriber.on('message', (_channel, raw) => {
      try {
        this.abort(JSON.parse(raw) as AbortMessage);
      } catch {
        /* malformed broadcasts are ignored */
      }
    });
  }
  async broadcast(message: Omit<AbortMessage, 'issued_at'>) {
    if (!this.publisher) await this.start();
    if (!this.publisher) return 0;
    this.published += 1;
    return this.publisher.publish(
      cloudAbortChannel(this.config.redisPrefix),
      JSON.stringify({ ...message, issued_at: new Date().toISOString() })
    );
  }
  async run<T>(
    runId: string,
    invocationId: string,
    operation: (signal: AbortSignal) => Promise<T>
  ) {
    await this.start();
    const controller = new AbortController();
    const keys = [`RUN:${runId}`, `INVOCATION:${invocationId}`, 'KILL_SWITCH:*'];
    keys.forEach((key) => {
      const set = this.active.get(key) ?? new Set();
      set.add(controller);
      this.active.set(key, set);
    });
    try {
      return await operation(controller.signal);
    } finally {
      keys.forEach((key) => {
        const set = this.active.get(key);
        set?.delete(controller);
        if (set?.size === 0) this.active.delete(key);
      });
    }
  }
  metrics() {
    return {
      active_abort_controllers: new Set([...this.active.values()].flatMap((set) => [...set])).size,
      abort_broadcasts_published: this.published,
      abort_broadcasts_received: this.received,
    };
  }
  private abort(message: AbortMessage) {
    const key = message.kind === 'KILL_SWITCH' ? 'KILL_SWITCH:*' : `${message.kind}:${message.id}`;
    const controllers = this.active.get(key);
    if (!controllers?.size) return;
    this.received += 1;
    controllers.forEach((controller) =>
      controller.abort(new Error(message.reason || 'cloud execution aborted'))
    );
  }
  async close() {
    const clients = [this.subscriber, this.publisher].filter(Boolean) as IORedis[];
    this.subscriber = undefined;
    this.publisher = undefined;
    await Promise.allSettled(
      clients.map((client) => client.quit().catch(() => client.disconnect(false)))
    );
  }
  async onModuleDestroy() {
    await this.close();
  }
}
