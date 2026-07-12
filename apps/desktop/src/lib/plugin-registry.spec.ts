import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauriInvokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
}));

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  apiBase: vi.fn(() => 'http://test.local'),
  getAuthToken: vi.fn(() => 'token'),
  tauriInvoke: tauriInvokeMock,
}));

import {
  activatePendingClientPlugin,
  discardPendingPluginUpdate,
  previewPendingInstalledPlugin,
  requiresRunnerActivation,
} from './plugin-registry';

const installation = {
  installationId: '11111111-1111-4111-8111-111111111111',
  packageId: '22222222-2222-4222-8222-222222222222',
  origin: 'team' as const,
  protected: false,
  activeRelease: {
    releaseId: 'active',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    path: '/installed/active',
    dependencyStatus: 'ready' as const,
  },
  pendingRelease: {
    releaseId: 'pending',
    version: '2.0.0',
    sha256: 'b'.repeat(64),
    path: '/installed/pending',
    dependencyStatus: 'pending' as const,
  },
  previousRelease: null,
  dataPath: '/installed/data',
  installedAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
};

describe('pending installation bridge', () => {
  beforeEach(() => {
    tauriInvokeMock.mockReset();
    vi.stubGlobal('CustomEvent', class {
      constructor(public type: string) {}
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('client 和 cloud 都必须等 Runner 成功边界后激活 pending', () => {
    expect(requiresRunnerActivation('client')).toBe(true);
    expect(requiresRunnerActivation('cloud')).toBe(true);
    expect(requiresRunnerActivation('nodejs')).toBe(false);
    expect(requiresRunnerActivation('python')).toBe(false);
  });

  it('预览 pending payload 时使用待激活版本并保留 installationId', async () => {
    tauriInvokeMock.mockResolvedValueOnce({
      installation,
      manifest: {
        id: 'team.demo',
        name: 'Pending Demo',
        version: '2.0.0',
        runtime_type: 'client',
        entry: 'ui/index.html',
      },
      entryContent: '<main>pending</main>',
    });

    const plugin = await previewPendingInstalledPlugin(installation.installationId);

    expect(tauriInvokeMock).toHaveBeenCalledWith('preview_pending_installed_plugin', {
      installationId: installation.installationId,
    });
    expect(plugin).toMatchObject({
      id: installation.installationId,
      installationId: installation.installationId,
      packageId: installation.packageId,
      version: '2.0.0',
      pendingActivation: { releaseId: 'pending' },
    });
    expect(plugin.files).toContainEqual({ path: 'ui/index.html', content: '<main>pending</main>' });
  });

  it('激活和丢弃命令都会通知本机安装列表刷新', async () => {
    tauriInvokeMock.mockResolvedValue(installation);

    await activatePendingClientPlugin(installation.installationId);
    await discardPendingPluginUpdate(installation.installationId, 'iframe failed');

    expect(tauriInvokeMock).toHaveBeenNthCalledWith(1, 'activate_pending_client_plugin', {
      installationId: installation.installationId,
    });
    expect(tauriInvokeMock).toHaveBeenNthCalledWith(2, 'discard_pending_plugin_update', {
      installationId: installation.installationId,
      reason: 'iframe failed',
    });
    expect(window.dispatchEvent).toHaveBeenCalledTimes(2);
  });
});
