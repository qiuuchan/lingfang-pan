import { describe, expect, it, vi } from 'vitest';
import { AutomationScheduleService } from './automation-schedule.service';

function harness() {
  const now = new Date('2026-07-16T00:00:00.000Z'); let stored: any;
  const outboxCreate = vi.fn(async ({ data }: any) => data);
  const scheduleModel = {
    create: vi.fn(async ({ data }: any) => (stored = { runAt: null, timeZone: null, localTime: null, dayOfWeek: null, lastScheduledFor: null, lastRunId: null, consecutiveFailures: 0, syncErrorCode: '', createdAt: now, updatedAt: now, ...data })),
    findUnique: vi.fn(async () => stored),
    updateMany: vi.fn(async ({ where, data }: any) => { if (!stored || stored.generation !== where.generation) return { count: 0 }; stored = { ...stored, ...data, updatedAt: now }; return { count: 1 }; }),
  };
  const tx: any = { automationSchedule: scheduleModel, automationOutbox: { create: outboxCreate } };
  const prisma: any = { automationSchedule: { findFirst: vi.fn(async () => stored), findMany: vi.fn(async () => stored ? [stored] : []) }, workflowRelease: { findUnique: vi.fn(async () => ({ pluginReleaseId: 'wr1', definitionSha256: 'd'.repeat(64), inputSchema: { type: 'object', additionalProperties: false, properties: {} }, cloudEligible: true, pluginRelease: { sha256: 'a'.repeat(64), status: 'PUBLISHED' } })) }, $transaction: vi.fn(async (fn: any) => fn(tx)) };
  const auth: any = { ensurePermission: vi.fn(async () => ({})), ensureCurrentTeam: vi.fn(async () => ({ teamId: 't1' })) };
  const governance: any = { authorizeRelease: vi.fn(async () => ({ decision: { policy_revision: 1 } })) };
  return { service: new AutomationScheduleService(prisma, auth, governance), governance, outboxCreate, scheduleModel, stored: () => stored };
}

describe('AutomationScheduleService', () => {
  it('creates a structured DAILY schedule and its generation-scoped outbox projection', async () => {
    const h = harness();
    const result = await h.service.create('u1', { workflow_release_id: 'wr1', workflow_release_sha256: 'a'.repeat(64), kind: 'DAILY', time_zone: 'Asia/Shanghai', local_time: '09:30', input: {} });
    expect(result.schedule).toMatchObject({ status: 'ACTIVE', generation: 1, sync_state: 'PENDING', trigger: { kind: 'DAILY', time_zone: 'Asia/Shanghai', local_time: '09:30' } });
    expect(h.governance.authorizeRelease).toHaveBeenCalledTimes(1);
    expect(h.governance.authorizeRelease).toHaveBeenCalledWith('u1', expect.anything(), ['manage_schedule'], expect.anything());
    expect(h.outboxCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'UPSERT_SCHEDULE', generation: 1, payload: expect.objectContaining({ generation: 1 }) }) });
  });

  it('pause increments generation and writes REMOVE_SCHEDULE without changing lifecycle to a sync status', async () => {
    const h = harness();
    const created = await h.service.create('u1', { workflow_release_id: 'wr1', workflow_release_sha256: 'a'.repeat(64), kind: 'ONCE', run_at: '2099-01-01T00:00:00.000Z', input: {} });
    const result = await h.service.pause('u1', created.schedule.id, 1);
    expect(result.schedule).toMatchObject({ status: 'PAUSED', generation: 2, sync_state: 'PENDING' });
    expect(h.outboxCreate).toHaveBeenLastCalledWith({ data: expect.objectContaining({ kind: 'REMOVE_SCHEDULE', generation: 2 }) });
  });
});
