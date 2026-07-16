import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { Queue, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { scheduleOccurrenceKey } from './automation-schedule-time';
import type { AutomationConfig } from './automation-config';
import { AUTOMATION_CONTROL_QUEUE, automationRedisConnectionName } from './automation-queue';
import { AUTOMATION_CONFIG } from './automation.tokens';
import { PrismaService } from '../prisma.service';

type ScheduleProjection = {
  id: string;
  generation: number;
  schedulerKey: string;
  kind: 'ONCE' | 'DAILY' | 'WEEKLY';
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'MISSED' | 'DELETED';
  runAt: Date | null;
  nextRunAt: Date | null;
  timeZone: string | null;
  localTime: string | null;
  dayOfWeek: number | null;
};

export interface AutomationSchedulerPort {
  upsertRecurring(input: { schedulerKey: string; pattern: string; timeZone: string; data: Record<string, unknown> }): Promise<void>;
  upsertOnce(input: { jobId: string; delayMs: number; data: Record<string, unknown> }): Promise<void>;
  removeSchedule(scheduleId: string, throughGeneration: number): Promise<void>;
  close(): Promise<void>;
}

export const AUTOMATION_SCHEDULER_PORT = Symbol('AUTOMATION_SCHEDULER_PORT');

class DisabledAutomationSchedulerPort implements AutomationSchedulerPort {
  async upsertRecurring(): Promise<void> { throw new Error('automation_scheduler_not_available_for_process_role'); }
  async upsertOnce(): Promise<void> { throw new Error('automation_scheduler_not_available_for_process_role'); }
  async removeSchedule(): Promise<void> { throw new Error('automation_scheduler_not_available_for_process_role'); }
  async close(): Promise<void> {}
}

class BullMqAutomationSchedulerPort implements AutomationSchedulerPort {
  private readonly redis: IORedis;
  private readonly queue: Queue;

  constructor(config: AutomationConfig) {
    if (!config.redisUrl) throw new Error('automation scheduler requires AUTOMATION_REDIS_URL');
    this.redis = new IORedis(config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      connectionName: automationRedisConnectionName('automation-scheduler', config.redisPrefix),
    });
    this.redis.on('error', () => undefined);
    this.queue = new Queue(AUTOMATION_CONTROL_QUEUE, { connection: this.redis, prefix: config.redisPrefix });
  }

  async upsertRecurring(input: { schedulerKey: string; pattern: string; timeZone: string; data: Record<string, unknown> }): Promise<void> {
    await this.queue.upsertJobScheduler(
      input.schedulerKey,
      { pattern: input.pattern, tz: input.timeZone },
      { name: 'schedule.repeat_fire', data: input.data, opts: { attempts: 1, removeOnComplete: 1_000, removeOnFail: 5_000 } },
    );
  }

  async upsertOnce(input: { jobId: string; delayMs: number; data: Record<string, unknown> }): Promise<void> {
    await this.queue.add('schedule.once_fire', input.data, {
      jobId: input.jobId,
      delay: Math.max(0, Math.trunc(input.delayMs)),
      attempts: 1,
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
  }

  async removeSchedule(scheduleId: string, throughGeneration: number): Promise<void> {
    const prefix = `schedule-${scheduleId}-g`;
    const schedulers = await this.queue.getJobSchedulers(0, 10_000, true);
    await Promise.all(schedulers.filter((item) => String(item.key).startsWith(prefix)).map((item) => this.queue.removeJobScheduler(String(item.key))));
    const jobs = await this.queue.getJobs(['delayed', 'wait', 'prioritized'], 0, 10_000, true);
    await Promise.all(jobs.filter((job: Job) => {
      const data = job.data as Record<string, unknown>;
      return data.schedule_id === scheduleId && Number(data.generation) <= throughGeneration;
    }).map((job) => job.remove().catch(() => undefined)));
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.redis.quit().catch(() => this.redis.disconnect(false));
  }
}

export function createAutomationSchedulerPort(config: AutomationConfig): AutomationSchedulerPort {
  return config.connectsToRedis && config.redisUrl ? new BullMqAutomationSchedulerPort(config) : new DisabledAutomationSchedulerPort();
}

function cronPattern(schedule: ScheduleProjection): { pattern: string; timeZone: string } {
  const [hour, minute] = String(schedule.localTime).split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || !schedule.timeZone) throw new Error('automation_schedule_projection_invalid');
  if (schedule.kind === 'DAILY') return { pattern: `0 ${minute} ${hour} * * *`, timeZone: schedule.timeZone };
  const isoDay = Number(schedule.dayOfWeek);
  const cronDay = isoDay === 7 ? 0 : isoDay;
  if (!Number.isInteger(cronDay) || cronDay < 0 || cronDay > 6) throw new Error('automation_schedule_projection_invalid');
  return { pattern: `0 ${minute} ${hour} * * ${cronDay}`, timeZone: schedule.timeZone };
}

@Injectable()
export class AutomationSchedulerService implements OnModuleDestroy {
  private readonly port: AutomationSchedulerPort;
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTOMATION_CONFIG) private readonly config: AutomationConfig,
    @Optional() @Inject(AUTOMATION_SCHEDULER_PORT) port?: AutomationSchedulerPort,
  ) { this.port = port ?? createAutomationSchedulerPort(config); }

  async upsert(scheduleId: string, generation: number, now = new Date()): Promise<{ outcome: 'SYNCED' | 'STALE' }> {
    const schedule = await this.prisma.automationSchedule.findFirst({ where: { id: scheduleId, generation } }) as ScheduleProjection | null;
    if (!schedule || schedule.status !== 'ACTIVE') return { outcome: 'STALE' };
    try {
      await this.port.removeSchedule(schedule.id, Math.max(0, generation - 1));
      const data = { schedule_id: schedule.id, generation: schedule.generation, scheduler_key: schedule.schedulerKey };
      if (schedule.kind === 'ONCE') {
        if (!schedule.runAt) throw new Error('automation_schedule_projection_invalid');
        await this.port.upsertOnce({
          jobId: `lf-schedule-once-${schedule.id.replace(/[^A-Za-z0-9_-]/g, '-')}-g${schedule.generation}`,
          delayMs: schedule.runAt.getTime() - now.getTime(),
          data: { ...data, scheduled_for: schedule.runAt.toISOString(), occurrence_key: scheduleOccurrenceKey(schedule.id, schedule.generation, schedule.runAt) },
        });
      } else {
        const cron = cronPattern(schedule);
        await this.port.upsertRecurring({ schedulerKey: schedule.schedulerKey, ...cron, data });
      }
      await this.prisma.automationSchedule.updateMany({ where: { id: schedule.id, generation, status: 'ACTIVE' }, data: { syncState: 'SYNCED', syncErrorCode: '' } });
      return { outcome: 'SYNCED' };
    } catch (error) {
      await this.prisma.automationSchedule.updateMany({ where: { id: schedule.id, generation }, data: { syncState: 'ERROR', syncErrorCode: this.errorCode(error) } });
      throw error;
    }
  }

  async remove(scheduleId: string, generation: number): Promise<{ outcome: 'SYNCED' | 'STALE' }> {
    const schedule = await this.prisma.automationSchedule.findFirst({ where: { id: scheduleId, generation } }) as ScheduleProjection | null;
    if (!schedule) return { outcome: 'STALE' };
    try {
      await this.port.removeSchedule(scheduleId, generation);
      await this.prisma.automationSchedule.updateMany({ where: { id: scheduleId, generation }, data: { syncState: 'SYNCED', syncErrorCode: '' } });
      return { outcome: 'SYNCED' };
    } catch (error) {
      await this.prisma.automationSchedule.updateMany({ where: { id: scheduleId, generation }, data: { syncState: 'ERROR', syncErrorCode: this.errorCode(error) } });
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> { await this.port.close(); }

  private errorCode(error: unknown): string {
    const code = error instanceof Error && /^[a-z0-9_]{1,120}$/i.test(error.message) ? error.message : 'automation_scheduler_unavailable';
    return code.slice(0, 120);
  }
}
