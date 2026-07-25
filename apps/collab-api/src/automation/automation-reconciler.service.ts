import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { scheduleOccurrenceKey } from './automation-schedule-time';
import type { AutomationConfig } from './automation-config';
import { AutomationControlProcessor } from './automation-control.processor';
import { AutomationSchedulerService } from './automation-scheduler.service';
import { AUTOMATION_CONFIG } from './automation.tokens';
import { AutomationScheduleFireProcessor } from '../modules/automation-schedule-fire.processor';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AutomationReconcilerService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTOMATION_CONFIG) private readonly config: AutomationConfig,
    private readonly scheduler: AutomationSchedulerService,
    private readonly control: AutomationControlProcessor,
    private readonly fire: AutomationScheduleFireProcessor,
  ) {}

  onModuleInit(): void {
    if (!this.config.runsScheduler) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcileOnce(now = new Date()): Promise<{ schedules: number; runs: number; missed: number; recovered: number }> {
    const result = { schedules: 0, runs: 0, missed: 0, recovered: 0 };
    if (!this.config.enabled || !this.config.schedulesEnabled) {
      const active = await this.prisma.automationSchedule.findMany({ where: { status: 'ACTIVE' }, select: { id: true, generation: true }, take: 250 });
      for (const schedule of active) await this.scheduler.remove(schedule.id, schedule.generation).catch(() => undefined);
      await this.reconcileRuns(result);
      return result;
    }
    const schedules = await this.prisma.automationSchedule.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      take: 250,
    });
    for (const schedule of schedules) {
      result.schedules += 1;
      await this.refreshFailureProjection(schedule.id, schedule.createdByUserId);
      if (schedule.kind === 'ONCE' && schedule.runAt && schedule.runAt.getTime() < now.getTime() - this.config.onceMisfireWindowMs) {
        const changed = await this.prisma.automationSchedule.updateMany({
          where: { id: schedule.id, generation: schedule.generation, status: 'ACTIVE' },
          data: { status: 'MISSED', nextRunAt: null, syncState: 'PENDING', syncErrorCode: 'schedule_missed' },
        });
        if (changed.count === 1) {
          result.missed += 1;
          await this.notifyOnce(schedule.createdByUserId, 'automation_schedule_missed', '自动化计划已错过', '单次自动化计划超过补跑窗口，已标记为 MISSED。', 'AutomationSchedule', schedule.id);
          await this.scheduler.remove(schedule.id, schedule.generation);
        }
        continue;
      }
      if (schedule.nextRunAt && schedule.nextRunAt <= now) {
        const occurrenceKey = scheduleOccurrenceKey(schedule.id, schedule.generation, schedule.nextRunAt);
        const fire = schedule.kind === 'ONCE'
          ? await this.fire.process({ kind: 'ONCE', schedule_id: schedule.id, generation: schedule.generation, scheduler_key: schedule.schedulerKey, scheduled_for: schedule.nextRunAt.toISOString(), occurrence_key: occurrenceKey })
          : await this.fire.process({ kind: 'RECOVERY', schedule_id: schedule.id, generation: schedule.generation, scheduler_key: schedule.schedulerKey, scheduled_for: schedule.nextRunAt.toISOString(), occurrence_key: occurrenceKey });
        if (fire.outcome === 'DEPRECATED') {
          // Historical Cloud rows remain readable, but must not be re-enqueued by a
          // worker that happens to start with legacy automation flags enabled.
          await this.scheduler.remove(schedule.id, schedule.generation).catch(() => undefined);
          continue;
        }
        if (fire.outcome === 'CREATED' || fire.outcome === 'DUPLICATE') result.recovered += 1;
      }
      const current = await this.prisma.automationSchedule.findUnique({ where: { id: schedule.id }, select: { generation: true, status: true } });
      if (current?.generation === schedule.generation && current.status === 'ACTIVE') await this.scheduler.upsert(schedule.id, schedule.generation, now);
    }

    await this.reconcileRuns(result);
    return result;
  }

  private async reconcileRuns(result: { runs: number }): Promise<void> {
    const runs = await this.prisma.workflowRun.findMany({
      where: { executionTarget: 'CLOUD', status: { in: ['RUNNING', 'FAILING', 'CANCELING'] } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 250,
      select: { id: true, scheduleGeneration: true, status: true },
    });
    for (const run of runs) {
      result.runs += 1;
      await this.control.process({ name: run.status === 'CANCELING' ? 'run.cancel' : 'run.coordinate', data: { run_id: run.id, generation: run.scheduleGeneration ?? 0 } }).catch(() => undefined);
    }
  }

  private async refreshFailureProjection(scheduleId: string, ownerUserId: string): Promise<void> {
    const recent = await this.prisma.workflowRun.findMany({
      where: { scheduleId, status: { in: ['SUCCEEDED', 'FAILED', 'CANCELED'] } },
      orderBy: [{ scheduledFor: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { id: true, status: true },
    });
    let failures = 0;
    for (const run of recent) {
      if (run.status !== 'FAILED') break;
      failures += 1;
    }
    await this.prisma.automationSchedule.updateMany({ where: { id: scheduleId, consecutiveFailures: { not: failures } }, data: { consecutiveFailures: failures } });
    if (failures >= this.config.consecutiveFailureNotifyThreshold) {
      const episodeBoundary = recent[failures]?.id ?? 'initial';
      await this.notifyOnce(ownerUserId, `automation_schedule_consecutive_failure:${episodeBoundary}`, '自动化计划连续失败', `该计划已连续失败 ${failures} 次，请检查工作流节点和 Cloud endpoint。`, 'AutomationSchedule', scheduleId);
    }
  }

  private async notifyOnce(userId: string, type: string, title: string, body: string, relatedType: string, relatedId: string): Promise<void> {
    const exists = await this.prisma.notification.findFirst({ where: { userId, type, relatedType, relatedId }, select: { id: true } });
    if (exists) return;
    await this.prisma.notification.create({ data: { userId, type, title, body, relatedType, relatedId } });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.reconcileOnce(); } catch { /* readiness exposes dependency failures; the next tick retries from Prisma truth. */ }
    finally { this.running = false; }
  }
}
