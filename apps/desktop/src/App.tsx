import { createContext, useContext, useState, useCallback, useEffect, useRef, lazy, Suspense, type ReactNode } from 'react';
import { Loader2Icon, XIcon } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { api, apiBase, configureApiBase, getAuthToken, normalizeBackendUrl, setAuthToken, UNAUTHORIZED_EVENT, BACKEND_UNREACHABLE_EVENT, BACKEND_REACHABLE_EVENT, type ApiError } from '@/lib/api';
import type { AccountSettingsTab, CollabSessionResponse, LoadedPlugin, PluginDraft, Session, SettingsTab, View } from '@/lib/types';
import { Sidebar } from '@/components/Sidebar';
import { TitleBar } from '@/components/TitleBar';
import { Footer } from '@/components/Footer';
import { BackendUnreachable } from '@/components/BackendUnreachable';
import { AccountDialog } from '@/components/AccountDialog';
import { CommandPalette } from '@/components/CommandPalette';
import { FloatingCreateButton } from '@/components/FloatingCreateButton';
// 组D 加载优化：PluginCreatorHome 是创建器主界面，且在 App 内常驻挂载（creator view 用 hidden 控制显隐，
// 跨 view 保持对话 listener 状态），保持直接 import、不延迟、不进 PageTransition。
import { Auth } from '@/pages/Auth';
import { Onboarding } from '@/pages/Onboarding';
import { SetupWizard } from '@/pages/SetupWizard';
import { Home } from '@/pages/Home';
import { PluginCreatorHome } from '@/pages/PluginCreatorHome';
import { ListSkeleton, PageTransition } from '@/lib/motion';
import { isPluginCenterView } from '@/lib/plugin-center';

const Plugins = lazy(() => import('./pages/Plugins').then((m) => ({ default: m.Plugins })));
const Review = lazy(() => import('./pages/Review').then((m) => ({ default: m.Review })));
const TeamAdmin = lazy(() => import('./pages/TeamAdmin').then((m) => ({ default: m.TeamAdmin })));

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
  // 受控的 Settings 页 Tab（供新手任务清单「去设置 → 模型服务」等定向跳转）。
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  accountSettingsTab: AccountSettingsTab;
  openAccountSettings: (tab?: AccountSettingsTab, settingsTab?: SettingsTab) => void;
  // 模型配置刷新信号：设置页保存模型绑定后递增，对话页据此重新拉取生效模型，
  // 避免保存后必须重启应用才在模型选择器看到新模型（跨页面通信，无持久化必要）。
  modelConfigVersion: number;
  bumpModelConfig: () => void;
  // 一键修复跨页传递：Plugins 页运行崩溃 → 设 stderr prompt → 跳创建器 → 创建器读取并自动 send。
  // 用完即清（null），无持久化必要。
  pendingAutoFixPrompt: string | null;
  setPendingAutoFixPrompt: (prompt: string | null) => void;
  // 云同步平台信息：platformName/logoUrl（GET /api/platform-info @Public），供侧栏 / 落地展示。
  // admin 改名后全端拉同一值；未配置时为默认 'LingFang' 与空 logoUrl（前端用图标 fallback）。
  platformName: string;
  platformLogoUrl: string;
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
  permissions: [],
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
    permissions: payload.permissions ?? [],
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
  // R6 后端不可达态：api() fetch 抛网络异常时派发 unreachable → true，主界面渲染 BackendUnreachable 友好页。
  // 后续请求成功或 testBackendUrl 探测通过时派发 reachable → false，恢复正常业务页。
  const [backendUnreachable, setBackendUnreachable] = useState(false);
  const [view, setViewState] = useState<View>('home');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Task 6 全局搜索悬浮窗：Ctrl/Cmd+K 或侧边栏搜索按钮唤起。
  const [searchOpen, setSearchOpen] = useState(false);
  // Task 9 创建器悬浮窗：FAB / setView('creator') 唤起，覆盖主体区为浮动窗口。
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [accountSettingsTab, setAccountSettingsTab] = useState<AccountSettingsTab>('account');
  const [currentDraft, setCurrentDraft] = useState<PluginDraft | null>(null);
  const [runningPlugin, setRunningPlugin] = useState<LoadedPlugin | null>(null);
  const [pinnedPlugins, setPinnedPlugins] = useState<LoadedPlugin[]>([]);
  // Settings 页受控 Tab：默认 'cli'。新手任务清单「去设置 → 模型服务」会把它改成 'gateway'。
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('cli');
  // 模型配置刷新信号：设置页保存绑定后 bumpModelConfig() 递增，PluginCreatorHome 依赖它重拉模型。
  const [modelConfigVersion, setModelConfigVersion] = useState(0);
  const bumpModelConfig = useCallback(() => setModelConfigVersion((v) => v + 1), []);
  // 一键修复：Plugins 页设 stderr prompt，跳创建器后创建器读取并自动 send 给 AI 修。
  const [pendingAutoFixPrompt, setPendingAutoFixPrompt] = useState<string | null>(null);
  // 云同步平台信息：GET /api/platform-info（@Public），backendUrl 已配置时拉取。
  // platformName 缺省 'LingFang'，logoUrl 缺省空串。admin 改名后全端拉同一值（侧栏 header 同步）。
  const [platformName, setPlatformName] = useState('LingFang');
  const [platformLogoUrl, setPlatformLogoUrl] = useState('');
  // 组D 首次启动安装向导：backendUrl 已配置且无 token 时查 /api/setup/status，
  // needsSetup=true（DB 无 PLATFORM_ADMIN）则渲染 SetupWizard 替代 Auth。
  const [needsSetup, setNeedsSetup] = useState(false);

  const openAccountSettings = useCallback((tab: AccountSettingsTab = 'account', nextSettingsTab?: SettingsTab) => {
    if (nextSettingsTab) setSettingsTab(nextSettingsTab);
    setAccountSettingsTab(tab);
    setAccountSettingsOpen(true);
  }, []);

  const setView = useCallback((nextView: View) => {
    // Task 9：'creator' 不再切换 view，改为打开创建器悬浮窗（保留底层页面，关闭即回到原页）。
    if (nextView === 'creator') {
      setCreatorOpen(true);
      return;
    }
    if (nextView === 'settings') {
      openAccountSettings('settings');
      return;
    }
    if (nextView === 'wallet') {
      openAccountSettings('wallet');
      return;
    }
    if (nextView === 'team') {
      openAccountSettings('team');
      return;
    }
    setAccountSettingsOpen(false);
    // 跳到其它页面时关闭创建器悬浮窗（若开着）。
    setCreatorOpen(false);
    setViewState(nextView);
  }, [openAccountSettings]);

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

  // R6 连接失败页：监听 api() 派发的后端不可达/可达事件，切换 backendUnreachable 状态。
  // 仅在已登录主界面响应（Auth/SetupWizard 页的连接错误走各自 toast，不渲染全屏不可达页）。
  useEffect(() => {
    const onUnreachable = () => { if (sessionRef.current.token) setBackendUnreachable(true); };
    const onReachable = () => setBackendUnreachable(false);
    window.addEventListener(BACKEND_UNREACHABLE_EVENT, onUnreachable);
    window.addEventListener(BACKEND_REACHABLE_EVENT, onReachable);
    return () => {
      window.removeEventListener(BACKEND_UNREACHABLE_EVENT, onUnreachable);
      window.removeEventListener(BACKEND_REACHABLE_EVENT, onReachable);
    };
  }, []);

  // 组D 首次启动安装向导：无 token 且 backendUrl 已配置时，查 /api/setup/status。
  // needsSetup=true（DB 无 PLATFORM_ADMIN）→ 渲染 SetupWizard 替代 Auth，拦截在登录之前。
  // 依赖 [session.token, backendUrl]：backendUrl 刚保存或登出（token 清空）时都会重新判定。
  // 查询失败（后端未启动 / 网络异常）不阻断：保守视为无需向导，进 Auth 走正常登录（登录会报错提示）。
  useEffect(() => {
    if (sessionRef.current.token || !backendUrl) {
      setNeedsSetup(false);
      return;
    }
    let cancelled = false;
    api<{ needsSetup: boolean }>('/api/setup/status', { auth: false })
      .then((res) => {
        if (!cancelled) setNeedsSetup(!!res.needsSetup);
      })
      .catch(() => {
        // 查询失败：保守不拦截，进 Auth（后端未就绪时 Auth 内的请求会给出连接错误提示）。
        if (!cancelled) setNeedsSetup(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session.token, backendUrl]);

  // 云同步平台信息：backendUrl 已配置时拉 GET /api/platform-info，更新侧栏 header 展示。
  // 失败静默（保持默认 'LingFang'），不阻断登录与主流程（与 Auth.tsx 同语义）。
  useEffect(() => {
    if (!backendUrl) return;
    let cancelled = false;
    api<{ platformName?: string; logoUrl?: string }>('/api/platform-info', { auth: false, method: 'GET' })
      .then((info) => {
        if (cancelled) return;
        if (info.platformName) setPlatformName(info.platformName.trim());
        if (info.logoUrl) setPlatformLogoUrl(info.logoUrl.trim());
      })
      .catch(() => {
        /* 拉取失败保持默认值，不阻断流程 */
      });
    return () => {
      cancelled = true;
    };
  }, [backendUrl]);

  useEffect(() => {
    setPinnedPlugins(loadPins(session.tenantId));
  }, [session.tenantId]);

  // Task 6：Ctrl/Cmd+K 唤起全局搜索悬浮窗（与 Sidebar 搜索按钮同一入口）。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
    settingsTab, setSettingsTab,
    accountSettingsTab, openAccountSettings,
    modelConfigVersion, bumpModelConfig,
    pendingAutoFixPrompt, setPendingAutoFixPrompt,
    platformName, platformLogoUrl,
  };

  if (restoring) {
    return (
      <AppContext.Provider value={ctx}>
        <Centered chrome label={platformName}>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {/* 登录态恢复期间给一个旋转指示，避免静态文字让用户误以为卡死。 */}
            <Loader2Icon className="size-4 animate-spin" />
            <span>正在恢复登录…</span>
          </div>
        </Centered>
        <Toaster position="top-right" richColors closeButton />
      </AppContext.Provider>
    );
  }

  if (!session.token) {
    // 组D：needsSetup=true（平台未初始化）时渲染 SetupWizard 替代 Auth，拦截在登录之前。
    // 向导完成后 needsSetup 置 false（effect 重查亦会刷新），回到 Auth 走正常登录。
    const authBody = needsSetup ? (
      <SetupWizard onDone={() => setNeedsSetup(false)} />
    ) : (
      <Auth />
    );
    return <AppContext.Provider value={ctx}><Centered chrome label={platformName}>{authBody}</Centered><Toaster position="top-right" richColors closeButton /></AppContext.Provider>;
  }

  if (session.onboarding && !['TEAM_SPACE', 'TEAM_ADMIN_SPACE'].includes(session.onboarding)) {
    return <AppContext.Provider value={ctx}><Centered chrome label={platformName}><Onboarding /></Centered><Toaster position="top-right" richColors closeButton /></AppContext.Provider>;
  }

  let body: ReactNode;
  if (view === 'home') body = <Home />;
  else if (view === 'plugins' || view === 'author-center' || view === 'market') body = <Plugins />;
  else if (view === 'review') body = session.isPlatformAdmin ? <Review /> : <Plugins />;
  else if (view === 'team-admin') body = <TeamAdmin />;
  else body = null;

  return (
    <AppContext.Provider value={ctx}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        {/* 自定义标题栏：侧边栏折叠按钮 + 应用名 + 窗口控制（最小化/最大化/关闭）。 */}
        <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        <div className="flex min-h-0 flex-1">
          <Sidebar collapsed={!sidebarOpen} onOpenSearch={() => setSearchOpen(true)} />
          <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {backendUnreachable ? (
              // R6 后端不可达：替换业务页为友好页（保留 TitleBar/Sidebar，用户仍可拖窗、切设置）。
              // 「去设置」跳 backend tab 改地址，「重试」探测成功后派发 reachable 退出此态。
              <BackendUnreachable onGoSettings={() => openAccountSettings('settings', 'backend')} />
            ) : (
              <>
                {/* 主体业务页：创建器悬浮窗关闭时始终可见（Task 9：创建器改为 overlay，不再替换底层 view）。 */}
                {isPluginCenterView(view) && runningPlugin ? (
                  // 插件运行态：全屏铺满（无 padding/max-w/边框），iframe 撑满整个主体区。
                  // body 是懒加载组件，仍需 Suspense 兜底首次解析（此时 chunk 通常已加载，fallback 不闪现）。
                  <div className="min-h-0 flex-1">
                    <Suspense fallback={null}>{body}</Suspense>
                  </div>
                ) : (
                  // 组D：主体区 flex-col 布局——内容区 flex-1 独占滚动空间（overflow-y-auto），
                  // Footer 作为 shrink-0 固定在视口底部（不随主内容滚动，不被顶下去，无需滚到底才可见）。
                  // 主内容滚不动 Footer；Footer 与侧边栏协调（侧边栏亦固定，二者一致）。
                  // Suspense 兜底懒加载 chunk（首次进入该 view 时），ListSkeleton 作占位；
                  // PageTransition 按 viewKey 切换做淡入/位移转场（尊重 useReducedMotion）。
                  <>
                    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                      <div className="mx-auto w-full max-w-6xl">
                        <Suspense fallback={<ListSkeleton rows={6} />}>
                          <PageTransition viewKey={view}>{body}</PageTransition>
                        </Suspense>
                      </div>
                    </div>
                    <Footer />
                  </>
                )}

                {/* Task 9 创建器悬浮窗：始终挂载以保留对话 listener 状态（与原 view==='creator' 常驻语义一致），
                    creatorOpen 时作为浮动窗口覆盖主体区；关闭回到底层页面。 */}
                <div className={creatorOpen ? 'absolute inset-0 z-30 flex flex-col bg-background shadow-2xl' : 'hidden'}>
                  <PluginCreatorHome />
                  {/* 浮动关闭按钮：创建器右上角，z-50 确保浮于创建器自身 header 之上。 */}
                  <button
                    type="button"
                    onClick={() => setCreatorOpen(false)}
                    aria-label="关闭创建器"
                    title="返回"
                    className="absolute right-3 top-3 z-50 inline-flex size-8 items-center justify-center rounded-full bg-background/80 text-muted-foreground backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <XIcon className="size-4" />
                  </button>
                </div>

                {/* Task 9 创建插件 FAB：右下角悬浮入口，创建器打开时自动隐藏。 */}
                <FloatingCreateButton open={creatorOpen} onClick={() => setCreatorOpen(true)} />
              </>
            )}
          </main>
        </div>
      </div>
      <AccountDialog
        open={accountSettingsOpen}
        onOpenChange={setAccountSettingsOpen}
        session={session}
        applySession={applySession}
        resetSession={resetSession}
        tab={accountSettingsTab}
        onTabChange={setAccountSettingsTab}
        settingsTab={settingsTab}
        onSettingsTabChange={setSettingsTab}
      />
      {/* Task 6 全局搜索悬浮窗：Ctrl/Cmd+K 唤起，背景模糊居中浮层。 */}
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <Toaster position="top-right" richColors closeButton />
    </AppContext.Provider>
  );
}

function Centered({ children, chrome = false, label = 'LingFang' }: { children: ReactNode; chrome?: boolean; label?: string }) {
  // chrome=true（登录/安装向导/恢复中等无侧边栏全屏态）：顶部渲染 TitleBar（承载窗口拖拽 + 最小化/最大化/关闭），
  // 内容在剩余空间垂直水平居中。decorations:false 隐藏了系统标题栏，登录页必须自实现拖拽入口。
  const body = (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-background p-4 text-foreground">{children}</div>
  );
  if (!chrome) {
    return <div className="flex min-h-screen flex-col bg-background text-foreground">{body}</div>;
  }
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar label={label} />
      {body}
    </div>
  );
}
