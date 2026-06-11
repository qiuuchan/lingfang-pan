import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { setAuthToken } from '@/lib/api';
import type { Session, View, PluginDraft, LoadedPlugin } from '@/lib/types';
import { Sidebar } from '@/components/Sidebar';
import { Auth } from '@/pages/Auth';
import { TenantSelect } from '@/pages/TenantSelect';
import { Generator } from '@/pages/Generator';
import { Plugins } from '@/pages/Plugins';
import { Market } from '@/pages/Market';
import { Wallet } from '@/pages/Wallet';
import { Review } from '@/pages/Review';
import { Settings } from '@/pages/Settings';

interface AppContextValue {
  session: Session;
  applySession: (patch: Partial<Session>) => void;
  resetSession: () => void;
  view: View;
  setView: (v: View) => void;
  currentDraft: PluginDraft | null;
  setCurrentDraft: (d: PluginDraft | null) => void;
  runningPlugin: LoadedPlugin | null;
  setRunningPlugin: (p: LoadedPlugin | null) => void;
  // 固定到侧边栏的插件（按租户存于 localStorage）。
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

// 固定插件按租户隔离存储于 localStorage（本地偏好，不跨设备同步）。
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

const emptySession: Session = { token: null, userId: null, displayName: null, tenantId: null, tenantName: null, role: null, isPlatformAdmin: false };

export default function App() {
  const [session, setSession] = useState<Session>(emptySession);
  const [view, setView] = useState<View>('generator');
  const [currentDraft, setCurrentDraft] = useState<PluginDraft | null>(null);
  const [runningPlugin, setRunningPlugin] = useState<LoadedPlugin | null>(null);
  const [pinnedPlugins, setPinnedPlugins] = useState<LoadedPlugin[]>([]);

  const applySession = useCallback((patch: Partial<Session>) => {
    setSession((prev) => {
      const next = { ...prev, ...patch };
      setAuthToken(next.token);
      return next;
    });
  }, []);

  const resetSession = useCallback(() => {
    setAuthToken(null);
    setSession(emptySession);
  }, []);

  // 固定插件随当前租户加载（按租户隔离存于 localStorage）。
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
    session, applySession, resetSession,
    view, setView,
    currentDraft, setCurrentDraft,
    runningPlugin, setRunningPlugin,
    pinnedPlugins, pinPlugin, unpinPlugin, isPinned,
  };

  // 未登录 / 未选租户：全屏居中单页（无侧边栏）。
  if (!session.token) {
    return (
      <AppContext.Provider value={ctx}>
        <div className="flex min-h-screen items-center justify-center overflow-y-auto bg-background p-4 text-foreground"><Auth /></div>
        <Toaster position="top-right" richColors closeButton />
      </AppContext.Provider>
    );
  }
  if (!session.tenantId) {
    return (
      <AppContext.Provider value={ctx}>
        <div className="flex min-h-screen items-center justify-center overflow-y-auto bg-background p-4 text-foreground"><TenantSelect /></div>
        <Toaster position="top-right" richColors closeButton />
      </AppContext.Provider>
    );
  }

  let body: ReactNode;
  if (view === 'plugins') body = <Plugins />;
  else if (view === 'market') body = <Market />;
  else if (view === 'wallet') body = <Wallet />;
  else if (view === 'review') body = <Review />;
  else if (view === 'settings') body = <Settings />;
  else body = <Generator />;

  // 造插件用满宽双栏；其余页面居中限宽并可滚动。
  const wide = view === 'generator';

  return (
    <AppContext.Provider value={ctx}>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <Sidebar />
        {wide ? (
          <main className="flex min-h-0 flex-1 flex-col px-4 py-4">{body}</main>
        ) : (
          <main className="flex-1 overflow-y-auto px-6 py-6"><div className="mx-auto w-full max-w-5xl">{body}</div></main>
        )}
      </div>
      <Toaster position="top-right" richColors closeButton />
    </AppContext.Provider>
  );
}
