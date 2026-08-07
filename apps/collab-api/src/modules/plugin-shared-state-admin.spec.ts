import { describe, expect, it, vi } from 'vitest';
import { PluginSharedStateService } from './plugin-shared-state.service';

const namespace = {
  id: 'ns-1',
  teamId: 'team-1',
  ownerKind: 'PACKAGE' as const,
  ownerId: 'pkg-1',
  name: 'project.assets',
  generation: 2,
  deletedAt: null,
  activeSchemaVersion: 1,
  nextValueRevision: 7n,
  nextChangeCursor: 9n,
  usedBytes: 128,
  quotaBytes: 10_485_760,
  createdAt: new Date('2026-07-16T00:00:00Z'),
  updatedAt: new Date('2026-07-16T00:01:00Z'),
};

function service(
  prisma: Record<string, unknown>,
  auth = { ensureTeamAdmin: vi.fn(async () => ({ teamId: 'team-1' })) }
) {
  return new PluginSharedStateService(
    prisma as never,
    { authorizeRelease: vi.fn() } as never,
    { releaseSharedValueTx: vi.fn() } as never,
    auth as never
  );
}

describe('PluginSharedStateService team-admin operations', () => {
  it('returns metadata only and scopes the list to the authenticated team', async () => {
    const findMany = vi.fn(async () => [namespace]);
    const result = await service({ pluginSharedNamespace: { findMany } }).adminListNamespaces(
      'admin-1'
    );
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId: 'team-1' } }));
    expect(result.namespaces).toEqual([
      expect.objectContaining({
        namespace_id: 'ns-1',
        generation: 2,
        active_schema_version: 1,
        used_bytes: 128,
        next_value_revision: '7',
        next_change_cursor: '9',
        deleted_at: null,
      }),
    ]);
    expect(result.namespaces[0]).not.toHaveProperty('value');
  });

  it('does not create an invocation principal or accept a runtime token for admin export', async () => {
    const findUnique = vi.fn(async () => namespace);
    const findMany = vi.fn(async () => []);
    const exported = await service({
      pluginSharedNamespace: { findFirst: findUnique },
      pluginSharedValue: { findMany },
    }).adminExportNamespace('admin-1', 'ns-1');
    for await (const _line of exported.lines) {
      /* consume stream */
    }
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ns-1', teamId: 'team-1', deletedAt: null } })
    );
    expect(findMany).toHaveBeenCalled();
    expect(exported).not.toHaveProperty('token');
  });

  it('requires a team admin before metadata access', async () => {
    const auth = {
      ensureTeamAdmin: vi.fn(async () => {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      }),
    };
    await expect(
      service({ pluginSharedNamespace: { findMany: vi.fn() } }, auth).adminListNamespaces(
        'member-1'
      )
    ).rejects.toMatchObject({ status: 403 });
  });
});
