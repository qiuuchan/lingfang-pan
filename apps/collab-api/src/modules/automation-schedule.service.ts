import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { AppError, conflict, notFound } from '../common';
import {
  nextRecurringOccurrence,
  assertIanaTimeZone,
  parseLocalTime,
} from '../automation/automation-schedule-time';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import type {
  CreateAutomationScheduleDto,
  UpdateAutomationScheduleDto,
} from './dto/automation-schedule.dto';
import { PluginGovernanceService } from './plugin-governance.service';
import { assertActionValue } from './action-schema-validator';
import type { AutomationConfig } from '../automation/automation-config';
import { AUTOMATION_CONFIG } from '../automation/automation.tokens';

type TriggerFields = {
  kind: 'ONCE' | 'DAILY' | 'WEEKLY';
  runAt: Date | null;
  timeZone: string | null;
  localTime: string | null;
  dayOfWeek: number | null;
  nextRunAt: Date;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

@Injectable()
export class AutomationScheduleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PluginGovernanceService) private readonly governance: PluginGovernanceService,
    @Optional() @Inject(AUTOMATION_CONFIG) private readonly config?: AutomationConfig
  ) {}

  async list(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const rows = await this.prisma.automationSchedule.findMany({
      where: { teamId: membership.teamId, status: { not: 'DELETED' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { schedules: rows.map((row) => this.publicSchedule(row)) };
  }

  async create(userId: string, input: CreateAutomationScheduleDto) {
    this.assertSchedulesEnabled();
    const membership = await this.managementContext(userId);
    const workflow = await this.validateWorkflow(
      userId,
      input.workflow_release_id,
      input.workflow_release_sha256,
      input.input
    );
    const trigger = this.trigger(input);
    const id = randomUUID();
    const generation = 1;
    const schedulerKey = this.schedulerKey(id, generation);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.automationSchedule.create({
        data: {
          id,
          teamId: membership.teamId,
          createdByUserId: userId,
          workflowReleaseId: input.workflow_release_id,
          workflowReleaseSha256: input.workflow_release_sha256,
          ...trigger,
          inputJson: input.input as Prisma.InputJsonValue,
          inputSchemaSha256: workflow.inputSchemaSha256,
          generation,
          schedulerKey,
          status: 'ACTIVE',
          syncState: 'PENDING',
        },
      });
      await tx.automationOutbox.create({
        data: {
          kind: 'UPSERT_SCHEDULE',
          aggregateId: id,
          generation,
          payload: { schedule_id: id, generation, scheduler_key: schedulerKey },
        },
      });
      return created;
    });
    return { schedule: this.publicSchedule(row) };
  }

  async update(userId: string, id: string, input: UpdateAutomationScheduleDto) {
    this.assertSchedulesEnabled();
    const { membership, schedule } = await this.owned(userId, id);
    if (schedule.status === 'DELETED') throw notFound('自动化计划不存在');
    const workflow = await this.validateWorkflow(
      userId,
      input.workflow_release_id,
      input.workflow_release_sha256,
      input.input
    );
    const trigger = this.trigger(input);
    const generation = input.expected_generation + 1;
    const schedulerKey = this.schedulerKey(id, generation);
    return this.change(
      (tx) =>
        tx.automationSchedule.updateMany({
          where: {
            id,
            teamId: membership.teamId,
            generation: input.expected_generation,
            status: { not: 'DELETED' },
          },
          data: {
            workflowReleaseId: input.workflow_release_id,
            workflowReleaseSha256: input.workflow_release_sha256,
            ...trigger,
            inputJson: input.input as Prisma.InputJsonValue,
            inputSchemaSha256: workflow.inputSchemaSha256,
            generation,
            schedulerKey,
            status: 'ACTIVE',
            syncState: 'PENDING',
            syncErrorCode: '',
          },
        }),
      id,
      generation,
      schedulerKey,
      'UPSERT_SCHEDULE'
    );
  }

  async pause(userId: string, id: string, expectedGeneration: number) {
    return this.setLifecycle(userId, id, expectedGeneration, 'ACTIVE', 'PAUSED', 'REMOVE_SCHEDULE');
  }
  async resume(userId: string, id: string, expectedGeneration: number) {
    this.assertSchedulesEnabled();
    return this.setLifecycle(userId, id, expectedGeneration, 'PAUSED', 'ACTIVE', 'UPSERT_SCHEDULE');
  }
  async remove(userId: string, id: string, expectedGeneration: number) {
    return this.setLifecycle(userId, id, expectedGeneration, null, 'DELETED', 'REMOVE_SCHEDULE');
  }

  private async setLifecycle(
    userId: string,
    id: string,
    expectedGeneration: number,
    expectedStatus: 'ACTIVE' | 'PAUSED' | null,
    status: 'ACTIVE' | 'PAUSED' | 'DELETED',
    outboxKind: 'UPSERT_SCHEDULE' | 'REMOVE_SCHEDULE'
  ) {
    const { membership, schedule } = await this.owned(userId, id);
    await this.authorizeManage(
      userId,
      schedule.workflowReleaseId,
      schedule.workflowReleaseSha256,
      schedule.inputJson
    );
    const generation = expectedGeneration + 1;
    const schedulerKey = this.schedulerKey(id, generation);
    const nextRunAt = status === 'ACTIVE' ? this.nextForStored(schedule) : null;
    return this.change(
      (tx) =>
        tx.automationSchedule.updateMany({
          where: {
            id,
            teamId: membership.teamId,
            generation: expectedGeneration,
            status: expectedStatus ?? { not: 'DELETED' },
          },
          data: {
            status,
            generation,
            schedulerKey,
            nextRunAt,
            syncState: 'PENDING',
            syncErrorCode: '',
          },
        }),
      id,
      generation,
      schedulerKey,
      outboxKind
    );
  }

  private async change(
    update: (tx: Prisma.TransactionClient) => Promise<{ count: number }>,
    id: string,
    generation: number,
    schedulerKey: string,
    kind: 'UPSERT_SCHEDULE' | 'REMOVE_SCHEDULE'
  ) {
    const row = await this.prisma.$transaction(async (tx) => {
      const changed = await update(tx);
      if (changed.count !== 1) throw conflict('自动化计划 generation 或状态已变化');
      await tx.automationOutbox.create({
        data: {
          kind,
          aggregateId: id,
          generation,
          payload: { schedule_id: id, generation, scheduler_key: schedulerKey },
        },
      });
      return tx.automationSchedule.findUnique({ where: { id } });
    });
    if (!row) throw notFound('自动化计划不存在');
    return { schedule: this.publicSchedule(row) };
  }

  private async managementContext(userId: string) {
    await this.auth.ensurePermission(userId, 'team.plugin.edit_draft');
    return this.auth.ensureCurrentTeam(userId);
  }
  private async owned(userId: string, id: string) {
    const membership = await this.managementContext(userId);
    const schedule = await this.prisma.automationSchedule.findFirst({
      where: { id, teamId: membership.teamId },
    });
    if (!schedule) throw notFound('自动化计划不存在');
    return { membership, schedule };
  }

  private async validateWorkflow(
    userId: string,
    releaseId: string,
    sha256: string,
    input: Record<string, unknown>
  ) {
    const workflow = await this.prisma.workflowRelease.findUnique({
      where: { pluginReleaseId: releaseId },
      include: { pluginRelease: true },
    });
    if (
      !workflow ||
      workflow.pluginRelease.sha256 !== sha256 ||
      workflow.pluginRelease.status !== 'PUBLISHED' ||
      !workflow.cloudEligible
    )
      throw new AppError(409, 'workflow_cloud_ineligible', '工作流不能创建 Cloud 自动化计划');
    assertActionValue(workflow.inputSchema, input, 'input');
    await this.authorizeManage(userId, releaseId, sha256, input, workflow.definitionSha256);
    return { inputSchemaSha256: digest(workflow.inputSchema) };
  }

  private async authorizeManage(
    userId: string,
    releaseId: string,
    sha256: string,
    _input: unknown,
    planSha256 = sha256
  ) {
    await this.governance.authorizeRelease(userId, { releaseId, sha256 }, ['manage_schedule'], {
      workflow: { workflow_release_id: releaseId, workflow_plan_sha256: planSha256 },
    });
  }

  private trigger(input: CreateAutomationScheduleDto): TriggerFields {
    if (input.kind === 'ONCE') {
      const runAt = new Date(String(input.run_at));
      if (!Number.isFinite(runAt.getTime()) || runAt <= new Date())
        throw new AppError(400, 'automation_schedule_invalid', 'ONCE run_at 必须位于未来');
      if (input.time_zone || input.local_time || input.day_of_week)
        throw new AppError(400, 'automation_schedule_invalid', 'ONCE 不接受重复计划字段');
      return {
        kind: 'ONCE',
        runAt,
        timeZone: null,
        localTime: null,
        dayOfWeek: null,
        nextRunAt: runAt,
      };
    }
    if (input.run_at)
      throw new AppError(400, 'automation_schedule_invalid', '重复计划不接受 run_at');
    const timeZone = assertIanaTimeZone(String(input.time_zone));
    const localTime = String(input.local_time);
    parseLocalTime(localTime);
    if (input.kind === 'DAILY') {
      if (input.day_of_week !== undefined)
        throw new AppError(400, 'automation_schedule_invalid', 'DAILY 不接受 day_of_week');
      return {
        kind: 'DAILY',
        runAt: null,
        timeZone,
        localTime,
        dayOfWeek: null,
        nextRunAt: nextRecurringOccurrence({ kind: 'DAILY', timeZone, localTime }, new Date()),
      };
    }
    const dayOfWeek = Number(input.day_of_week);
    return {
      kind: 'WEEKLY',
      runAt: null,
      timeZone,
      localTime,
      dayOfWeek,
      nextRunAt: nextRecurringOccurrence(
        { kind: 'WEEKLY', timeZone, localTime, dayOfWeek },
        new Date()
      ),
    };
  }

  private nextForStored(schedule: any): Date {
    if (schedule.kind === 'ONCE') {
      if (!schedule.runAt || schedule.runAt <= new Date())
        throw new AppError(409, 'automation_schedule_invalid', '已过期 ONCE 计划不能恢复');
      return schedule.runAt;
    }
    return nextRecurringOccurrence(
      schedule.kind === 'DAILY'
        ? { kind: 'DAILY', timeZone: schedule.timeZone, localTime: schedule.localTime }
        : {
            kind: 'WEEKLY',
            timeZone: schedule.timeZone,
            localTime: schedule.localTime,
            dayOfWeek: schedule.dayOfWeek,
          },
      new Date()
    );
  }
  private schedulerKey(id: string, generation: number) {
    return `schedule-${id}-g${generation}`;
  }
  private assertSchedulesEnabled() {
    throw new AppError(410, 'cloud_disabled', 'Cloud 定时任务已弃用，请改用桌面端本地定时任务');
  }
  private publicSchedule(row: any) {
    return {
      id: row.id,
      workflow_release_id: row.workflowReleaseId,
      workflow_release_sha256: row.workflowReleaseSha256,
      trigger:
        row.kind === 'ONCE'
          ? { kind: 'ONCE', run_at: row.runAt.toISOString() }
          : row.kind === 'DAILY'
            ? { kind: 'DAILY', time_zone: row.timeZone, local_time: row.localTime }
            : {
                kind: 'WEEKLY',
                time_zone: row.timeZone,
                local_time: row.localTime,
                day_of_week: row.dayOfWeek,
              },
      input: row.inputJson,
      status: row.status,
      generation: row.generation,
      scheduler_key: row.schedulerKey,
      next_run_at: row.nextRunAt?.toISOString() ?? null,
      last_scheduled_for: row.lastScheduledFor?.toISOString() ?? null,
      last_run_id: row.lastRunId,
      consecutive_failures: row.consecutiveFailures,
      sync_state: row.syncState,
      sync_error_code: row.syncErrorCode,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }
}
