import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRuntimeAccess, requiresRegistryRuntimeAccess } from './plugin-runtime-access';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: apiMock }));

beforeEach(() => apiMock.mockReset());

describe('installed plugin runtime access', () => {
  it('requires the online registry gate for team and marketplace installations', () => {
    expect(requiresRegistryRuntimeAccess('team')).toBe(true);
    expect(requiresRegistryRuntimeAccess('marketplace')).toBe(true);
    expect(requiresRegistryRuntimeAccess('builtin')).toBe(false);
    expect(requiresRegistryRuntimeAccess('local')).toBe(false);
  });

  it('binds access to the exact selected release and artifact digest', async () => {
    apiMock.mockResolvedValue(undefined);

    await checkRuntimeAccess('package-1', { releaseId: 'release-2', sha256: 'b'.repeat(64) });

    expect(apiMock).toHaveBeenCalledWith('/api/plugin-packages/package-1/runtime-access', {
      method: 'POST',
      body: { releaseId: 'release-2', sha256: 'b'.repeat(64) },
    });
  });
});
