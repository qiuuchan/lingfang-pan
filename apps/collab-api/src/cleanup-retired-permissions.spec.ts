import { describe, expect, it, vi } from 'vitest';
import { cleanupRetiredPermissions } from './cleanup-retired-permissions';

describe('cleanupRetiredPermissions', () => {
  it('cleans role arrays, PermissionEntry rows, and the retired team module idempotently', async () => {
    const prisma = {
      role: {
        findMany: vi.fn(async () => [
          { id: 'custom', permissions: ['team.dashboard.view', 'team.api_key.manage'] },
          { id: 'clean', permissions: ['team.plugin.list'] },
        ]),
        update: vi.fn(async () => ({})),
      },
      permissionEntry: { deleteMany: vi.fn(async () => ({ count: 3 })) },
      permissionGroup: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    };

    await expect(cleanupRetiredPermissions(prisma as never)).resolves.toBe(1);
    expect(prisma.role.update).toHaveBeenCalledOnce();
    expect(prisma.role.update).toHaveBeenCalledWith({
      where: { id: 'custom' },
      data: { permissions: ['team.dashboard.view'] },
    });
    expect(prisma.permissionEntry.deleteMany).toHaveBeenCalledWith({
      where: {
        code: {
          in: expect.arrayContaining([
            'team.api_key.manage',
            'platform.billing.api_key.manage',
            'platform.billing.relay_docs.view',
          ]),
        },
      },
    });
    expect(prisma.permissionGroup.deleteMany).toHaveBeenCalledWith({
      where: { scope: 'TEAM', groupKey: 'team.api_key' },
    });
  });
});
