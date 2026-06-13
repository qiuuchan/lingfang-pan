import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { api, apiBase, configureApiBase, getAuthToken, normalizeBackendUrl, setAuthToken, type ApiError } from '@/lib/api';
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
  } catch {
    /* localStorage 不可用则忽略 */
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
  } catch {
    /* localStorage 不可用则忽略 */
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
  return {
    token: payload.token ?? previousToken,
    userId: payload.user.id,
    displayName: payload.user.displayName,
    email: payload.user.email,
    tenantId: payload.team?.id ?? null,
    tenantName: payload.team?.name ?? null,
    role: payload.team?.role ?? null,
    isPlatformAdmin: payload.user.platformRole === 'PLATFORM_ADMIN',
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

  const applySession = useCallback((patch: Partial<Session>) => {
    setSession((prev) => {
      const next = { ...prev, ...patch };
      setAuthToken(next.token);
      saveStoredSession(next);
      return next;
    });
  }, []);

  const applyCollabSession = useCallback((payload: CollabSessionResponse) => {
    setSession((prev) => {
      const next = sessionFromPayload(payload, prev.token);
      setAuthToken(next.token);
      saveStoredSession(next);
      setView('home');
      return next;
    });
  }, []);

  const refreshSession = useCallback(async () => {
    const payload = await api<CollabSessionResponse>('/api/auth/me');
    applyCollabSession(payload);
  }, [applyCollabSession]);

  const resetSession = useCallback(() => {
    setAuthToken(null);
    clearStoredSession();
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
        if (code === 'unauthorized' || code === 'invalid_token') {
          resetSession();
        }
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <p className="text-sm text-muted-foreground">正在恢复会话…</p>
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
              <div className="h-full overflow-y-auto px-6 py-6">
                <div className="mx-auto w-full max-w-6xl">{body}</div>
              </div>
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
