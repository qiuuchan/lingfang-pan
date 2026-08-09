import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, configureApiBase, getAuthToken, setAuthToken, type ApiError } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api structured errors', () => {
  it('preserves nested product code, status and requestId', async () => {
    configureApiBase('https://platform.example');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: '团队额度不足',
              code: 'insufficient_balance',
              requestId: 'req-body',
            },
          }),
          {
            status: 402,
            headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-header' },
          }
        )
      )
    );

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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/relay/v1/images/generations', { clientSource: 'desktop-plugin-test' });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Client': 'desktop-plugin-test',
    });
  });

  it('forwards host-owned idempotency headers without losing standard headers', async () => {
    configureApiBase('https://platform.example');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
    vi.stubGlobal('fetch', fetchMock);
    await api('/api/plugin-packages/package-1/purchase', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'purchase-1' },
      body: { expectedPriceVersion: 'pv1.token' },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Idempotency-Key': 'purchase-1',
      'X-Client': 'desktop',
    });
  });
});

describe('P1-1 (M-1 完整版): auth token 不出 localStorage', () => {
  beforeEach(() => {
    // node 环境无 localStorage，桩一个最小实现用于断言「未写入」。
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    });
  });

  it('setAuthToken 不把 JWT 写入 localStorage（唯一持久副本在 Rust session.json）', () => {
    setAuthToken('header.payload.signature');
    expect(localStorage.getItem('lf:authToken')).toBeNull();
    // 内存态仍可用，api() 据此注入 Authorization。
    expect(getAuthToken()).toBe('header.payload.signature');
  });

  it('setAuthToken(null) 同样不写 localStorage', () => {
    setAuthToken('tok');
    setAuthToken(null);
    // 全程不落 localStorage：登出后也无残留可读。
    expect(localStorage.getItem('lf:authToken')).toBeNull();
    expect(getAuthToken()).toBeNull();
  });
});
