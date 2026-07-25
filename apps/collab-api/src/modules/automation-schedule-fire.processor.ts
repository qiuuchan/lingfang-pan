import { Inject, Injectable, Optional } from '@nestjs/common';
import { AppError } from '../common';
import { nextRecurringOccurrence, scheduleOccurrenceKey } from '../automation/automation-schedule-time';
import type { AutomationConfig } from '../automation/automation-config';
import { AUTOMATION_CONFIG } from '../automation/automation.tokens';
import { PrismaService } from '../prisma.service';
import { WorkflowRunService } from './workflow-run.service';

export type ScheduleFireJob =
  | { kind: 'REPEAT'; schedule_id: string; generation: number; scheduler_key: string; prev_millis: number; repeat_job_key: string }
  | { kind: 'ONCE'; schedule_id: string; generation: number; scheduler_key: string; scheduled_for: string; occurrence_key: string }
  | { kind: 'RECOVERY'; schedule_id: string; generation: number; scheduler_key: string; scheduled_for: string; occurrence_key: string };

export type ScheduleFireResult =
  | { outcome: 'DISABLED' | 'STALE' | 'DEPRECATED'; run_id: null }
  | { outcome: 'DUPLICATE' | 'CREATED'; run_id: string };

@Injectable()
export class AutomationScheduleFireProcessor {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(WorkflowRunService) private readonly runs: WorkflowRunService, @Optional() @Inject(AUTOMATION_CONFIG) private readonly config?: AutomationConfig) {}

  async process(job: ScheduleFireJob): Promise<ScheduleFireResult> {
    if (this.config) return { outcome: 'DEPRECATED', run_id: null };
    const schedule = await this.prisma.automationSchedule.findFirst({ where: { id: job.schedule_id, generation: job.generation, status: 'ACTIVE' } });
    if (!schedule) return { outcome: 'STALE' as const, run_id: null };
    if (schedule.schedulerKey !== job.scheduler_key) return { outcome: 'STALE' as const, run_id: null };
    let scheduledFor: Date; let occurrenceKey: string;
    if (job.kind === 'REPEAT') {
      if ((schedule.kind !== 'DAILY' && schedule.kind !== 'WEEKLY') || job.repeat_job_key !== schedule.schedulerKey || !Number.isFinite(job.prev_millis)) return { outcome: 'STALE' as const, run_id: null };
      scheduledFor = new Date(job.prev_millis); occurrenceKey = scheduleOccurrenceKey(schedule.id, schedule.generation, scheduledFor);
    } else {
      scheduledFor = new Date(job.scheduled_for); occurrenceKey = job.occurrence_key;
      if (Number.isNaN(scheduledFor.getTime()) || occurrenceKey !== scheduleOccurrenceKey(schedule.id, schedule.generation, scheduledFor)) return { outcome: 'STALE' as const, run_id: null };
      if (job.kind === 'ONCE') {
        if (schedule.kind !== 'ONCE' || !schedule.runAt || schedule.runAt.getTime() !== scheduledFor.getTime()) return { outcome: 'STALE' as const, run_id: null };
      } else if ((schedule.kind !== 'DAILY' && schedule.kind !== 'WEEKLY') || !schedule.nextRunAt || schedule.nextRunAt.getTime() !== scheduledFor.getTime()) return { outcome: 'STALE' as const, run_id: null };
    }
    const existing = await this.prisma.workflowRun.findUnique({ where: { scheduleId_scheduleGeneration_occurrenceKey: { scheduleId: schedule.id, scheduleGeneration: schedule.generation, occurrenceKey } } });
    if (existing) return { outcome: 'DUPLICATE' as const, run_id: existing.id };
    try {
      const created = await this.runs.startScheduled(schedule.createdByUserId, schedule, scheduledFor, occurrenceKey);
      if (schedule.kind !== 'ONCE') {
        const trigger = schedule.kind === 'DAILY' ? { kind: 'DAILY' as const, timeZone: String(schedule.timeZone), localTime: String(schedule.localTime) } : { kind: 'WEEKLY' as const, timeZone: String(schedule.timeZone), localTime: String(schedule.localTime), dayOfWeek: Number(schedule.dayOfWeek) };
        let nextRunAt = nextRecurringOccurrence(trigger, scheduledFor);
        const now = new Date();
        while (nextRunAt <= now) nextRunAt = nextRecurringOccurrence(trigger, nextRunAt);
        await this.prisma.automationSchedule.updateMany({ where: { id: schedule.id, generation: schedule.generation, status: 'ACTIVE' }, data: { nextRunAt } });
      }
      return { outcome: 'CREATED' as const, run_id: created.run.id };
    } catch (error) {
      const raced = await this.prisma.workflowRun.findUnique({ where: { scheduleId_scheduleGeneration_occurrenceKey: { scheduleId: schedule.id, scheduleGeneration: schedule.generation, occurrenceKey } } });
      if (raced) return { outcome: 'DUPLICATE' as const, run_id: raced.id };
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'automation_queue_unavailable', '自动化计划触发失败');
    }
  }
}
