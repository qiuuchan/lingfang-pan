import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
const tauriInvokeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  api: apiMock,
  apiBase: vi.fn(() => 'https://platform.example'),
  getAuthToken: vi.fn(() => 'jwt-token'),
  tauriInvoke: tauriInvokeMock,
  tauriListen: vi.fn(),
}));

import { startInstalledPlugin } from './plugin-status';

describe('installed plugin start gate', () => {
  beforeEach(() => {
    apiMock.mockReset();
    tauriInvokeMock.mockReset();
    apiMock.mockResolvedValue(undefined);
    tauriInvokeMock.mockResolvedValue({ pid: 42, started_at: '2026-07-13T00:00:00.000Z' });
  });

  it('checks exact marketplace release access before invoking the Rust runner', async () => {
    const release = { releaseId: 'market-release', sha256: 'a'.repeat(64) };

    await startInstalledPlugin('installation-1', 'package-1', 'marketplace', release);

    expect(apiMock).toHaveBeenCalledWith('/api/plugin-packages/package-1/runtime-access', {
      method: 'POST',
      body: release,
    });
    expect(tauriInvokeMock).toHaveBeenCalledWith('start_installed_plugin', {
      installationId: 'installation-1',
      apiBase: 'https://platform.example',
      authToken: 'jwt-token',
      registryAccessGranted: true,
    });
    expect(apiMock.mock.invocationCallOrder[0]).toBeLessThan(tauriInvokeMock.mock.invocationCallOrder[0]!);
  });

  it('does not require the remote registry gate for local installations', async () => {
    await startInstalledPlugin('installation-1', 'package-1', 'local', { releaseId: '', sha256: '' });

    expect(apiMock).not.toHaveBeenCalled();
    expect(tauriInvokeMock).toHaveBeenCalledWith('start_installed_plugin', expect.objectContaining({
      registryAccessGranted: false,
    }));
  });
});
