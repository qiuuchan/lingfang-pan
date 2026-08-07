export class WebApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

let csrfToken = '';

export function setWebCsrfToken(value: string): void {
  csrfToken = value;
}

export async function requestJson<T>(
  path: string,
  decoder: { parse(value: unknown): T },
  init: RequestInit = {},
  fetchImplementation: FetchImplementation = fetch
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (csrfToken && !['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase()))
    headers.set('x-csrf-token', csrfToken);
  const response = await fetchImplementation(path, { ...init, headers, credentials: 'include' });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error = record(payload);
    throw new WebApiError(
      response.status,
      typeof error.code === 'string' ? error.code : `http_${response.status}`,
      typeof error.message === 'string' ? error.message : `请求失败：HTTP ${response.status}`,
      error.details
    );
  }
  return decoder.parse(payload);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
