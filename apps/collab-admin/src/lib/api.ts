const STORAGE_KEY = 'lf:collab-admin:token';

// ADMIN-01 修复：401 全局拦截事件名。
// api() 检测到 token 失效（HTTP 401 / code='unauthorized'）时派发此事件，
// App.tsx 注册监听器清空 session 回登录页，避免已挂载视图陷入「每次操作都弹『登录已过期』但不回登录页」的死循环。
// 后端 /api/auth/refresh 要求当前 token 仍有效（guard 先验签再 read req.user），
// 属「过期前滑动续签」而非「过期后补救」，因此 401 兜底清 session 仍是必需的。
export const UNAUTHORIZED_EVENT = 'lf:collab-admin:unauthorized';

export interface ApiError extends Error {
  code?: string;
  requestId?: string;
  // HTTP 状态码（ADMIN-01 / ADMIN-06）：调用方可据此精确判定失败场景，不依赖脆弱的字符串匹配。
  status?: number;
}

let token = localStorage.getItem(STORAGE_KEY);

export function getToken() {
  return token;
}

export function setToken(next: string | null) {
  token = next;
  if (next) localStorage.setItem(STORAGE_KEY, next);
  else localStorage.removeItem(STORAGE_KEY);
}

export function apiBase() {
  return import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_COLLAB_API_BASE || 'http://localhost:19006';
}

// ADMIN-06 修复：通用请求超时（30s）。
// 原 api() 无超时，后端 TCP 半开 / 极慢查询会让请求永久 pending，视图停留在静态全零页且无错误反馈。
// 与 App.tsx checkUpdate 的 AbortSignal.timeout(5000) 行为一致，避免前后不对称。
const DEFAULT_API_TIMEOUT_MS = 30_000;

export interface ApiOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  // multipart 上传：传 FormData 时跳过 JSON.stringify 与 application/json 头（浏览器自动加 boundary）。
  formData?: FormData;
  // 请求超时（毫秒）。默认 30s。
  timeoutMs?: number;
  // ADMIN-01：标记为 refresh 请求自身，避免 refresh 失败时递归派发 UNAUTHORIZED 导致重复清 session。
  _isRefresh?: boolean;
  // ADMIN-01：标记请求已因 401 重放过一次，防止 refresh 后仍 401 时无限递归重试。
  _retried?: boolean;
}

// 续签尝试的并发去重锁：避免多个 in-flight 请求同时 401 时并发触发多次 refresh。
// ADMIN-01 修复：管理端全链路此前从不调用 /api/auth/refresh，token 过期后无续签机制。
// 此处在首个 401 时尝试一次 refresh（仅当当前 token 仍有效），refresh 成功则重放原请求；
// refresh 失败或已过期则派发 UNAUTHORIZED 事件，由 App.tsx 清 session 回登录页。
let refreshInFlight: Promise<string | null> | null = null;

async function tryRefresh(): Promise<string | null> {
  if (!token) return null;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const next = await api<{ token?: string }>('/api/auth/refresh', { method: 'POST', auth: true, _isRefresh: true });
      if (next?.token) {
        setToken(next.token);
        return next.token;
      }
      return null;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  // formData 上传：不设 Content-Type（浏览器加 multipart boundary），body 直接用 FormData。
  // 否则默认 JSON：Content-Type: application/json + JSON.stringify(body)。
  const isFormData = options.formData instanceof FormData;
  const headers: Record<string, string> = isFormData ? {} : { 'Content-Type': 'application/json' };
  if (options.auth !== false && token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  // ADMIN-06：用 AbortController 兜底挂起的 fetch。
  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: options.method || 'GET',
      headers,
      body: isFormData ? options.formData : (options.body ? JSON.stringify(options.body) : undefined),
      signal: controller?.signal,
    });
  } catch (err) {
    // AbortError → 友好的超时提示；其余网络错误 → 连接失败提示。
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('后端响应超时，请检查网络或后端服务状态后重试。');
    }
    throw new Error(`无法连接协作平台 API（${apiBase()}）`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || response.statusText) as ApiError;
    error.code = data.code;
    error.requestId = data.requestId;
    error.status = response.status;
    // ADMIN-01：仅在「带 token 的 auth 请求 + HTTP 401 + 尚未重试过」时尝试 refresh 一次并重放；
    // refresh 本身（_isRefresh）失败不递归，直接派发 UNAUTHORIZED 让 App.tsx 清 session。
    // _retried 防止重放后仍 401 时无限递归（refresh 返回的 token 也失效 → 不再重试）。
    if (response.status === 401 && options.auth !== false && token && !options._isRefresh && !options._retried) {
      const refreshed = await tryRefresh();
      if (refreshed) {
        // 续签成功，重放原请求（用新 token），标记 _retried 防止再次 401 递归。
        const { _isRefresh: _, _retried: __, ...rest } = options;
        return api<T>(path, { ...rest, _retried: true });
      }
    }
    // 续签失败或已无 token：派发 UNAUTHORIZED 事件让 App.tsx 清 session 回登录页。
    // refresh 请求自身的 401 也走此分支（_isRefresh 已跳过上面的 tryRefresh 重放）。
    if (response.status === 401 && options.auth !== false && !options._isRefresh) {
      setToken(null);
      try { window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT)); } catch { /* 浏览器环境兜底 */ }
    }
    throw error;
  }
  return data as T;
}

export const isPlatformAdminSession = (session: AdminSession | null) => session?.user.platformRole === 'PLATFORM_ADMIN';

export interface AdminSession {
  token?: string;
  user: { id: string; email: string; displayName: string; platformRole: 'NONE' | 'PLATFORM_ADMIN'; status: string };
  onboarding: string;
}

export interface DashboardData {
  users: number;
  teams: number;
  pendingApplications: number;
  enabledPlugins: number;
  // ADMIN-VIEW-03 修复：仪表盘「已禁用插件」待办数此前硬编码 0，
  // 后端 /api/admin/dashboard 现返回该指标；前端读取后端值，避免假数据。
  disabledPlugins?: number;
}

// AI 生成质量看板（调研报告 Top10 / A4）。后端复用 AuditLog 聚合：
// 调用次数 = llm_binding.key_decrypted 计数，成功次数 = plugin.uploaded 计数。
// 失败数为近似估算（calls - success），avgDurationMs 暂为 null（audit 未记录耗时）。
export interface GenerationStats {
  period: string;
  month: { calls: number; success: number; failed: number; successRate: number };
  total: { calls: number; success: number; failed: number; successRate: number };
  avgDurationMs: number | null;
}

// 财务概览看板（调研报告 Top10 / C7）。全量基于 Purchase/Plugin 聚合：
// GMV = sum(Purchase.priceCents)，平台抽成暂为 0（ADR-0002）。
export interface FinanceTopPlugin {
  id: string;
  name: string;
  installCount: number;
  ratingCount: number;
  avgScore: number;
  priceCents: number;
}

export interface FinanceStats {
  period: string;
  month: { gmvCents: number };
  total: { gmvCents: number };
  platformRevenueCents: number;
  paidUserCount: number;
  totalUserCount: number;
  conversionRate: number;
  topPlugins: FinanceTopPlugin[];
}