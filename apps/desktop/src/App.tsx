import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { api, apiBase, configureApiBase, getAuthToken, normalizeBackendUrl, setAuthToken, UNAUTHORIZED_EVENT, type ApiError } from '@/lib/api';
import type { CollabSessionResponse, LoadedPlugin, PluginDraft, Session, View } from '@/lib/types';
import { Sidebar } from '@/components/Sidebar';
import { TitleBar } from '@/components/TitleBar';
// PanelLeft 图标已移到 TitleBar，不再在此 import。
import { Auth } from '@/pages/Auth';
import { Onboarding } from '@/pages/Onboarding';
import { TeamHome } from '@/pages/TeamHome';
import { TeamManage } from '@/pages/TeamManage';
import { Plugins } from '@/pages/Plugins';
import { Settings } from '@/pages/Settings';
import { Market } from '@/pages/Market';
import { Wallet } from '@/pages/Wallet';
import { Review } from '@/pages/Review';
import { PluginCreatorHome } from '@/pages/PluginCreatorHome';

interface AppContextValue {
  backendUrl: string | null;
  saveBackendUrl: (url: string) => boolean;
  session: Session;
  applySession: (patch: Partial<Session>) => void;
  applyCollabSession: (payload: CollabSessionResponse) => void;
  refreshSession: () => Promise<void>;
  resetSession: () => void;
  view: View;
  setView: (v: View) => void;
  currentDraft: PluginDraft | null;
  setCurrentDraft: (d: PluginDraft | null) => void;
  runningPlugin: LoadedPlugin | null;
  setRunningPlugin: (p: LoadedPlugin | null) => void;
  pinnedPlugins: LoadedPlugin[];
  pinPlugin: (p: LoadedPlugin) => void;
  unpinPlugin: (id: string) => void;
  isPinned: (id: string) => boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}

const pinKey = (tenantId: string | null) => `lf:pins:${tenantId || 'none'}`;
function loadPins(tenantId: string | null): LoadedPlugin[] {
  try {
    const raw = localStorage.getItem(pinKey(tenantId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function savePins(tenantId: string | null, pins: LoadedPlugin[]) {
  try {
    localStorage.setItem(pinKey(tenantId), JSON.stringify(pins));
  } catch (err) {
    // DESK-SHELL-04 修复：配额满 / localStorage 被禁用时不再静默吞错，
    // 给用户可见提示（持久化失败会导致下次重启「固定插件丢失」，需提示）。
    reportPersistenceFailure(err);
  }
}

const emptySession: Session = {
  token: null,
  userId: null,
  displayName: null,
  email: null,
  tenantId: null,
  tenantName: null,
  role: null,
  isPlatformAdmin: false,
  onboarding: null,
  application: null,
};

const SESSION_STORAGE_KEY = 'lf:session';

// DESK-SHELL-04 修复：localStorage 配额满 / 被禁用时统一提示，避免「持久化静默失败、
// 重启后丢失登录态/固定插件」无任何线索。仅在失败后提示一次（节流），避免刷屏。
let persistenceErrorReported = false;
function reportPersistenceFailure(err: unknown) {
  if (persistenceErrorReported) return;
  persistenceErrorReported = true;
  const isQuotaOrSecurity = err instanceof DOMException && (err.name === 'QuotaExceededError' || err.name === 'SecurityError');
  const hint = isQuotaOrSecurity
    ? '存储空间不足或被禁用，登录状态和固定插件可能无法保存，下次启动需重新登录。'
    : '存储写入失败，登录状态可能未保存。';
  // 延迟一帧再 toast，避免在模块顶层/事件回调同步路径触发渲染异常。
  setTimeout(() => {
    try { import('sonner').then(({ toast }) => toast.warning(hint)); } catch { /* sonner 未加载则忽略 */ }
  }, 0);
}

function loadStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}
function saveStoredSession(session: Session) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch (err) {
    // DESK-SHELL-04 修复：配额满 / localStorage 被禁用时不再静默吞错。
    reportPersistenceFailure(err);
  }
}
function clearStoredSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* localStorage 不可用则忽略 */
  }
}

function sessionFromPayload(payload: CollabSessionResponse, previousToken: string | null): Session {
  // DESK-SHELL-05 修复：后端 /api/auth/me 在反代改写 / 响应截断 / 版本不符等场景可能返回 2xx
  // 但 body 缺 user 字段。此前直接 payload.user.id 裸解引用会在 setSession updater 内抛 TypeError，
  // 又因 main.tsx 无 ErrorBoundary 会白屏不可恢复。此处显式校验 payload.user，
  // 缺失时抛出带语义的错误，由 refreshSession 的 .catch 兜底 resetSession，避免崩溃。
  const user = payload && typeof payload === 'object' ? payload.user : undefined;
  if (!user || typeof user.id !== 'string' || typeof user.email !== 'string' || typeof user.displayName !== 'string') {
    throw new Error('服务返回的数据缺少必要的用户信息，请重新登录。');
  }
  return {
    token: payload.token ?? previousToken,
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    tenantId: payload.team?.id ?? null,
    tenantName: payload.team?.name ?? null,
    role: payload.team?.role ?? null,
    isPlatformAdmin: user.platformRole === 'PLATFORM_ADMIN',
    onboarding: payload.onboarding,
    application: payload.application,
  };
}

export default function App() {
  const [session, setSession] = useState<Session>(() => {
    const stored = loadStoredSession();
    if (stored) return stored;
    const token = getAuthToken();
    return token ? { ...emptySession, token } : emptySession;
  });
  const [restoring, setRestoring] = useState(() => session.token !== null);
  const [backendUrl, setBackendUrl] = useState<string | null>(() => apiBase() || null);
  const [view, setView] = useState<View>('home');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [currentDraft, setCurrentDraft] = useState<PluginDraft | null>(null);
  const [runningPlugin, setRunningPlugin] = useState<LoadedPlugin | null>(null);
  const [pinnedPlugins, setPinnedPlugins] = useState<LoadedPlugin[]>([]);

  const saveBackendUrl = useCallback((url: string) => {
    const normalized = normalizeBackendUrl(url);
    if (!normalized) return false;
    configureApiBase(normalized, { persist: true });
    setBackendUrl(normalized);
    return true;
  }, []);

  // DESK-SHELL-03 修复：applySession / applyCollabSession 不再把 setAuthToken / saveStoredSession /
  // setView 等副作用放进 setSession updater（React 要求 updater 纯函数；StrictMode dev 下双调
  // 与并发渲染可能丢弃该次更新，副作用已落盘但内存 session 未变更，造成状态不一致）。
  // 改为先在函数体内顺序执行副作用，再调纯 setSession 拼接 next 状态。
  // 用 ref 跟踪最新 session，使 updater 之外也能读到 prev（避免闭包陈旧）。
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  const applySession = useCallback((patch: Partial<Session>) => {
    const next = { ...sessionRef.current, ...patch };
    setAuthToken(next.token);
    saveStoredSession(next);
    sessionRef.current = next;
    setSession(next);
  }, []);

  const applyCollabSession = useCallback((payload: CollabSessionResponse) => {
    const next = sessionFromPayload(payload, sessionRef.current.token);
    setAuthToken(next.token);
    saveStoredSession(next);
    sessionRef.current = next;
    setView('home');
    setSession(next);
  }, []);

  const refreshSession = useCallback(async () => {
    const payload = await api<CollabSessionResponse>('/api/auth/me');
    applyCollabSession(payload);
  }, [applyCollabSession]);

  const resetSession = useCallback(() => {
    setAuthToken(null);
    clearStoredSession();
    // DESK-SHELL-07 修复：登出时清空 currentDraft，避免同机下一登录用户短暂看到上一用户的草稿。
    // App 始终挂载（登出渲染 Auth 不卸载），useState 不会自动重置。
    setCurrentDraft(null);
    sessionRef.current = emptySession;
    setSession(emptySession);
    setRunningPlugin(null);
    setView('home');
  }, []);

  // 启动时若本地存有 session，静默调 /api/auth/me 刷新；仅 token 真无效（401）才登出。
  // 网络/后端未启动时保留已恢复的 session，进主界面，下次启动重试。
  useEffect(() => {
    if (!session.token) {
      setRestoring(false);
      return;
    }
    let cancelled = false;
    refreshSession()
      .catch((err) => {
        if (cancelled) return;
        const code = (err as ApiError).code;
        // DESK-SHELL-01 修复：apiBase() 为空时 api() 抛无 code 的 Error，此前不匹配
        // unauthorized/invalid_token 分支，导致保留 session 却锁进「已登录但无后端」死循环。
        // 此处对「无 code 的连接错误」也清 session（让用户回到 Auth/Settings 重新配置）。
        // 仅当确实没有后端地址（而非短暂网络抖动）时才清，避免误登出。
        if (code === 'unauthorized' || code === 'invalid_token') {
          resetSession();
        } else if (!apiBase()) {
          // 没有 apiBase：session 残留无意义，回到 Auth 页让用户重新配置后端。
          resetSession();
        }
        // 其余网络错误（连接失败）：保留 session，进主界面，下次启动重试。
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // DESK-TOKEN-01 / DESK-03 修复：全局监听 api() 派发的 UNAUTHORIZED 事件，
  // 任意业务页遇到 401（token 过期/被吊销）时统一登出，避免「反复 toast 但不回登录页」死循环。
  // 仅在已登录态响应（避免 Auth 页的 401 也误触发）。
  useEffect(() => {
    const handler = () => {
      if (sessionRef.current.token) resetSession();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
  }, [resetSession]);

  useEffect(() => {
    setPinnedPlugins(loadPins(session.tenantId));
  }, [session.tenantId]);

  const pinPlugin = useCallback((p: LoadedPlugin) => {
    setPinnedPlugins((prev) => {
      if (prev.some((x) => x.id === p.id)) return prev;
      const next = [...prev, p];
      savePins(session.tenantId, next);
      return next;
    });
  }, [session.tenantId]);

  const unpinPlugin = useCallback((id: string) => {
    setPinnedPlugins((prev) => {
      const next = prev.filter((x) => x.id !== id);
      savePins(session.tenantId, next);
      return next;
    });
  }, [session.tenantId]);

  const isPinned = useCallback((id: string) => pinnedPlugins.some((x) => x.id === id), [pinnedPlugins]);

  const ctx: AppContextValue = {
    backendUrl, saveBackendUrl,
    session, applySession, applyCollabSession, refreshSession, resetSession,
    view, setView,
    currentDraft, setCurrentDraft,
    runningPlugin, setRunningPlugin,
    pinnedPlugins, pinPlugin, unpinPlugin, isPinned,
  };

  if (restoring) {
    return (
      <AppContext.Provider value={ctx}>
        <Centered>
          <p className="text-sm text-muted-foreground">正在恢复登录…</p>
        </Centered>
        <Toaster position="top-right" richColors closeButton />
      </AppContext.Provider>
    );
  }

  if (!session.token) {
    return <AppContext.Provider value={ctx}><Centered><Auth /></Centered><Toaster position="top-right" richColors closeButton /></AppContext.Provider>;
  }

  if (session.onboarding && !['TEAM_SPACE', 'TEAM_ADMIN_SPACE'].includes(session.onboarding)) {
    return <AppContext.Provider value={ctx}><Centered><Onboarding /></Centered><Toaster position="top-right" richColors closeButton /></AppContext.Provider>;
  }

  let body: ReactNode;
  if (view === 'plugins') body = <Plugins />;
  else if (view === 'team-manage') body = <TeamManage />;
  else if (view === 'market') body = <Market />;
  else if (view === 'wallet') body = <Wallet />;
  else if (view === 'review') body = session.isPlatformAdmin ? <Review /> : <Plugins />;
  else if (view === 'settings') body = <Settings />;
  else body = <TeamHome />;

  return (
    <AppContext.Provider value={ctx}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        {/* 自定义标题栏：侧边栏折叠按钮 + 应用名 + 窗口控制（最小化/最大化/关闭）。 */}
        <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        <div className="flex min-h-0 flex-1">
          <Sidebar collapsed={!sidebarOpen} />
          <main className="relative flex-1 overflow-hidden">
            <div className={view === 'home' ? 'h-full' : 'hidden'}>
              <PluginCreatorHome />
            </div>
            {view !== 'home' && (
              view === 'plugins' && runningPlugin ? (
                // 插件运行态：全屏铺满（无 padding/max-w/边框），iframe 撑满整个主体区。
                <div className="h-full">{body}</div>
              ) : (
                <div className="h-full overflow-y-auto px-6 py-6">
                  <div className="mx-auto w-full max-w-6xl">{body}</div>
                </div>
              )
            )}
          </main>
        </div>
      </div>
      <Toaster position="top-right" richColors closeButton />
    </AppContext.Provider>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center overflow-y-auto bg-background p-4 text-foreground">{children}</div>;
}
