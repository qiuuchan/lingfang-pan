import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PluginSharedStateService,
  type SharedInvocationPrincipal,
} from './plugin-shared-state.service';

const principal: SharedInvocationPrincipal = {
  invocationId: 'inv-1',
  userId: 'user-1',
  teamId: 'team-1',
  packageId: 'pkg-1',
  releaseId: 'rel-1',
  releaseSha256: 'a'.repeat(64),
  actionId: 'shared.run',
  actionContractVersion: '1.0.0',
  actionSurfaceSha256: 'b'.repeat(64),
  workflowReleaseId: null,
};
const locator = { ownerKind: 'PACKAGE' as const, ownerId: 'pkg-1', name: 'project.assets' };
const namespace = {
  id: 'ns-1',
  teamId: 'team-1',
  ownerKind: 'PACKAGE',
  ownerId: 'pkg-1',
  name: 'project.assets',
  generation: 2,
  deletedAt: null,
  activeSchemaVersion: 1,
  nextValueRevision: 7n,
  nextChangeCursor: 9n,
  usedBytes: 0,
  quotaBytes: 10_485_760,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('PluginSharedStateService relist and changes', () => {
  beforeEach(() => {
    process.env.SHARED_RELIST_TOKEN_SECRET = 'test-shared-relist-secret-value';
  });
  afterEach(() => {
    delete process.env.SHARED_RELIST_TOKEN_SECRET;
  });

  it('captures snapshot before listing and preserves it through a signed relist token', async () => {
    const findMany = vi.fn(async () => [
      {
        id: 'v1',
        namespaceId: 'ns-1',
        namespaceGeneration: 2,
        key: 'a',
        valueJson: { ok: true },
        schemaVersion: 1,
        valueBytes: 11,
        revision: 7n,
        createdByUserId: 'user-1',
        createdByPackageId: 'pkg-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const prisma = {
      pluginSharedNamespace: { findUnique: vi.fn(async () => namespace) },
      pluginSharedValue: { findMany },
    };
    const governance = { authorizeRelease: vi.fn(async () => ({ decision: { allowed: true } })) };
    const service = new PluginSharedStateService(prisma as never, governance as never);
    const first = await service.list(principal, locator, { limit: '1' });
    expect(governance.authorizeRelease).toHaveBeenCalledWith(
      'user-1',
      { releaseId: 'rel-1', packageId: 'pkg-1', sha256: 'a'.repeat(64) },
      ['shared_data_read'],
      expect.objectContaining({ action: expect.objectContaining({ action_id: 'shared.run' }) })
    );
    expect(first.snapshot_cursor).toBe('7');
    expect(first.relist_token).toContain('.');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ revision: { lte: 7n } }) })
    );
    await service.list(principal, locator, { limit: '1', relistToken: first.relist_token });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ revision: { lte: 7n } }) })
    );
  });

  it('rejects a tampered or generation-stale relist token', async () => {
    const prisma = {
      pluginSharedNamespace: { findUnique: vi.fn(async () => namespace) },
      pluginSharedValue: { findMany: vi.fn(async () => []) },
    };
    const governance = { authorizeRelease: vi.fn(async () => ({ decision: { allowed: true } })) };
    const service = new PluginSharedStateService(prisma as never, governance as never);
    const first = await service.list(principal, locator, {});
    await expect(
      service.list(principal, locator, { relistToken: `${first.relist_token}x` })
    ).rejects.toMatchObject({ code: 'shared_namespace_generation_stale' });
  });

  it('returns 410 when the requested change cursor predates retained history', async () => {
    const prisma = {
      pluginSharedNamespace: { findUnique: vi.fn(async () => namespace) },
      sharedStateOutbox: { findFirst: vi.fn(async () => ({ cursor: 5n })), findMany: vi.fn() },
    };
    const governance = { authorizeRelease: vi.fn(async () => ({ decision: { allowed: true } })) };
    const service = new PluginSharedStateService(prisma as never, governance as never);
    await expect(service.changes(principal, locator, '1', '100')).rejects.toMatchObject({
      status: 410,
      code: 'shared_change_cursor_expired',
      details: { latest_cursor: '9' },
    });
    expect(prisma.sharedStateOutbox.findMany).not.toHaveBeenCalled();
  });

  it('routes shared value reads through the governance high-risk operation', async () => {
    const findUniqueValue = vi.fn(async () => ({
      namespaceId: 'ns-1',
      namespaceGeneration: 2,
      key: 'asset',
      valueJson: { ok: true },
      schemaVersion: 1,
      revision: 7n,
      valueBytes: 11,
      artifacts: [],
      createdByUserId: 'user-1',
      createdByPackageId: 'pkg-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const tx = {
      pluginSharedNamespace: { findUnique: vi.fn(async () => namespace) },
      pluginSharedValue: { findUnique: findUniqueValue },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx)
      ),
    };
    const governance = { authorizeRelease: vi.fn(async () => ({ decision: { allowed: true } })) };
    const service = new PluginSharedStateService(prisma as never, governance as never);
    await service.get(principal, locator, 'asset');
    expect(governance.authorizeRelease).toHaveBeenCalledWith(
      'user-1',
      { releaseId: 'rel-1', packageId: 'pkg-1', sha256: 'a'.repeat(64) },
      ['shared_data_read'],
      expect.objectContaining({ action: expect.objectContaining({ action_id: 'shared.run' }) })
    );
    expect(findUniqueValue).toHaveBeenCalledOnce();
  });

  it('deletes a namespace without resetting allocators and releases every old generation artifact scope', async () => {
    const updated = {
      ...namespace,
      generation: 3,
      deletedAt: new Date('2026-07-16T00:00:00Z'),
      nextValueRevision: 9n,
      nextChangeCursor: 11n,
    };
    const tx = {
      pluginSharedNamespace: {
        findUnique: vi.fn(async () => namespace),
        update: vi.fn(async () => updated),
      },
      pluginSharedValue: {
        findMany: vi.fn(async () => [
          { id: 'v1', key: 'a', revision: 6n, schemaVersion: 1 },
          { id: 'v2', key: 'b', revision: 7n, schemaVersion: 1 },
        ]),
        deleteMany: vi.fn(async () => ({ count: 2 })),
      },
      sharedStateOutbox: { create: vi.fn(async ({ data }) => data) },
    };
    const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) };
    const governance = { authorizeRelease: vi.fn(async () => ({ decision: { allowed: true } })) };
    const artifacts = { releaseSharedValueTx: vi.fn(async () => undefined) };
    const service = new PluginSharedStateService(
      prisma as never,
      governance as never,
      artifacts as never
    );
    await expect(service.deleteNamespace(principal, locator)).resolves.toMatchObject({
      namespace_generation: 3,
      next_value_revision: '9',
      next_change_cursor: '11',
      used_bytes: 0,
    });
    expect(artifacts.releaseSharedValueTx).toHaveBeenCalledTimes(2);
    expect(tx.pluginSharedNamespace.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          generation: 3,
          nextValueRevision: 9n,
          nextChangeCursor: 11n,
          usedBytes: 0,
        }),
      })
    );
  });

  it('reactivates the preserved namespace identity with a fresh generation and unchanged allocators', async () => {
    const deleted = {
      ...namespace,
      generation: 3,
      deletedAt: new Date(),
      nextValueRevision: 20n,
      nextChangeCursor: 22n,
    };
    const reactivated = { ...deleted, generation: 4, deletedAt: null, activeSchemaVersion: 2 };
    const tx = {
      pluginSharedNamespace: {
        findUnique: vi.fn(async () => deleted),
        update: vi.fn(async () => reactivated),
      },
    };
    const prisma = {
      pluginRelease: {
        findFirst: vi.fn(async () => ({
          manifest: {
            shared_namespaces: [
              {
                name: locator.name,
                active_schema_version: 2,
                read_purpose: 'read',
                write_purpose: 'write',
                schemas: [
                  {
                    schema_version: 2,
                    schema: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {},
                      required: [],
                    },
                  },
                ],
              },
            ],
          },
        })),
      },
      $transaction: vi.fn(async (fn) => fn(tx)),
    };
    const governance = { authorizeRelease: vi.fn(async () => ({ decision: { allowed: true } })) };
    const service = new PluginSharedStateService(prisma as never, governance as never, {} as never);
    await expect(
      service.reactivateNamespace(principal, locator, { active_schema_version: 2 })
    ).resolves.toMatchObject({
      namespace_generation: 4,
      next_value_revision: '20',
      next_change_cursor: '22',
      active_schema_version: 2,
    });
    expect(tx.pluginSharedNamespace.update).toHaveBeenCalledWith({
      where: { id: namespace.id },
      data: { generation: { increment: 1 }, deletedAt: null, activeSchemaVersion: 2, usedBytes: 0 },
    });
  });

  it('streams JSONL export pages and strips ArtifactRef handles', async () => {
    const findMany = vi.fn().mockResolvedValueOnce([
      {
        id: 'v1',
        namespaceId: namespace.id,
        namespaceGeneration: namespace.generation,
        key: 'asset',
        valueJson: {
          ref: {
            type: 'artifact_ref',
            artifact_id: 'a1',
            authorization: { scope: 'TEAM', team_id: 'team-1', handle: 'secret-handle' },
          },
        },
        schemaVersion: 1,
        valueBytes: 1,
        revision: 7n,
        createdByUserId: 'u1',
        createdByPackageId: 'pkg-1',
        createdAt: new Date(),
        updatedAt: new Date('2026-07-16T00:00:00Z'),
      },
    ]);
    const prisma = {
      pluginSharedNamespace: { findUnique: vi.fn(async () => namespace) },
      pluginSharedValue: { findMany },
    };
    const governance = { authorizeRelease: vi.fn(async () => ({ decision: { allowed: true } })) };
    const service = new PluginSharedStateService(prisma as never, governance as never, {} as never);
    const exported = await service.exportNamespace(principal, locator);
    let jsonl = '';
    for await (const line of exported.lines) jsonl += line;
    expect(jsonl).toContain('"artifact_id":"a1"');
    expect(jsonl).not.toContain('secret-handle');
  });

  it('rejects a stale migration source schema before changing the active schema', async () => {
    const tx = {
      pluginSharedNamespace: { findUnique: vi.fn(async () => namespace), update: vi.fn() },
      pluginSharedValue: {
        findUnique: vi.fn(async () => ({ revision: 7n, schemaVersion: 1, valueJson: {} })),
      },
    };
    const declaration = {
      name: locator.name,
      active_schema_version: 2,
      read_purpose: 'read',
      write_purpose: 'write',
      schemas: [
        {
          schema_version: 1,
          schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
        },
        {
          schema_version: 2,
          schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
        },
      ],
    };
    const prisma = {
      pluginRelease: {
        findFirst: vi.fn(async () => ({ manifest: { shared_namespaces: [declaration] } })),
      },
      $transaction: vi.fn(async (fn) => fn(tx)),
    };
    const governance = { authorizeRelease: vi.fn(async () => ({ decision: { allowed: true } })) };
    const service = new PluginSharedStateService(prisma as never, governance as never, {} as never);
    await expect(
      service.migrate(principal, locator, 'asset', {
        value: {},
        source_schema_version: 2,
        target_schema_version: 1,
        expected_revision: '7',
      })
    ).rejects.toMatchObject({ code: 'shared_schema_migration_source_changed' });
    expect(tx.pluginSharedNamespace.update).not.toHaveBeenCalled();
  });

  it('repairs live artifact scopes and releases orphan canonical grants', async () => {
    const edge = {
      id: 'edge-1',
      namespaceId: namespace.id,
      namespaceGeneration: namespace.generation,
      key: 'asset',
      valueRevision: 7n,
      artifactId: 'artifact-1',
      jsonPointer: '/image',
      executionKind: 'STANDARD',
      namespace,
      value: { namespaceGeneration: namespace.generation, revision: 7n },
      artifact: { status: 'ACTIVE', createdAt: new Date() },
    };
    const tx = {};
    const prisma = {
      pluginSharedValueArtifact: {
        findMany: vi.fn().mockResolvedValueOnce([edge]).mockResolvedValueOnce([]),
      },
      runtimeArtifactGrant: {
        findMany: vi.fn(async () => [{ artifactId: 'orphan-artifact', targetId: 'orphan-target' }]),
      },
      runtimeArtifactHold: {
        findMany: vi.fn(async () => [{ artifactId: 'orphan-artifact', holderId: 'orphan-target' }]),
      },
      $transaction: vi.fn(async (fn) => fn(tx)),
    };
    const artifacts = {
      reconcileSharedValueTx: vi.fn(async () => ({})),
      releaseSharedValueTx: vi.fn(async () => undefined),
    };
    const service = new PluginSharedStateService(prisma as never, {} as never, artifacts as never);
    await expect(service.reconcileArtifactRetention(100)).resolves.toEqual({
      scanned: 1,
      repaired: 1,
      expired: 0,
      released: 1,
    });
    expect(artifacts.reconcileSharedValueTx).toHaveBeenCalledWith(
      tx,
      'artifact-1',
      `${namespace.id}:${namespace.generation}:asset:7`,
      expect.objectContaining({ json_pointer: '/image' }),
      expect.any(Date)
    );
    expect(artifacts.releaseSharedValueTx).toHaveBeenCalledWith(tx, 'orphan-target');
  });
});
