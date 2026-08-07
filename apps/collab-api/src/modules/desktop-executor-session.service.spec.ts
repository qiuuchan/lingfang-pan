import { describe, expect, it, vi } from 'vitest';
import { DesktopExecutorSessionService } from './desktop-executor-session.service';

const item = {
  installation_id: 'install-1',
  package_id: 'package-1',
  release_id: 'release-1',
  sha256: 'a'.repeat(64),
  dependency_status: 'ready' as const,
};
const release = {
  id: item.release_id,
  packageId: item.package_id,
  sha256: item.sha256,
  status: 'PUBLISHED',
  package: { id: item.package_id, ownerTeamId: 'team-1', governanceStatus: 'ACTIVE' },
};
const session = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1',
  teamId: 'team-1',
  userId: 'user-1',
  deviceId: 'device-1',
  inventorySchemaVersion: '1',
  inventorySha256: '',
  inventory: [item],
  tokenSha256: '',
  status: 'ACTIVE',
  expiresAt: new Date(Date.now() + 60_000),
  lastHeartbeatAt: new Date(),
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

function service(prisma: Record<string, unknown>) {
  return new DesktopExecutorSessionService(
    prisma as never,
    { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 'team-1' }) } as never
  );
}

describe('DesktopExecutorSessionService', () => {
  it('rejects duplicate installation and package identities', async () => {
    const subject = service({});
    await expect(
      subject.create('user-1', 'device-1', [item, { ...item, installation_id: 'install-2' }])
    ).rejects.toMatchObject({ code: 'workflow_installation_mismatch' });
  });

  it('validates exact ready releases before creating and stores only a token digest', async () => {
    const create = vi.fn(({ data }) => ({ ...session(), ...data }));
    const subject = service({
      pluginRelease: { findMany: vi.fn().mockResolvedValue([release]) },
      desktopExecutorSession: { create },
    });
    const result = await subject.create('user-1', 'device-1', [item]);
    expect(result.token).toHaveLength(43);
    expect(create.mock.calls[0][0].data.tokenSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(create.mock.calls[0][0].data).not.toHaveProperty('token');
  });

  it('revokes a session immediately when heartbeat inventory changes', async () => {
    const token = 'x'.repeat(32);
    const crypto = await import('node:crypto');
    const row = session({
      tokenSha256: crypto.createHash('sha256').update(token).digest('hex'),
      inventorySha256: 'b'.repeat(64),
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const subject = service({
      pluginRelease: { findMany: vi.fn().mockResolvedValue([release]) },
      desktopExecutorSession: { findFirst: vi.fn().mockResolvedValue(row), updateMany },
    });
    await expect(subject.heartbeat('user-1', row.id, token, [item])).rejects.toMatchObject({
      code: 'workflow_inventory_changed',
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVOKED' }) })
    );
  });

  it('expires a stale heartbeat instead of accepting the session', async () => {
    const token = 'y'.repeat(32);
    const crypto = await import('node:crypto');
    const row = session({
      tokenSha256: crypto.createHash('sha256').update(token).digest('hex'),
      lastHeartbeatAt: new Date(Date.now() - 60_000),
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const subject = service({
      desktopExecutorSession: { findFirst: vi.fn().mockResolvedValue(row), updateMany },
    });
    await expect(subject.validate('user-1', row.id, token)).rejects.toMatchObject({
      code: 'workflow_executor_session_invalid',
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPIRED' } })
    );
  });
});
