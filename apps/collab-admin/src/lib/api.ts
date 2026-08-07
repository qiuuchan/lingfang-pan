// 管理端鉴权改为 HttpOnly Cookie（lingfang_admin_session）+ CSRF 双提交：
// 不再把令牌存入 localStorage / 内存，从源头消除 XSS 窃取可复用凭据的攻击面。
// 浏览器在同源（生产经 nginx 代理）或同站（开发 localhost 跨端口）请求时自动携带 Cookie；
// 写操作需附带 x-csrf-token（取自可读的 lingfang_admin_csrf Cookie）以防御跨站请求伪造。
// 调查结论（见本次死代码清理报告）：CSRF 防护本身没漏 —— readCsrfToken() 直接把
// 同一个 cookie 名硬编码进了正则，写操作照常带 x-csrf-token，后端 security.ts 也在校验。
// 这个常量只是被 readCsrfToken 漏用的重复字面量，改名时两处会失步。修法（一行）：
// 让 readCsrfToken 用它构造正则。但接线属于安全改动，留给 owner 定夺，先不动。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ADMIN_CSRF_COOKIE = 'lingfang_admin_csrf';

// ADMIN-01 修复：401 全局拦截事件名。
// api() 检测到会话失效（HTTP 401 / code='unauthorized'）时派发此事件，
// App.tsx 注册监听器清空 session 回登录页，避免已挂载视图陷入「每次操作都弹『登录已过期』但不回登录页」的死循环。
// 后端 /api/auth/refresh 基于 Cookie 续签（滑动续签，非过期补救），故 401 兜底清 session 仍是必需的。
export const UNAUTHORIZED_EVENT = 'lf:collab-admin:unauthorized';

export interface ApiError extends Error {
  code?: string;
  requestId?: string;
  kind?: 'http' | 'network' | 'timeout';
  // HTTP 状态码（ADMIN-01 / ADMIN-06）：调用方可据此精确判定失败场景，不依赖脆弱的字符串匹配。
  status?: number;
}

// 从可读 CSRF Cookie 中读取令牌，供写操作放入 x-csrf-token 头（防御跨站请求伪造）。
function readCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)lingfang_admin_csrf=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export function apiBase() {
  return (
    import.meta.env.VITE_API_BASE_URL ||
    import.meta.env.VITE_COLLAB_API_BASE ||
    (import.meta.env.DEV ? 'http://localhost:19006' : '')
  );
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
  // 调用方取消信号。用于视图卸载、筛选切换和详情切换时主动终止旧请求。
  signal?: AbortSignal;
  // ADMIN-01：标记为 refresh 请求自身，避免 refresh 失败时递归派发 UNAUTHORIZED 导致重复清 session。
  _isRefresh?: boolean;
  // ADMIN-01：标记请求已因 401 重放过一次，防止 refresh 后仍 401 时无限递归重试。
  _retried?: boolean;
}

// 续签按单飞行去重：并发 401 只触发一次 refresh（基于 Cookie，无需 token 比较）。
// ADMIN-01 修复：管理端全链路此前从不调用 /api/auth/refresh，token 过期后无续签机制。
// 此处在首个 401 时尝试一次 refresh（后端基于现有会话 Cookie 重新下发 Cookie），
// refresh 成功则重放原请求；refresh 失败或已过期则派发 UNAUTHORIZED 事件，由 App.tsx 清 session 回登录页。
let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      await api<unknown>('/api/auth/refresh', { method: 'POST', auth: true, _isRefresh: true });
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  // formData 上传：不设 Content-Type（浏览器加 multipart boundary），body 直接用 FormData。
  // 否则默认 JSON：Content-Type: application/json + JSON.stringify(body)。
  const isFormData = options.formData instanceof FormData;
  const headers: Record<string, string> = isFormData ? {} : { 'Content-Type': 'application/json' };
  // 鉴权完全由 HttpOnly Cookie 承载（浏览器自动附带），不再发送 Bearer。
  // 写操作（auth 且非安全方法）附带 CSRF 令牌，防御跨站请求伪造。
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase());
  if (options.auth !== false && isMutation) {
    const csrf = readCsrfToken();
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  let response: Response;
  let data: unknown;
  // ADMIN-06：用 AbortController 兜底挂起的 fetch，并把调用方取消转发给同一请求。
  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const controller = new AbortController();
  let abortSource: 'external' | 'timeout' | null = null;
  const abortFromCaller = () => {
    if (controller.signal.aborted) return;
    abortSource = 'external';
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          if (controller.signal.aborted) return;
          abortSource = 'timeout';
          controller.abort();
        }, timeoutMs)
      : null;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: options.method || 'GET',
      headers,
      // 跨域（开发直连 :19006）或同源（生产经 nginx）均携带 Cookie，使 HttpOnly 会话生效。
      credentials: 'include',
      body: isFormData ? options.formData : options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    try {
      data = (await response.json()) as unknown;
    } catch (err) {
      // 主动取消或超时也会中断 body 读取，必须交给外层按来源分类；普通非 JSON 响应沿用空对象兜底。
      if (controller.signal.aborted) throw err;
      data = {};
    }
  } catch (err) {
    // 调用方取消保留 AbortError 语义，领域 hook 可静默忽略；内部超时仍提供友好错误。
    if (abortSource === 'external') {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new DOMException('请求已取消。', 'AbortError');
    }
    if (abortSource === 'timeout') {
      const error = new Error('后端响应超时，请检查网络或后端服务状态后重试。') as ApiError;
      error.code = 'request_timeout';
      error.kind = 'timeout';
      throw error;
    }
    const error = new Error(`无法连接协作平台 API（${apiBase()}）`) as ApiError;
    error.code = 'network_error';
    error.kind = 'network';
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
  if (!response.ok) {
    const payload = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const rawMessage = typeof payload.message === 'string' ? payload.message : response.statusText;
    // 5xx 服务端错误不向管理员界面泄露原始消息（可能含堆栈/内部路径），改用通用文案 + 追踪号；
    // 4xx 由后端 AppExceptionFilter 已语义化，保留原始 message 便于前端提示。
    const safeMessage =
      response.status >= 500
        ? `服务暂时不可用，请稍后重试${typeof payload.requestId === 'string' ? `（追踪号 ${payload.requestId}）` : ''}`
        : rawMessage;
    const error = new Error(safeMessage) as ApiError;
    error.code = typeof payload.code === 'string' ? payload.code : undefined;
    error.requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined;
    error.kind = 'http';
    error.status = response.status;
    // refresh 请求自身失败时只把错误交给 tryRefresh；不能递归刷新或直接清 session。
    if (response.status === 401 && options.auth !== false && !options._isRefresh) {
      // 基于 Cookie 续签：后端重新下发会话 Cookie，成功后重放原请求（Cookie 由浏览器自动附带）。
      const ok = await tryRefresh();
      if (ok) {
        const { _isRefresh: _, _retried: __, ...rest } = options;
        return api<T>(path, { ...rest, _retried: true });
      }
      // 续签失败：会话已失效，清空前端 session 并提示重新登录。
      try {
        window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      } catch {
        /* 浏览器环境兜底 */
      }
    }
    throw error;
  }
  return data as T;
}

export const isPlatformAdminSession = (session: AdminSession | null) =>
  session?.user.platformRole === 'PLATFORM_ADMIN';

export interface AdminSession {
  token?: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    platformRole: 'NONE' | 'PLATFORM_ADMIN';
    status: string;
  };
  onboarding: string;
}

export interface DashboardData {
  users: number;
  teams: number;
  pendingApplications: number;
  pendingPluginReviews: number;
  activePluginPackages: number;
  activeMarketplaceListings: number;
  delistedMarketplaceListings: number;
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
