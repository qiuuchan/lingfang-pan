import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, configureApiBase, type ApiError } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api structured errors', () => {
  it('preserves nested product code, status and requestId', async () => {
    configureApiBase('https://platform.example');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        message: '团队额度不足',
        code: 'insufficient_balance',
        requestId: 'req-body',
      },
    }), {
      status: 402,
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-header' },
    })));

    const error = await api('/api/relay/v1/chat/completions').catch((caught) => caught as ApiError);
    expect(error).toMatchObject({
      message: '团队额度不足',
      code: 'insufficient_balance',
      status: 402,
      requestId: 'req-body',
    });
  });

  it('sets the host-selected plugin telemetry header', async () => {
    configureApiBase('https://platform.example');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/relay/v1/images/generations', { clientSource: 'desktop-plugin-test' });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-Client': 'desktop-plugin-test' });
  });
});
