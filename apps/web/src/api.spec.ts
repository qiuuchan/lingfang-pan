import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { WebApiError, requestJson, setWebCsrfToken } from './api';
import type { FetchImplementation } from './api';

// 用 requestJson 真实的注入点签名标注 mock，mock.calls 才会推断出正确的实参元组，
// 无需把 calls[0] 硬转成 [string, RequestInit]（那样会触发 TS2352/TS2493）。
type FetchMock = Mock<FetchImplementation>;

function okResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

function errorResponse(status: number, payload: unknown): Response {
  return { ok: false, status, json: async () => payload } as unknown as Response;
}

// init 在签名上是可选参数，这里显式取出并校验：缺失即视为用例失败，而非静默放行。
function initOf(fetchMock: FetchMock): RequestInit {
  const init = fetchMock.mock.calls[0]?.[1];
  if (init === undefined) throw new Error('fetch 未被调用，或调用时缺少 init 参数');
  return init;
}

function headersOf(fetchMock: FetchMock): Headers {
  return initOf(fetchMock).headers as Headers;
}

const passthrough = { parse: (value: unknown) => value };

describe('requestJson 成功路径', () => {
  it('返回 decoder.parse 的结果并透传 payload', async () => {
    const payload = { id: 'p-1', name: '插件' };
    const parse = vi.fn((value: unknown) => ({ ...(value as object), decoded: true }));
    const fetchMock = vi.fn<FetchImplementation>(async () => okResponse(payload));

    const result = await requestJson('/api/web/plugins', { parse }, {}, fetchMock);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(payload);
    expect(result).toEqual({ id: 'p-1', name: '插件', decoded: true });
  });

  it('总是带 accept: application/json 与 credentials: include', async () => {
    const fetchMock = vi.fn<FetchImplementation>(async () => okResponse({}));

    await requestJson('/api/web/ping', passthrough, {}, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input] = fetchMock.mock.calls[0];
    expect(input).toBe('/api/web/ping');
    expect(initOf(fetchMock).credentials).toBe('include');
    expect(headersOf(fetchMock).get('accept')).toBe('application/json');
  });

  it('有 body 时补 content-type: application/json，无 body 时不补', async () => {
    const withBody = vi.fn<FetchImplementation>(async () => okResponse({}));
    await requestJson(
      '/api/web/plugins',
      passthrough,
      { method: 'POST', body: JSON.stringify({ a: 1 }) },
      withBody
    );
    expect(headersOf(withBody).get('content-type')).toBe('application/json');

    const withoutBody = vi.fn<FetchImplementation>(async () => okResponse({}));
    await requestJson('/api/web/plugins', passthrough, { method: 'GET' }, withoutBody);
    expect(headersOf(withoutBody).get('content-type')).toBeNull();
  });

  it('保留调用方自定义头并保留 method/body', async () => {
    const fetchMock = vi.fn<FetchImplementation>(async () => okResponse({}));

    await requestJson(
      '/api/web/plugins',
      passthrough,
      { method: 'POST', body: '{}', headers: { 'x-trace-id': 'trace-1' } },
      fetchMock
    );

    const init = initOf(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(headersOf(fetchMock).get('x-trace-id')).toBe('trace-1');
  });

  it('decoder.parse 抛错时向上抛出', async () => {
    const fetchMock = vi.fn<FetchImplementation>(async () => okResponse({ bad: true }));
    const decoder = {
      parse: () => {
        throw new Error('schema 校验失败');
      },
    };

    await expect(requestJson('/api/web/plugins', decoder, {}, fetchMock)).rejects.toThrow(
      'schema 校验失败'
    );
  });
});

describe('requestJson 错误路径', () => {
  it('非 2xx 时按响应体抛出 WebApiError', async () => {
    const fetchMock = vi.fn<FetchImplementation>(async () =>
      errorResponse(429, { code: 'x', message: '限量', details: { retry_after: 30 } })
    );

    const error = await requestJson('/api/web/plugins', passthrough, {}, fetchMock).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(WebApiError);
    const apiError = error as WebApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.code).toBe('x');
    expect(apiError.message).toBe('限量');
    expect(apiError.details).toEqual({ retry_after: 30 });
  });

  it('错误体为数组时回退到 http_<status> 与默认文案', async () => {
    const fetchMock = vi.fn<FetchImplementation>(async () =>
      errorResponse(500, [{ code: 'ignored' }])
    );

    const error = (await requestJson('/api/web/plugins', passthrough, {}, fetchMock).catch(
      (caught: unknown) => caught
    )) as WebApiError;

    expect(error).toBeInstanceOf(WebApiError);
    expect(error.code).toBe('http_500');
    expect(error.message).toBe('请求失败：HTTP 500');
    expect(error.details).toBeUndefined();
  });

  it('错误体为非对象（字符串/null）时回退', async () => {
    const stringBody = vi.fn<FetchImplementation>(async () => errorResponse(403, 'forbidden'));
    const fromString = (await requestJson('/api/web/x', passthrough, {}, stringBody).catch(
      (caught: unknown) => caught
    )) as WebApiError;
    expect(fromString.code).toBe('http_403');
    expect(fromString.message).toBe('请求失败：HTTP 403');

    const nullBody = vi.fn<FetchImplementation>(async () => errorResponse(404, null));
    const fromNull = (await requestJson('/api/web/x', passthrough, {}, nullBody).catch(
      (caught: unknown) => caught
    )) as WebApiError;
    expect(fromNull.status).toBe(404);
    expect(fromNull.code).toBe('http_404');
    expect(fromNull.message).toBe('请求失败：HTTP 404');
  });

  it('响应体无法解析为 JSON 时回退', async () => {
    const fetchMock = vi.fn<FetchImplementation>(
      async () =>
        ({
          ok: false,
          status: 502,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
          },
        }) as unknown as Response
    );

    const error = (await requestJson('/api/web/x', passthrough, {}, fetchMock).catch(
      (caught: unknown) => caught
    )) as WebApiError;

    expect(error).toBeInstanceOf(WebApiError);
    expect(error.code).toBe('http_502');
    expect(error.message).toBe('请求失败：HTTP 502');
  });

  it('code/message 字段类型不是字符串时也回退', async () => {
    const fetchMock = vi.fn<FetchImplementation>(async () =>
      errorResponse(400, { code: 42, message: { zh: '坏' } })
    );

    const error = (await requestJson('/api/web/x', passthrough, {}, fetchMock).catch(
      (caught: unknown) => caught
    )) as WebApiError;

    expect(error.code).toBe('http_400');
    expect(error.message).toBe('请求失败：HTTP 400');
  });

  it('错误路径不会调用 decoder.parse', async () => {
    const parse = vi.fn();
    const fetchMock = vi.fn<FetchImplementation>(async () =>
      errorResponse(401, { code: 'unauthorized' })
    );

    await expect(requestJson('/api/web/x', { parse }, {}, fetchMock)).rejects.toBeInstanceOf(
      WebApiError
    );
    expect(parse).not.toHaveBeenCalled();
  });
});

describe('requestJson CSRF 分支', () => {
  it('写方法带 x-csrf-token，GET/HEAD 不带；空 token 一律不带', async () => {
    setWebCsrfToken('csrf-abc');
    try {
      const post = vi.fn<FetchImplementation>(async () => okResponse({}));
      await requestJson('/api/web/x', passthrough, { method: 'POST', body: '{}' }, post);
      expect(headersOf(post).get('x-csrf-token')).toBe('csrf-abc');

      const lowerCaseDelete = vi.fn<FetchImplementation>(async () => okResponse({}));
      await requestJson('/api/web/x', passthrough, { method: 'delete' }, lowerCaseDelete);
      expect(headersOf(lowerCaseDelete).get('x-csrf-token')).toBe('csrf-abc');

      const get = vi.fn<FetchImplementation>(async () => okResponse({}));
      await requestJson('/api/web/x', passthrough, { method: 'GET' }, get);
      expect(headersOf(get).get('x-csrf-token')).toBeNull();

      const head = vi.fn<FetchImplementation>(async () => okResponse({}));
      await requestJson('/api/web/x', passthrough, { method: 'HEAD' }, head);
      expect(headersOf(head).get('x-csrf-token')).toBeNull();

      const noMethod = vi.fn<FetchImplementation>(async () => okResponse({}));
      await requestJson('/api/web/x', passthrough, {}, noMethod);
      expect(headersOf(noMethod).get('x-csrf-token')).toBeNull();
    } finally {
      setWebCsrfToken('');
    }

    const afterReset = vi.fn<FetchImplementation>(async () => okResponse({}));
    await requestJson('/api/web/x', passthrough, { method: 'POST', body: '{}' }, afterReset);
    expect(headersOf(afterReset).get('x-csrf-token')).toBeNull();
  });
});

describe('WebApiError', () => {
  it('保存 status/code/message/details 且是 Error 实例', () => {
    const error = new WebApiError(500, 'e', 'msg');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WebApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe('e');
    expect(error.message).toBe('msg');
    expect(error.details).toBeUndefined();
  });

  it('details 可选且原样保留', () => {
    const details = { field: 'name' };
    const error = new WebApiError(422, 'invalid', '参数错误', details);

    expect(error.details).toBe(details);
    expect(String(error)).toContain('参数错误');
  });
});
