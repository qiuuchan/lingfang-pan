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

export function configureApiBase(url: string | null | undefined, opts: { persist?: boolean } = {}) {
  const normalized = normalizeBackendUrl(url);
  apiBaseUrl = normalized ?? '';
  if (opts.persist) {
    try {
      if (normalized) localStorage.setItem(BACKEND_URL_STORAGE_KEY, normalized);
      else localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
    } catch {
      /* localStorage 不可用则只更新当前会话 */
    }
  }
  return Boolean(normalized);
}

export function clearApiBase() {
  apiBaseUrl = '';
  try { localStorage.removeItem(BACKEND_URL_STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * 初始化后端地址：用户保存值优先，其次 app.config.json 的 api_base，最后为空进入配置入口。
 */
export function initApiBase(defaultUrl?: string | null) {
  const stored = readStoredBackendUrl();
  if (stored) {
    apiBaseUrl = stored;
    return stored;
  }
  const fallback = normalizeBackendUrl(defaultUrl);
  apiBaseUrl = fallback ?? '';
  return fallback;
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
  if (!inv) throw new Error('需在 灵坊 桌面环境中运行');
  return inv(cmd, args) as Promise<T>;
}

export async function tauriListen<T = unknown>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  const listen = (window as unknown as { __TAURI__?: { event?: { listen?: Function } } }).__TAURI__?.event?.listen;
  if (!listen) throw new Error('需在 灵坊 桌面环境中运行');
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
  requestId?: string;
}

// 统一错误信息提取（DESK-UPDATE-01 修复）：tauriInvoke 调 Tauri 命令时，Rust 侧
// `Result<_, String>` 的错误以「裸字符串」形式 reject，而非 Error/ApiError 对象。
// 调用方若用 `(err as ApiError).message` 取信息，对裸字符串永远得 undefined，
// 真实失败原因（HTTP 状态、验签失败、网络错误）被吞，只能显示通用兜底文案。
// 此函数归一化任意来源错误为可读字符串：字符串原样返回，Error 取 message，
// 其余尝试 JSON 序列化兜底。提取不到时返回 fallback（调用方传入的兜底文案）。
export function errorMessage(err: unknown, fallback = ''): string {
  if (typeof err === 'string') return err.trim() || fallback;
  if (err instanceof Error) return err.message || fallback;
  if (err && typeof err === 'object') {
    // Tauri 偶发以 { message } / { error } 结构 reject，或后端 ApiError 形态。
    const obj = err as { message?: unknown; error?: unknown };
    if (typeof obj.message === 'string' && obj.message) return obj.message;
    if (typeof obj.error === 'string' && obj.error) return obj.error;
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      /* 含循环引用等无法序列化，落到兜底 */
    }
  }
  return fallback;
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  headers?: Record<string, string>;
  // multipart 上传：传 FormData 时跳过 JSON.stringify 与 application/json 头（浏览器自动加 boundary）。
  formData?: FormData;
  // 请求超时（毫秒）。DESK-01 / DESK-SHELL-02 修复：默认 30s，
  // 超时后 abort fetch 并抛友好错误，避免后端挂起时 UI 加载态永久冻结。
  timeoutMs?: number;
  /** 非可信客户端来源遥测；只允许宿主边界选择，插件不能传任意 header。 */
  clientSource?: 'desktop' | 'desktop-plugin' | 'desktop-plugin-test';
}

// 默认请求超时（30s）。覆盖 fetch 原生「无超时」行为，与浏览器默认 connection timeout 解耦。
const DEFAULT_API_TIMEOUT_MS = 30_000;

export async function api<T = any>(path: string, { method = 'GET', body, auth = true, headers: extraHeaders, formData, timeoutMs = DEFAULT_API_TIMEOUT_MS, clientSource = 'desktop' }: ApiOptions = {}): Promise<T> {
  // 客户端标识：用于后端日志/来源区分，不作为验证码或权限信任边界。
  // multipart 上传时不设 Content-Type，交给浏览器自动加 boundary（设了反而会破坏 multipart 解析）。
  const isFormData = formData instanceof FormData;
  const headers: Record<string, string> = { ...extraHeaders, 'X-Client': clientSource };
  if (!isFormData) headers['Content-Type'] = 'application/json';
  if (auth && authToken) headers.Authorization = `Bearer ${authToken}`;
  let res: Response;
  const base = apiBase();
  if (!base) throw new Error('尚未配置后端服务地址，请先填写后端 URL。');
  // 超时控制：用 AbortController 兜底挂起的 fetch（后端 TCP 连接但不回响应、慢查询、网络黑洞）。
  // 超时后 reject 友好错误，避免调用方加载态永久冻结（DESK-01 / DESK-SHELL-02）。
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    res = await fetch(base + path, { method, headers, body: isFormData ? formData : (body ? JSON.stringify(body) : undefined), signal: controller?.signal });
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
    const nested = data.error && typeof data.error === 'object' ? data.error : {};
    const errorText = typeof data.error === 'string' ? data.error : undefined;
    const err = new Error(data.message || nested.message || errorText || res.statusText) as ApiError;
    err.code = data.code || nested.code || (data.message ? errorText : undefined);
    err.status = res.status;
    err.requestId = data.requestId || nested.requestId || res.headers.get('x-request-id') || undefined;
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

/**
 * Download a non-JSON response through the same authenticated desktop API
 * boundary.  This is deliberately tiny (currently used by team-admin JSONL
 * exports) so pages never hand-roll Bearer headers or expose the session token.
 */
export async function apiDownload(path: string, { timeoutMs = DEFAULT_API_TIMEOUT_MS, clientSource = 'desktop' }: { timeoutMs?: number; clientSource?: ApiOptions['clientSource'] } = {}): Promise<Blob> {
  const base = apiBase();
  if (!base) throw new Error('尚未配置后端服务地址，请先填写后端 URL。');
  const headers: Record<string, string> = { 'X-Client': clientSource };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response: Response;
  try {
    response = await fetch(base + path, { method: 'GET', headers, signal: controller?.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      dispatchBackendUnreachable();
      throw new Error('后端响应超时，请检查网络或后端服务状态后重试。');
    }
    dispatchBackendUnreachable();
    throw new Error(`无法连接后端（${base}）。请检查后端地址、网络和跨域配置。`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  dispatchBackendReachable();
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const nested = data.error && typeof data.error === 'object' ? data.error : {};
    const error = new Error(data.message || nested.message || response.statusText) as ApiError;
    error.code = data.code || nested.code;
    error.status = response.status;
    error.requestId = data.requestId || nested.requestId || response.headers.get('x-request-id') || undefined;
    if (response.status === 401) {
      try { window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT)); } catch { /* webview 可能无 CustomEvent */ }
    }
    throw error;
  }
  return response.blob();
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());
