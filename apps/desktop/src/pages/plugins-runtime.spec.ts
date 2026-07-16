import { describe, expect, it, vi } from 'vitest';
import type { LoadedPlugin } from '@/lib/types';
import { handleRuntimeCall, loadPluginDocument, pluginRelayClientSource, runtimeErrorPayload, runtimeMessageFromFrame } from './plugins-runtime';

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
    expect(document).toContain("call('actions.call'");
    expect(document).not.toContain('request_idempotency_key');
    expect(document).not.toContain('LINGFANG_PLUGIN_BRIDGE_TOKEN');
    expect(document).not.toContain('Authorization');
    expect(document).not.toContain('auth_token');
  });

  it('accepts bridge calls only from the current opaque-origin frame', () => {
    const contentWindow = {} as Window;
    const frame = { contentWindow } as HTMLIFrameElement;
    const data = { __lf_call: true, id: 1, kind: 'actions.call', args: { dependency_id: 'video_generator' } };
    expect(runtimeMessageFromFrame({ origin: 'null', source: contentWindow, data } as MessageEvent, frame)).toMatchObject({ kind: 'actions.call' });
    expect(runtimeMessageFromFrame({ origin: 'https://attacker.example', source: contentWindow, data } as MessageEvent, frame)).toBeNull();
    expect(runtimeMessageFromFrame({ origin: 'null', source: {} as Window, data } as MessageEvent, frame)).toBeNull();
  });

  it('ignores spoofed principal and token fields from iframe messages', () => {
    const contentWindow = {} as Window;
    const frame = { contentWindow } as HTMLIFrameElement;
    const data = {
      __lf_call: true,
      id: 1,
      pluginId: 'spoofed-plugin',
      teamId: 'spoofed-team',
      token: 'stolen-token',
      kind: 'actions.call',
      args: { dependency_id: 'video_generator' },
    };
    const message = runtimeMessageFromFrame({ origin: 'null', source: contentWindow, data } as MessageEvent, frame);
    expect(message).toMatchObject({ kind: 'actions.call', args: { dependency_id: 'video_generator' } });
    // The host passes only the active LoadedPlugin to handleRuntimeCall; no
    // iframe-supplied principal/token field exists in the typed message shape.
    expect(message).not.toHaveProperty('token');
    expect(message).not.toHaveProperty('teamId');
    expect(message).not.toHaveProperty('pluginId');
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
