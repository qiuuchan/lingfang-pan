const STORAGE_KEY = 'lf:collab-admin:token';

export interface ApiError extends Error {
  code?: string;
  requestId?: string;
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
  return import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_COLLAB_API_BASE || 'http://localhost:3000';
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth !== false && token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error(`无法连接协作平台 API（${apiBase()}）`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || response.statusText) as ApiError;
    error.code = data.code;
    error.requestId = data.requestId;
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
}