import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginAiError, sdk } from './index';

type TestGlobal = typeof globalThis & {
  __lingfangInvoke?: (capability: string, args: unknown) => Promise<unknown>;
  process: { env: Record<string, string | undefined> };
};

const env = () => (globalThis as TestGlobal).process.env;

afterEach(() => {
  delete (globalThis as TestGlobal).__lingfangInvoke;
  delete env().LINGFANG_PLUGIN_BRIDGE_URL;
  delete env().LINGFANG_PLUGIN_BRIDGE_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('plugin AI SDK', () => {
  it('defaults chat to fast and keeps bridge credentials out of arguments', async () => {
    const bridge = vi.fn().mockResolvedValue('ok');
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    await expect(sdk.llm.chat({ messages: [{ role: 'user', content: 'hello' }] })).resolves.toBe('ok');
    expect(bridge).toHaveBeenCalledWith('llm.chat', {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'fast',
    });
  });

  it('rejects upstream model names before invoking the host', async () => {
    const bridge = vi.fn();
    (globalThis as TestGlobal).__lingfangInvoke = bridge;

    await expect(sdk.llm.chat({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'gpt-4o' as 'fast',
    })).rejects.toMatchObject({ name: 'PluginAiError', code: 'unsupported_model', status: 400 });
    expect(bridge).not.toHaveBeenCalled();
  });

  it('preserves structured host errors', async () => {
    (globalThis as TestGlobal).__lingfangInvoke = vi.fn().mockRejectedValue({
      message: '团队额度不足',
      code: 'insufficient_balance',
      status: 402,
      requestId: 'req-1',
    });

    const error = await sdk.image.generate({ prompt: 'demo' }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PluginAiError);
    expect(error).toMatchObject({
      message: '团队额度不足',
      code: 'insufficient_balance',
      status: 402,
      requestId: 'req-1',
    });
  });

  it('preserves nested OpenAI-compatible errors from the localhost fallback', async () => {
    env().LINGFANG_PLUGIN_BRIDGE_URL = 'http://127.0.0.1:12345';
    env().LINGFANG_PLUGIN_BRIDGE_TOKEN = 'session-token';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        message: '当前团队没有可用渠道',
        code: 'no_channel_available',
        requestId: 'req-local',
      },
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await sdk.llm.chat({ messages: [{ role: 'user', content: 'hello' }] }).catch((caught) => caught);

    expect(error).toMatchObject({
      name: 'PluginAiError',
      message: '当前团队没有可用渠道',
      code: 'no_channel_available',
      status: 503,
      requestId: 'req-local',
    });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:12345/llm/chat', expect.objectContaining({
      headers: expect.objectContaining({ 'X-LingFang-Plugin-Token': 'session-token' }),
    }));
  });

  it('uses a structured error when no host bridge is available', async () => {
    await expect(sdk.image.generate({ prompt: 'demo' })).rejects.toMatchObject({
      name: 'PluginAiError',
      code: 'bridge_unavailable',
      status: 503,
    });
  });

  it('rejects a non-local bridge URL from the environment', async () => {
    env().LINGFANG_PLUGIN_BRIDGE_URL = 'https://provider.example/v1';
    env().LINGFANG_PLUGIN_BRIDGE_TOKEN = 'session-token';

    await expect(sdk.llm.chat({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toMatchObject({
      name: 'PluginAiError',
      code: 'bridge_invalid',
      status: 503,
    });
  });
});
