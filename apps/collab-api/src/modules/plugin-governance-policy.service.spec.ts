import { describe, expect, it, vi } from 'vitest';
import { PluginGovernancePolicyService } from './plugin-governance-policy.service';

const document = {
  schema_version: 1 as const,
  enforcement_mode: 'ENFORCE' as const,
  allowed_source_kinds: [],
  denied_capability_kinds: [],
  rules: [],
};

function harness() {
  let policy: any = null;
  const revisions: any[] = [];
  const audits: any[] = [];
  let nextId = 1;
  let lock = Promise.resolve();

  const activeRevision = () =>
    policy?.activeRevisionId
      ? (revisions.find((revision) => revision.id === policy.activeRevisionId) ?? null)
      : null;
  const tx: any = {
    teamPluginPolicy: {
      findUnique: vi.fn(async () =>
        policy ? { ...policy, activeRevision: activeRevision() } : null
      ),
      create: vi.fn(async ({ data }: any) => {
        if (policy) throw new Error('duplicate policy');
        policy = { id: 'policy-1', ...data, activeRevisionId: null };
        return { ...policy, activeRevision: null };
      }),
      update: vi.fn(async ({ data }: any) => {
        policy = { ...policy, ...data };
        return { ...policy, activeRevision: activeRevision() };
      }),
    },
    teamPluginPolicyRevision: {
      create: vi.fn(async ({ data }: any) => {
        const revision = {
          id: `revision-${nextId}`,
          createdAt: new Date('2026-07-16T00:00:00.000Z'),
          ...data,
        };
        nextId += 1;
        revisions.push(revision);
        return revision;
      }),
      findFirst: vi.fn(
        async ({ where }: any) =>
          revisions.find(
            (revision) =>
              revision.policyId === where.policyId &&
              revision.teamId === where.teamId &&
              revision.revision === where.revision
          ) ?? null
      ),
      findMany: vi.fn(async () =>
        [...revisions].sort((left, right) => right.revision - left.revision)
      ),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audits.push(data);
        return data;
      }),
    },
  };
  const prisma: any = {
    $transaction: vi.fn(async (operation: (client: any) => Promise<unknown>) => {
      // Serialize the fake transactions just like a database SERIALIZABLE
      // transaction, so the second caller observes the first new revision.
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation(tx);
      } finally {
        release();
      }
    }),
    teamPluginPolicy: tx.teamPluginPolicy,
    teamPluginPolicyRevision: tx.teamPluginPolicyRevision,
  };
  return {
    service: new PluginGovernancePolicyService(prisma),
    prisma,
    tx,
    getState: () => ({ policy, revisions, audits }),
  };
}

describe('PluginGovernancePolicyService concurrency', () => {
  it('allows only one publish from the same expected revision and keeps history immutable', async () => {
    const h = harness();
    const results = await Promise.allSettled([
      h.service.publish('team-1', 'admin-a', 0, document, 'first'),
      h.service.publish('team-1', 'admin-b', 0, document, 'second'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'conflict', status: 409 });

    const state = h.getState();
    expect(state.revisions).toHaveLength(1);
    expect(state.revisions[0]).toMatchObject({
      revision: 1,
      changeReason: expect.stringMatching(/first|second/),
    });
    expect(state.audits).toHaveLength(1);
    expect(await h.service.history('team-1')).toHaveLength(1);
  });

  it('serializes rollback against a concurrent writer and creates a monotonic copy-forward revision', async () => {
    const h = harness();
    await h.service.publish('team-1', 'admin-a', 0, document, 'initial');
    const secondDocument = { ...document, enforcement_mode: 'AUDIT' as const };
    await h.service.publish('team-1', 'admin-a', 1, secondDocument, 'second');

    const results = await Promise.allSettled([
      h.service.rollback('team-1', 'admin-a', 2, 1, 'restore'),
      h.service.rollback('team-1', 'admin-b', 2, 1, 'racing restore'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'conflict', status: 409 });

    const state = h.getState();
    expect(state.revisions.map((revision) => revision.revision)).toEqual([1, 2, 3]);
    expect(state.revisions[2]).toMatchObject({
      revision: 3,
      sourceRevisionId: state.revisions[0].id,
      document,
    });
    expect(state.audits.map((audit) => audit.action)).toEqual([
      'plugin.policy.published',
      'plugin.policy.published',
      'plugin.policy.rolled_back',
    ]);
  });
});
