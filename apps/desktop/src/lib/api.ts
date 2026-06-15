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
    // DESK-SHELL-01 修复：fallback 分支也持久化（与 configureApiBase 的 persist 对齐），
    // 否则 lf:session 写入但 lf:backendUrl 仍为空，后续重启若 app.config.json 的 api_base
    // 被清空/替换域名，initApiBase(null) 会得到空 base，但 loadStoredSession 仍返回带 token 的 session，
    // 主壳陷入「已登录但无后端」的死循环（refreshSession 抛无 code 的 Error，不触发 reset）。
    try {
      localStorage.setItem(BACKEND_URL_STORAGE_KEY, fallback);
    } catch {
      /* localStorage 不可用则只更新当前会话 */
    }
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

// 401 全局拦截事件名（DESK-TOKEN-01 / DESK-03 修复）：
// api() 检测到 token 失效（code='unauthorized' / 'invalid_token' 或 HTTP 401）时派发此事件，
// App.tsx 注册一次性监听器调用 resetSession()，避免业务页陷入反复 toast 但不回登录页的死循环。
export const UNAUTHORIZED_EVENT = 'lf:unauthorized';

// 后端不可达事件名（R6 连接失败页）：
// api() 检测到 fetch 抛网络异常（连接拒绝/DNS 失败/超时，非 HTTP 错误）时派发，
// App.tsx 监听后置 backendUnreachable=true，主界面渲染 BackendUnreachable 友好页替代反复 toast。
// 恢复（testBackendUrl 成功 / 后续请求成功）时派发 reachable 事件退出该态。
export const BACKEND_UNREACHABLE_EVENT = 'lf:backend-unreachable';
export const BACKEND_REACHABLE_EVENT = 'lf:backend-reachable';

// 判定错误是否为「连接失败」类（fetch 抛异常，非 HTTP 状态错误）。
// api() 的 catch 分支只抛两种 Error 文案：超时 / 无法连接后端。两者都意味着后端当前不可达。
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return msg.startsWith('后端响应超时') || msg.startsWith('无法连接后端');
}

// 便捷派发：连接失败派 unreachable，成功派 reachable（业务侧请求成功后可调用以退出不可达态）。
export function dispatchBackendUnreachable() {
  try { window.dispatchEvent(new CustomEvent(BACKEND_UNREACHABLE_EVENT)); } catch { /* webview 可能无 CustomEvent，静默兜底 */ }
}
export function dispatchBackendReachable() {
  try { window.dispatchEvent(new CustomEvent(BACKEND_REACHABLE_EVENT)); } catch { /* webview 可能无 CustomEvent，静默兜底 */ }
}

export interface ApiError extends Error {
  code?: string;
  // HTTP 状态码（DESK-06 / ACCT-01 修复）：api() 把 res.status 挂到错误对象上，
  // 调用方可据此精确判定「后端未实现 404/405」等场景，不再依赖脆弱的字符串匹配。
  status?: number;
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  // 请求超时（毫秒）。DESK-01 / DESK-SHELL-02 修复：默认 30s，
  // 超时后 abort fetch 并抛友好错误，避免后端挂起时 UI 加载态永久冻结。
  timeoutMs?: number;
}

// 默认请求超时（30s）。覆盖 fetch 原生「无超时」行为，与浏览器默认 connection timeout 解耦。
const DEFAULT_API_TIMEOUT_MS = 30_000;

export async function api<T = any>(path: string, { method = 'GET', body, auth = true, timeoutMs = DEFAULT_API_TIMEOUT_MS }: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth && authToken) headers.Authorization = `Bearer ${authToken}`;
  let res: Response;
  const base = apiBase();
  if (!base) throw new Error('尚未配置后端服务地址，请先填写后端 URL。');
  // 超时控制：用 AbortController 兜底挂起的 fetch（后端 TCP 连接但不回响应、慢查询、网络黑洞）。
  // 超时后 reject 友好错误，避免调用方加载态永久冻结（DESK-01 / DESK-SHELL-02）。
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller?.signal });
  } catch (err) {
    // AbortError → 友好的超时提示；其余网络错误 → 连接失败提示。
    // R6：两类都属「后端不可达」，派发 BACKEND_UNREACHABLE_EVENT 让 App 渲染友好页（替代反复 toast）。
    if (err instanceof DOMException && err.name === 'AbortError') {
      dispatchBackendUnreachable();
      throw new Error('后端响应超时，请检查网络或后端服务状态后重试。');
    }
    dispatchBackendUnreachable();
    throw new Error(`无法连接后端（${base}）。请检查后端地址、网络和跨域配置。`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // fetch 成功（拿到 HTTP 响应，无论状态码）：后端可达，退出不可达态。
  dispatchBackendReachable();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || res.statusText) as ApiError;
    err.code = data.code || data.error;
    err.status = res.status;
    // 401 全局拦截（DESK-TOKEN-01 / DESK-03）：仅在 auth 请求且 HTTP 401 时派发，
    // 由 App.tsx 监听器调用 resetSession（避免业务页陷入反复报错却不回登录页）。
    // 业务页的 toast 仍会照常抛出（瞬时反馈），此处不阻断 throw 流程。
    if (auth && res.status === 401) {
      try { window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT)); } catch { /* webview 可能无 CustomEvent，静默兜底 */ }
    }
    throw err;
  }
  return data as T;
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());
