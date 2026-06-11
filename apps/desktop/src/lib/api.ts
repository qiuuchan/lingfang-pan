// 与本地服务端通信 + Tauri 命令桥。会话 token 以模块变量镜像，便于在 React 之外的 fetch 中读取。
// 后端地址可在分发时通过 public/app.config.json 的 api_base 覆盖（见 main.tsx 启动加载），便于打包不同环境。
const DEFAULT_API = 'http://127.0.0.1:8787';
let apiBaseUrl = DEFAULT_API;

export function setApiBase(url: string | null | undefined) {
  if (url && url.trim()) apiBaseUrl = url.trim().replace(/\/+$/, '');
}
export function apiBase() {
  return apiBaseUrl;
}

let authToken: string | null = null;
export function setAuthToken(t: string | null) {
  authToken = t;
}
export function getAuthToken() {
  return authToken;
}

// Tauri 命令调用（桌面环境注入 __TAURI__，需 tauri.conf.json 开 withGlobalTauri）。
export async function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const inv = (window as unknown as { __TAURI__?: { core?: { invoke?: Function } } }).__TAURI__?.core?.invoke;
  if (!inv) throw new Error('需在 LingFang 桌面环境中运行');
  return inv(cmd, args) as Promise<T>;
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
  try {
    res = await fetch(apiBase() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`无法连接服务端（${apiBase()}）。请确认已用 pnpm start 启动后端。`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || res.statusText) as ApiError;
    err.code = data.error;
    throw err;
  }
  return data as T;
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());
