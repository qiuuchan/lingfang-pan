import { Inject, Injectable } from '@nestjs/common';
import type { AutomationConfig } from './automation-config';
import type { AutomationQueuePort, AutomationRedisReadiness } from './automation-queue';
import { AUTOMATION_CONFIG, AUTOMATION_QUEUE } from './automation.tokens';
import { PrismaService } from '../prisma.service';
import { CloudAbortBus } from './cloud-abort-bus';

@Injectable()
export class AutomationReadinessService {
  constructor(
    @Inject(AUTOMATION_CONFIG) private readonly config: AutomationConfig,
    @Inject(AUTOMATION_QUEUE) private readonly queue: AutomationQueuePort,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CloudAbortBus) private readonly abortBus: CloudAbortBus,
  ) {}

  async check(): Promise<AutomationRedisReadiness & { processRole: AutomationConfig['processRole']; workers: { required: boolean; status: 'not_required' | 'ready' | 'missing'; count: number; latest_age_ms: number | null } }> {
    const base = await this.queue.checkReadiness();
    const required = this.config.enabled && this.config.runsWorker;
    const heartbeats = base.redis === 'up' ? await this.queue.listWorkerHeartbeats().catch(() => []) : [];
    const latest = heartbeats.reduce<number | null>((value, item) => { const time = Date.parse(item.updated_at); return Number.isFinite(time) && (value === null || time > value) ? time : value; }, null);
    const workers = { required, status: !required ? 'not_required' as const : heartbeats.length ? 'ready' as const : 'missing' as const, count: heartbeats.length, latest_age_ms: latest === null ? null : Math.max(0, Date.now() - latest) };
    return { ...base, ...(required && workers.status !== 'ready' ? { status: 'degraded' as const } : {}), processRole: this.config.processRole, workers };
  }

  async metrics() {
    const [queue, outboxPending, outboxDead, activeSchedules, readyEndpoints, unhealthyEndpoints] = await Promise.all([
      this.check(),
      this.prisma.automationOutbox.count({ where: { status: 'PENDING' } }),
      this.prisma.automationOutbox.count({ where: { status: 'FAILED' } }),
      this.prisma.automationSchedule.count({ where: { status: 'ACTIVE' } }),
      this.prisma.cloudActionDeployment.count({ where: { status: 'READY' } }),
      this.prisma.cloudActionDeployment.count({ where: { status: 'READY', lastHealthOk: false } }),
    ]);
    return { queue, abort: this.abortBus.metrics(), outbox: { pending: outboxPending, dead: outboxDead }, schedules: { active: activeSchedules }, endpoints: { ready: readyEndpoints, unhealthy: unhealthyEndpoints }, observed_at: new Date().toISOString() };
  }
}
