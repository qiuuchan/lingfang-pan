import { describe, expect, it, vi } from 'vitest';
import type { LoadedPlugin } from '@/lib/types';
import { handleRuntimeCall, loadPluginDocument, pluginRelayClientSource, runtimeErrorPayload } from './plugins-runtime';

function plugin(overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    id: 'plugin-1',
    name: 'Plugin',
    version: '1.0.0',
    entry: 'ui/index.html',
    source: 'published',
    capabilities: [{ kind: 'llm.chat' }],
    files: [{ path: 'ui/index.html', content: '<main>demo</main>' }],
    ...overrides,
  };
}

describe('plugin iframe AI runtime', () => {
  it('injects the AI timeout and structured error fields into the iframe shim', async () => {
    const document = await loadPluginDocument(plugin());
    expect(document).toContain('180000');
    expect(document).toContain('error.requestId = detail.requestId');
  });

  it('rejects unknown upstream model names before relay and preserves the code', async () => {
    const postMessage = vi.fn();
    const frame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;

    await handleRuntimeCall(plugin(), frame, {
      __lf_call: true,
      id: 1,
      kind: 'llm.chat',
      args: { messages: [{ role: 'user', content: 'hello' }], model: 'gpt-4o' },
    });

    expect(postMessage).toHaveBeenCalledWith({
      __lf_reply: true,
      id: 1,
      error: expect.objectContaining({
        message: '仅支持平台模型档位 fast 或 premium',
        code: 'unsupported_model',
        status: 400,
      }),
    }, '*');
  });

  it('maps stable product error metadata without reducing it to a string', () => {
    expect(runtimeErrorPayload({
      name: 'PluginAiError',
      message: '团队额度不足',
      code: 'insufficient_balance',
      status: 402,
      requestId: 'req-1',
    })).toEqual({
      name: 'PluginAiError',
      message: '团队额度不足',
      code: 'insufficient_balance',
      status: 402,
      requestId: 'req-1',
    });
  });

  it('marks draft calls as plugin tests without changing runtime calls', () => {
    expect(pluginRelayClientSource(plugin({ draft: true }))).toBe('desktop-plugin-test');
    expect(pluginRelayClientSource(plugin({ draft: false }))).toBe('desktop-plugin');
  });
});
