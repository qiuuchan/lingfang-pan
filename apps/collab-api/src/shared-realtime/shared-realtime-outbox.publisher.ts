import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SHARED_REALTIME_CONFIG } from './shared-realtime.tokens';
import type { SharedRealtimeConfig } from './shared-realtime.config';
import { SharedRealtimeBroadcaster } from './shared-realtime-broadcaster';

@Injectable()
export class SharedRealtimeOutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private publishing = false;

  constructor(
    @Inject(SHARED_REALTIME_CONFIG) private readonly config: SharedRealtimeConfig,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly broadcaster: SharedRealtimeBroadcaster,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) return;
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async publishOnce(limit = 100): Promise<{ delivered: number; failed: number; stale: number }> {
    const rows = await this.prisma.sharedStateOutbox.findMany({
      where: { publishedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(500, limit)),
      select: {
        id: true, teamId: true, namespaceId: true, namespaceGeneration: true,
        cursor: true, key: true, revision: true,
      },
    });
    const result = { delivered: 0, failed: 0, stale: 0 };
    for (const row of rows) {
      try {
        await this.broadcaster.invalidation(row);
        const updated = await this.prisma.sharedStateOutbox.updateMany({
          where: { id: row.id, publishedAt: null },
          data: { publishedAt: new Date(), attempts: { increment: 1 } },
        });
        if (updated.count === 1) result.delivered += 1;
        else result.stale += 1;
      } catch {
        await this.prisma.sharedStateOutbox.updateMany({
          where: { id: row.id, publishedAt: null },
          data: { attempts: { increment: 1 } },
        }).catch(() => undefined);
        result.failed += 1;
      }
    }
    return result;
  }

  private async tick(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;
    try { await this.publishOnce(); } catch { /* Readiness owns database dependency reporting. */ }
    finally { this.publishing = false; }
  }
}
