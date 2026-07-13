import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertInstalledPluginAiPolicy, assertPluginAiPolicy, checkPluginAiPolicy, policyManifest } from './plugin-ai-policy';

const apiMock = vi.hoisted(() => vi.fn());
const tauriInvokeMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: apiMock, tauriInvoke: tauriInvokeMock }));

beforeEach(() => {
  apiMock.mockReset();
  tauriInvokeMock.mockReset();
});

describe('plugin AI policy preflight', () => {
  it('sends the authoritative manifest and marks binary placeholders', async () => {
    apiMock.mockResolvedValue({
      policyVersion: 1,
      ok: true,
      diagnostics: [],
      requiredCapabilities: ['llm.chat'],
      truncated: false,
    });
    const files = [
      { path: 'manifest.json', content: JSON.stringify({ id: 'demo', capabilities: [{ kind: 'llm.chat' }] }) },
      { path: 'main.py', content: 'print("ok")' },
      { path: 'icon.png', content: '[binary file, 128 bytes]' },
    ];
    const manifest = policyManifest(files);

    await checkPluginAiPolicy(manifest, files);

    expect(apiMock).toHaveBeenCalledWith('/api/plugins/policy/check', expect.objectContaining({
      method: 'POST',
      body: {
        manifest,
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'icon.png', content: '', binary: true }),
        ]),
      },
    }));
  });

  it('fails closed with the stable policy code', async () => {
    apiMock.mockResolvedValue({
      policyVersion: 1,
      ok: false,
      diagnostics: [{ code: 'ai.endpoint.third_party', path: 'main.py', line: 2, message: '不得直连第三方模型端点' }],
      requiredCapabilities: [],
      truncated: false,
    });

    const error = await assertPluginAiPolicy(
      { id: 'blocked-demo' },
      [{ path: 'main.py', content: 'blocked' }],
    ).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'plugin_ai_policy_failed' });
    expect(error.message).toContain('main.py:2');
  });

  it('reads the complete pending installed source before checking policy', async () => {
    const manifest = { id: 'installed-demo', capabilities: [{ kind: 'llm.chat' }] };
    const files = [
      { path: 'manifest.json', content: JSON.stringify(manifest), binary: false },
      { path: 'package.json', content: '{"dependencies":{"openai":"^6"}}', binary: false },
      { path: 'index.js', content: 'demo', binary: false },
    ];
    tauriInvokeMock.mockResolvedValue({ manifest, files });
    apiMock.mockResolvedValue({
      policyVersion: 1,
      ok: true,
      diagnostics: [],
      requiredCapabilities: ['llm.chat'],
      truncated: false,
    });

    await assertInstalledPluginAiPolicy('installation-1', true);

    expect(tauriInvokeMock).toHaveBeenCalledWith('read_installed_plugin_policy_source', {
      installationId: 'installation-1',
      pending: true,
    });
    expect(apiMock).toHaveBeenCalledWith('/api/plugins/policy/check', expect.objectContaining({
      body: {
        manifest,
        files: expect.arrayContaining(files),
      },
    }));
  });
});
