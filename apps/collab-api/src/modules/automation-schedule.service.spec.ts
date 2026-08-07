import { describe, expect, it, vi } from 'vitest';
import { AutomationScheduleService } from './automation-schedule.service';

function harness() {
  const now = new Date('2026-07-16T00:00:00.000Z');
  let stored: any;
  const outboxCreate = vi.fn(async ({ data }: any) => data);
  const scheduleModel = {
    create: vi.fn(
      async ({ data }: any) =>
        (stored = {
          runAt: null,
          timeZone: null,
          localTime: null,
          dayOfWeek: null,
          lastScheduledFor: null,
          lastRunId: null,
          consecutiveFailures: 0,
          syncErrorCode: '',
          createdAt: now,
          updatedAt: now,
          ...data,
        })
    ),
    findUnique: vi.fn(async () => stored),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (!stored || stored.generation !== where.generation) return { count: 0 };
      stored = { ...stored, ...data, updatedAt: now };
      return { count: 1 };
    }),
  };
  const tx: any = { automationSchedule: scheduleModel, automationOutbox: { create: outboxCreate } };
  const prisma: any = {
    automationSchedule: {
      findFirst: vi.fn(async () => stored),
      findMany: vi.fn(async () => (stored ? [stored] : [])),
    },
    workflowRelease: {
      findUnique: vi.fn(async () => ({
        pluginReleaseId: 'wr1',
        definitionSha256: 'd'.repeat(64),
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        cloudEligible: true,
        pluginRelease: { sha256: 'a'.repeat(64), status: 'PUBLISHED' },
      })),
    },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  const auth: any = {
    ensurePermission: vi.fn(async () => ({})),
    ensureCurrentTeam: vi.fn(async () => ({ teamId: 't1' })),
  };
  const governance: any = {
    authorizeRelease: vi.fn(async () => ({ decision: { policy_revision: 1 } })),
  };
  return {
    service: new AutomationScheduleService(prisma, auth, governance),
    governance,
    outboxCreate,
    scheduleModel,
    stored: () => stored,
  };
}

describe('AutomationScheduleService', () => {
  it('rejects new Cloud schedules with an explicit deprecation error', async () => {
    const h = harness();
    await expect(
      h.service.create('u1', {
        workflow_release_id: 'wr1',
        workflow_release_sha256: 'a'.repeat(64),
        kind: 'DAILY',
        time_zone: 'Asia/Shanghai',
        local_time: '09:30',
        input: {},
      })
    ).rejects.toMatchObject({ status: 410, code: 'cloud_disabled' });
    expect(h.outboxCreate).not.toHaveBeenCalled();
  });

  it('rejects updates that would execute a Cloud schedule', async () => {
    const h = harness();
    await expect(
      h.service.update('u1', 'schedule-1', {
        workflow_release_id: 'wr1',
        workflow_release_sha256: 'a'.repeat(64),
        kind: 'DAILY',
        time_zone: 'Asia/Shanghai',
        local_time: '09:30',
        input: {},
        expected_generation: 1,
      })
    ).rejects.toMatchObject({ status: 410, code: 'cloud_disabled' });
  });
});
