// relay-provider.spec.ts —— 验证 withRetryFetch 的连接级重试语义。
//
// 关键不变式（特性3a：网络不好时的瞬断重试）：
//  1. fetch 抛 TypeError（连接失败）→ 指数退避重试，成功后返回响应。
//  2. 拿到 HTTP 响应（含 5xx）→ 不重试，直接返回（流式 body 已开始，重试会破坏 SSE）。
//  3. AbortError（用户/超时取消）→ 立即抛出，不重试。
//  4. 重试次数用尽仍连接失败 → 抛最后一次错误。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetryFetch } from './relay-provider';

describe('withRetryFetch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('连接级 TypeError → 指数退避重试，成功后返回响应', async () => {
    const ok = new Response('hi', { status: 200 });
    const fetchMock = vi.fn();
    // 第 3 次（重试 2 次后）成功。
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok);
    vi.stubGlobal('fetch', fetchMock);
    const retryFetch = withRetryFetch();

    // 预挂处理链：advanceTimers 会触发 setTimeout 回调里的 resolve/reject，
    // 必须在推进时间前就 await 整个 promise，否则 unhandled rejection。
    const result = await (async () => {
      const p = retryFetch('https://relay/v1/chat');
      // 预挂 catch 防止 unhandled rejection（最终会成功 resolve）。
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1000);
      return p;
    })();
    expect(result).toBe(ok);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('拿到 HTTP 5xx 响应 → 不重试，直接返回（流式不重放）', async () => {
    const serverErr = new Response('boom', { status: 503 });
    const fetchMock = vi.fn(async () => serverErr);
    vi.stubGlobal('fetch', fetchMock);
    const retryFetch = withRetryFetch();

    const res = await retryFetch('https://relay/v1/chat');
    expect(res).toBe(serverErr);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AbortError（取消）→ 立即抛出，不重试', async () => {
    const fetchMock = vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); });
    vi.stubGlobal('fetch', fetchMock);
    const retryFetch = withRetryFetch();

    await expect(retryFetch('https://relay/v1/chat')).rejects.toThrow('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('非 TypeError 的其它错误 → 直接抛出，不重试', async () => {
    const fetchMock = vi.fn(async () => { throw new SyntaxError('bad json'); });
    vi.stubGlobal('fetch', fetchMock);
    const retryFetch = withRetryFetch();

    await expect(retryFetch('https://relay/v1/chat')).rejects.toThrow('bad json');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('重试次数用尽仍连接失败 → 抛最后一次 TypeError', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); });
    vi.stubGlobal('fetch', fetchMock);
    const retryFetch = withRetryFetch();

    // 预挂 catch 防止 unhandled rejection；最终断言 reject。
    const result = await (async () => {
      const p = retryFetch('https://relay/v1/chat');
      // 先挂一个 noop catch 占位，避免推进时间时 reject 飞出无人接住。
      const handled = p.then(
        () => { throw new Error('应 reject 却 resolve'); },
        (e: unknown) => e,
      );
      // CONNECT_RETRY=3，共 4 次尝试（1 首次 + 3 重试），退避 500/1000/2000。
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      return handled;
    })();
    expect(result).toBeInstanceOf(TypeError);
    expect((result as Error).message).toBe('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
