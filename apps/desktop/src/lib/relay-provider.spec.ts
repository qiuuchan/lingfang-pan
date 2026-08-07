// relay-provider.spec.ts —— 验证 withRetryFetch 的连接级重试语义 + relay 错误格式翻译。
//
// 关键不变式（特性3a：网络不好时的瞬断重试）：
//  1. fetch 抛 TypeError（连接失败）→ 指数退避重试，成功后返回响应。
//  2. 拿到 HTTP 响应（含 5xx）→ 不重试，直接返回（流式 body 已开始，重试会破坏 SSE）。
//     非 2xx 响应的 body 会被翻译成 OpenAI 兼容格式（见 rewriteRelayErrorBody 测试组）。
//  3. AbortError（用户/超时取消）→ 立即抛出，不重试。
//  4. 重试次数用尽仍连接失败 → 抛最后一次错误。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetryFetch, rewriteRelayErrorBody, readRelayErrorDetail } from './relay-provider';

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

  it('拿到 HTTP 5xx 响应 → 不重试；body 被翻译成 OpenAI 兼容格式（流式不重放）', async () => {
    // relay 错误体：{code, message}（非 SSE）。withRetryFetch 应把它改写成 {error:{message}}。
    const serverErr = new Response(
      JSON.stringify({ code: 'upstream_llm_error', message: '上游模型调用失败' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
    const fetchMock = vi.fn(async () => serverErr);
    vi.stubGlobal('fetch', fetchMock);
    const retryFetch = withRetryFetch();

    const res = await retryFetch('https://relay/v1/chat');
    // 不重试（流式 body 不重放）。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 状态码保留。
    expect(res.status).toBe(503);
    // body 被翻译成 OpenAI 兼容格式 {error:{message}}，供 @ai-sdk/openai 解析。
    const body = await res.json();
    expect(body).toMatchObject({
      error: { message: '上游模型调用失败', type: 'upstream_llm_error' },
    });
  });

  it('AbortError（取消）→ 立即抛出，不重试', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);
    const retryFetch = withRetryFetch();

    await expect(retryFetch('https://relay/v1/chat')).rejects.toThrow('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('非 TypeError 的其它错误 → 直接抛出，不重试', async () => {
    const fetchMock = vi.fn(async () => {
      throw new SyntaxError('bad json');
    });
    vi.stubGlobal('fetch', fetchMock);
    const retryFetch = withRetryFetch();

    await expect(retryFetch('https://relay/v1/chat')).rejects.toThrow('bad json');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('重试次数用尽仍连接失败 → 抛最后一次 TypeError', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const retryFetch = withRetryFetch();

    // 预挂 catch 防止 unhandled rejection；最终断言 reject。
    const result = await (async () => {
      const p = retryFetch('https://relay/v1/chat');
      // 先挂一个 noop catch 占位，避免推进时间时 reject 飞出无人接住。
      const handled = p.then(
        () => {
          throw new Error('应 reject 却 resolve');
        },
        (e: unknown) => e
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

// rewriteRelayErrorBody：把 relay 错误格式翻译成 OpenAI 兼容格式，修复「Bad Request」盲区。
// 关键：@ai-sdk/openai 用 {error:{message}} 解析响应体；relay 用 {code,message,details}，
// 不翻译的话 AI SDK 会退化为 statusText（如 "Bad Request"），用户看不到真实原因。
describe('rewriteRelayErrorBody', () => {
  it('relay 标准错误 {code,message} → OpenAI {error:{message,type,code}}', () => {
    const raw = JSON.stringify({ code: 'insufficient_balance', message: '钱包余额不足' });
    const { body, status } = rewriteRelayErrorBody(402, raw);
    expect(status).toBe(402);
    expect(JSON.parse(body)).toMatchObject({
      error: {
        message: '钱包余额不足',
        type: 'insufficient_balance',
        code: 'insufficient_balance',
      },
    });
  });

  it('含上游根因 details.upstreamDetail → message 透传上游真实原因', () => {
    // relay 改动后会把 Kimi 的真实错误正文放进 details.upstreamDetail。
    const raw = JSON.stringify({
      code: 'upstream_llm_error',
      message: '上游模型调用失败',
      details: {
        upstreamStatus: 400,
        upstreamDetail: 'tool schema invalid: description must be an object',
      },
    });
    const { body, status } = rewriteRelayErrorBody(400, raw);
    expect(status).toBe(400);
    const parsed = JSON.parse(body);
    // message = relay message + 上游根因，用户据此能看到 Kimi 真正拒绝的原因。
    expect(parsed.error.message).toContain('上游模型调用失败');
    expect(parsed.error.message).toContain('tool schema invalid');
  });

  it('缺 message 字段 → 回落到 HTTP <status>', () => {
    const raw = JSON.stringify({ code: 'bad_request' });
    const { body, status } = rewriteRelayErrorBody(400, raw);
    expect(status).toBe(400);
    expect(JSON.parse(body).error.message).toBe('HTTP 400');
  });

  it('非 JSON body（如反代 502 的 HTML）→ 用原文截断作 message，不抛错', () => {
    const raw = '<html><body>502 Bad Gateway</body></html>';
    const { body, status } = rewriteRelayErrorBody(502, raw);
    expect(status).toBe(502);
    const parsed = JSON.parse(body);
    expect(parsed.error.message).toContain('502 Bad Gateway');
    expect(parsed.error.code).toBe('http_502');
  });

  it('空 body → message 回落为 HTTP <status>', () => {
    const { body, status } = rewriteRelayErrorBody(500, '');
    expect(status).toBe(500);
    expect(JSON.parse(body).error.message).toBe('HTTP 500');
  });
});

// readRelayErrorDetail：从 relay 错误响应体提取 detail + code，兼容三种格式。
//
// 修复「调用失败：HTTP 400」根因被吞的回归测试：loop.ts 的 fetch 包了 withRetryFetch，
// 它会把 relay 原生 {code,message} 翻译成 OpenAI {error:{message}}。此前 loop.ts 读顶层
// err.message（OpenAI 格式里不存在）→ detail 回落 "HTTP 400"，真实根因丢失。
// readRelayErrorDetail 统一两种格式的读取，下面验证各分支。
describe('readRelayErrorDetail', () => {
  it('OpenAI 格式 {error:{message}}（withRetryFetch 翻译后）→ 读出 error.message（回归核心）', () => {
    // 这正是 loop.ts 此前读不到的格式：withRetryFetch 已把 relay 错误翻译成 OpenAI 兼容。
    const raw = JSON.stringify({
      error: {
        message: '上游模型调用失败：tokenization failed: unexpected role developer',
        type: 'upstream_llm_error',
        code: 'upstream_llm_error',
      },
    });
    const { detail, code } = readRelayErrorDetail(400, raw);
    // 核心断言：detail 不再回落为 "HTTP 400"，而是透出完整根因。
    expect(detail).toBe('上游模型调用失败：tokenization failed: unexpected role developer');
    expect(code).toBe('upstream_llm_error');
  });

  it('relay 原生格式 {code,message}（未经过翻译的直连响应）→ 读出 message', () => {
    const raw = JSON.stringify({ code: 'insufficient_balance', message: '钱包余额不足' });
    const { detail, code } = readRelayErrorDetail(402, raw);
    expect(detail).toBe('钱包余额不足');
    expect(code).toBe('insufficient_balance');
  });

  it('relay 原生格式含上游根因 details.upstreamDetail → detail 拼接 message + 根因', () => {
    const raw = JSON.stringify({
      code: 'upstream_llm_error',
      message: '上游模型调用失败',
      details: {
        upstreamStatus: 400,
        upstreamDetail: 'tool schema invalid: description must be an object',
      },
    });
    const { detail, code } = readRelayErrorDetail(400, raw);
    expect(detail).toContain('上游模型调用失败');
    expect(detail).toContain('tool schema invalid');
    expect(code).toBe('upstream_llm_error');
  });

  it('OpenAI 格式 error 为字符串 → 读出该字符串', () => {
    const raw = JSON.stringify({ error: ' Bad Request ' });
    const { detail } = readRelayErrorDetail(400, raw);
    expect(detail).toBe(' Bad Request ');
  });

  it('缺 message/error → 回落到 code 字段', () => {
    const raw = JSON.stringify({ code: 'bad_request' });
    const { detail, code } = readRelayErrorDetail(400, raw);
    expect(detail).toBe('bad_request');
    expect(code).toBe('bad_request');
  });

  it('只有 code 但想用作 message 也无法读时 → 回落 HTTP <status>', () => {
    // 空 JSON 对象：没有任何可读字段。
    const raw = '{}';
    const { detail, code } = readRelayErrorDetail(418, raw);
    expect(detail).toBe('HTTP 418');
    expect(code).toBe('http_418');
  });

  it('非 JSON body（如反代 502 的 HTML）→ 截断原文作 detail，不抛错', () => {
    const raw = '<html><body>502 Bad Gateway</body></html>';
    const { detail, code } = readRelayErrorDetail(502, raw);
    expect(detail).toContain('502 Bad Gateway');
    expect(code).toBe('http_502');
  });

  it('空 body → detail 回落为 HTTP <status>', () => {
    const { detail, code } = readRelayErrorDetail(500, '');
    expect(detail).toBe('HTTP 500');
    expect(code).toBe('http_500');
  });

  it('loop.ts 重试判定：502 + code=upstream_llm_error 可正确提取 code', () => {
    // loop.ts 用 code 判断 502 是否为可重试的 upstream_llm_error。
    // withRetryFetch 翻译后 code 在 error.code 里，验证能正确取出。
    const raw = JSON.stringify({
      error: {
        message: '上游模型调用失败',
        type: 'upstream_llm_error',
        code: 'upstream_llm_error',
      },
    });
    const { code } = readRelayErrorDetail(502, raw);
    expect(code).toBe('upstream_llm_error');
  });
});
