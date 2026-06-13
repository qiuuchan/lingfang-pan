const BACKEND_URL_STORAGE_KEY = 'lf:backendUrl';
const AUTH_TOKEN_STORAGE_KEY = 'lf:authToken';
let apiBaseUrl = '';

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, '');

export function normalizeBackendUrl(raw: string | null | undefined): string | null {
  const value = trimTrailingSlash((raw || '').trim());
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimTrailingSlash(parsed.toString());
  } catch {
    return null;
  }
}

function readStoredBackendUrl(): string | null {
  try {
    return normalizeBackendUrl(localStorage.getItem(BACKEND_URL_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function configureApiBase(url: string | null | undefined, { persist = false }: { persist?: boolean } = {}) {
  const normalized = normalizeBackendUrl(url);
  if (!normalized) return false;
  apiBaseUrl = normalized;
  if (persist) {
    try {
      localStorage.setItem(BACKEND_URL_STORAGE_KEY, normalized);
    } catch {
      /* localStorage 不可用则只更新当前会话 */
    }
  }
  return true;
}

export function clearApiBase() {
  apiBaseUrl = '';
  try {
    localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
  } catch {
    /* localStorage 不可用则忽略 */
  }
}

export function initApiBase(defaultUrl?: string | null) {
  const stored = readStoredBackendUrl();
  if (stored) {
    apiBaseUrl = stored;
    return stored;
  }
  const fallback = normalizeBackendUrl(defaultUrl);
  if (fallback) {
    apiBaseUrl = fallback;
    return fallback;
  }
  apiBaseUrl = '';
  return null;
}

export function setApiBase(url: string | null | undefined) {
  configureApiBase(url);
}
export function apiBase() {
  return apiBaseUrl;
}

export async function testBackendUrl(url: string): Promise<void> {
  const normalized = normalizeBackendUrl(url);
  if (!normalized) throw new Error('请输入以 http:// 或 https:// 开头的后端地址');
  let res: Response;
  try {
    res = await fetch(`${normalized}/api/health`, { method: 'GET', cache: 'no-store' });
  } catch {
    throw new Error(`无法连接后端（${normalized}）。请检查地址、网络和跨域配置。`);
  }
  if (!res.ok) throw new Error(`后端健康检查失败：HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data.status !== 'ok') throw new Error('后端健康检查响应不正确');
}

let authToken: string | null = null;
export function setAuthToken(t: string | null) {
  authToken = t;
  try {
    if (t) localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, t);
    else localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    /* localStorage 不可用则只更新当前会话 */
  }
}
export function getAuthToken() {
  return authToken;
}
export function initAuthToken(): string | null {
  try {
    const stored = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    if (stored) authToken = stored;
    return authToken;
  } catch {
    return null;
  }
}

// Tauri 命令调用（桌面环境注入 __TAURI__，需 tauri.conf.json 开 withGlobalTauri）。
export async function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const inv = (window as unknown as { __TAURI__?: { core?: { invoke?: Function } } }).__TAURI__?.core?.invoke;
  if (!inv) throw new Error('需在 LingFang 桌面环境中运行');
  return inv(cmd, args) as Promise<T>;
}

export async function tauriListen<T = unknown>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  const listen = (window as unknown as { __TAURI__?: { event?: { listen?: Function } } }).__TAURI__?.event?.listen;
  if (!listen) throw new Error('需在 LingFang 桌面环境中运行');
  return listen(event, handler) as Promise<() => void>;
}

export interface ApiError extends Error {
  code?: string;
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

export async function api<T = any>(path: string, { method = 'GET', body, auth = true }: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth && authToken) headers.Authorization = `Bearer ${authToken}`;
  let res: Response;
  const base = apiBase();
  if (!base) throw new Error('尚未配置后端服务地址，请先填写后端 URL。');
  try {
    res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`无法连接后端（${base}）。请检查后端地址、网络和跨域配置。`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || res.statusText) as ApiError;
    err.code = data.code || data.error;
    throw err;
  }
  return data as T;
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());
