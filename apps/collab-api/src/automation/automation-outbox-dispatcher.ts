import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AutomationConfig } from './automation-config';
import { AutomationOutboxService } from './automation-outbox.service';
import type { AutomationQueuePort } from './automation-queue';
import { AUTOMATION_CONFIG, AUTOMATION_QUEUE } from './automation.tokens';

export type AutomationDispatchResult = { claimed: number; delivered: number; retried: number; dead: number; stale: number };

@Injectable()
export class AutomationOutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly workerId = `outbox-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    @Inject(AUTOMATION_CONFIG) private readonly config: AutomationConfig,
    @Inject(AUTOMATION_QUEUE) private readonly queue: AutomationQueuePort,
    private readonly outbox: AutomationOutboxService,
  ) {}

  onModuleInit(): void {
    if (!this.config.runsOutboxDispatcher) return;
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async dispatchOnce(workerId = this.workerId): Promise<AutomationDispatchResult> {
    const rows = await this.outbox.claim(workerId);
    const result: AutomationDispatchResult = { claimed: rows.length, delivered: 0, retried: 0, dead: 0, stale: 0 };
    for (const row of rows) {
      try {
        if (row.kind === 'ENQUEUE_ACTION') {
          const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : {};
          const invocationId = typeof payload.invocation_id === 'string' ? payload.invocation_id : row.aggregateId;
          await this.queue.publishAction({ kind: 'STANDALONE_PREVIEW', invocation_id: invocationId });
        } else await this.queue.publishOutbox(row);
        if (await this.outbox.complete(row.id, workerId)) result.delivered += 1;
        else result.stale += 1;
      } catch {
        const outcome = await this.outbox.fail(row.id, workerId, 'automation_queue_unavailable');
        if (outcome === 'RETRY') result.retried += 1;
        else if (outcome === 'DEAD') result.dead += 1;
        else result.stale += 1;
      }
    }
    return result;
  }

  private async tick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try { await this.dispatchOnce(); } catch { /* DB and queue readiness report the dependency failure separately. */ }
    finally { this.draining = false; }
  }
}
