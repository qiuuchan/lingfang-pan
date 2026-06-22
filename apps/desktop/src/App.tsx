import { createContext, useContext, useState, useCallback, useEffect, useRef, lazy, Suspense, type ReactNode } from 'react';
import { Loader2Icon, XIcon } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, apiBase, configureApiBase, getAuthToken, normalizeBackendUrl, setAuthToken, tauriInvoke, tauriListen, UNAUTHORIZED_EVENT, BACKEND_UNREACHABLE_EVENT, BACKEND_REACHABLE_EVENT, type ApiError } from '@/lib/api';
import type { AccountSettingsTab, CollabSessionResponse, LoadedPlugin, PluginDraft, Session, SettingsTab, View } from '@/lib/types';
import { loadCloseAction } from '@/lib/close-behavior';
import { DEFAULT_ACTIVE_SKILLS } from '@/lib/skills';
import { Sidebar } from '@/components/Sidebar';
import { TitleBar } from '@/components/TitleBar';
import { BackendUnreachable } from '@/components/BackendUnreachable';
import { PanelDialog } from '@/components/PanelDialog';
import { ProfilePanel } from '@/components/ProfilePanel';
import { NotificationCenter } from '@/components/NotificationCenter';
import { CloseBehaviorDialog } from '@/components/CloseBehaviorDialog';
import { AvatarMenu } from '@/components/AvatarMenu';
import { CommandPalette } from '@/components/CommandPalette';
import { FloatingCreateButton } from '@/components/FloatingCreateButton';
import { PermissionConsentDialog } from '@/components/PermissionConsentDialog';
import { isStandalonePluginWindow, standalonePluginId } from '@/lib/plugin-window';
import { loadPlugins } from '@/pages/plugins-runtime';
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
// 项 14：AccountDialog 已删，其承载的 Wallet/TeamHome/Settings 改为各自由 PanelDialog 包裹的独立悬浮窗，
// 在 App 顶层懒加载挂载（与原 AccountDialog 内的懒加载同款）。
const Wallet = lazy(() => import('@/pages/Wallet').then((m) => ({ default: m.Wallet })));
const TeamHome = lazy(() => import('@/pages/TeamHome').then((m) => ({ default: m.TeamHome })));
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })));

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
  // 项 9：最近使用的插件（侧栏分区展示，按租户持久化 lf:recent:<tenantId>）。
  recentPlugins: LoadedPlugin[];
  pinPlugin: (p: LoadedPlugin) => void;
  unpinPlugin: (id: string) => void;
  isPinned: (id: string) => boolean;
  // 受控的 Settings 页 Tab（供新手任务清单「去设置 → 模型服务」等定向跳转）。
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  openAccountSettings: (tab?: AccountSettingsTab, settingsTab?: SettingsTab) => void;
  /** 项 1/14：打开通知中心悬浮窗（App 顶层独立挂载，不依赖 AvatarMenu 生命周期）。 */
  openNotifications: () => void;
  /** 项 5：打开团队管理居中悬浮窗。 */
  openTeamAdmin: () => void;
  /** 项 14：激活的 Skill id 列表（创建器 systemPrompt 拼装用）。 */
  activeSkillIds: string[];
  /** 项 14：切换某 Skill 激活态。 */
  toggleSkill: (id: string) => void;
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
  // Task 6/2：全局搜索悬浮窗开关。首页居中搜索框 / 侧栏搜索按钮 / Ctrl+K 共用此入口。
  openSearch: () => void;
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

// 项 9：最近使用插件（与 pins 同构：租户隔离、置顶去重、限量 5）。运行插件时记入，侧栏分区展示。
const RECENT_MAX = 5;
const recentKey = (tenantId: string | null) => `lf:recent:${tenantId || 'none'}`;
function loadRecent(tenantId: string | null): LoadedPlugin[] {
  try {
    const raw = localStorage.getItem(recentKey(tenantId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveRecent(tenantId: string | null, recent: LoadedPlugin[]) {
  try {
    localStorage.setItem(recentKey(tenantId), JSON.stringify(recent));
  } catch (err) {
    reportPersistenceFailure(err);
  }
}

// 项 14：激活的 Skill 集合（创建器 systemPrompt 拼装用）。默认 DEFAULT_ACTIVE_SKILLS，
// 用户在创建器 Skill 选择器里增减后持久化，跨会话保留。
const ACTIVE_SKILLS_KEY = 'lf:active-skills';
function loadActiveSkills(): string[] {
  try {
    const raw = localStorage.getItem(ACTIVE_SKILLS_KEY);
    if (!raw) return [...DEFAULT_ACTIVE_SKILLS];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [...DEFAULT_ACTIVE_SKILLS];
  } catch {
    return [...DEFAULT_ACTIVE_SKILLS];
  }
}
function saveActiveSkills(ids: string[]) {
  try {
    localStorage.setItem(ACTIVE_SKILLS_KEY, JSON.stringify(ids));
  } catch (err) {
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
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    // 默认折叠：首次无 key → getItem 返回 null → !== '1' → false。
    try { return localStorage.getItem('lf:sidebar-open') === '1'; } catch { return false; }
  });
  // Task 6 全局搜索悬浮窗：Ctrl/Cmd+K 或侧边栏搜索按钮唤起。
  const [searchOpen, setSearchOpen] = useState(false);
  // Task 9 创建器悬浮窗：FAB / setView('creator') 唤起，覆盖主体区为浮动窗口。
  // 项 7：开关态持久化（lf:creator-open），跨重启保留「上次是否打开」；背景模糊（见 overlay className）。
  const [creatorOpen, setCreatorOpenState] = useState<boolean>(() => {
    try { return localStorage.getItem('lf:creator-open') === '1'; } catch { return false; }
  });
  const setCreatorOpen = useCallback((v: boolean) => {
    setCreatorOpenState(v);
    try { localStorage.setItem('lf:creator-open', v ? '1' : '0'); } catch { /* 忽略配额/禁用 */ }
  }, []);
  // 项 14：AccountDialog 已拆为独立悬浮窗——每个功能各自一个 open state，由 openAccountSettings 路由分发。
  const [walletOpen, setWalletOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // 项 5：团队管理改为居中悬浮窗（原主区页面导航）。
  const [teamAdminOpen, setTeamAdminOpen] = useState(false);
  // 项 1：通知中心独立悬浮窗（不再嵌套在 AvatarMenu 内，修复点击即关闭/卡死 bug）。
  const [notifOpen, setNotifOpen] = useState(false);
  // 项 11：关窗询问悬浮窗（偏好为 'ask' 时弹出）。
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  // 项 14：激活的 Skill id 列表（创建器 systemPrompt 拼装用），持久化 lf:active-skills。
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>(loadActiveSkills);
  // 左下角用户按钮弹出的 AvatarMenu 开关（项 4：替代直接打开 AccountDialog）。
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [currentDraft, setCurrentDraft] = useState<PluginDraft | null>(null);
  const [runningPlugin, setRunningPluginState] = useState<LoadedPlugin | null>(null);
  const [pinnedPlugins, setPinnedPlugins] = useState<LoadedPlugin[]>([]);
  // 项 9：最近使用插件（与 pinnedPlugins 同构，按 tenantId 持久化隔离）。
  const [recentPlugins, setRecentPlugins] = useState<LoadedPlugin[]>([]);
  // 项 9：包装 setRunningPlugin —— 运行插件时记入「最近使用」（置顶、去重、限量 RECENT_MAX、按租户持久化）。
  // 保留 ctx 上 setRunningPlugin 原签名，所有现有调用方（Sidebar/Home/Plugins 等）自动走包装逻辑。
  const setRunningPlugin = useCallback((p: LoadedPlugin | null) => {
    setRunningPluginState(p);
    if (!p) return;
    setRecentPlugins((prev) => {
      const next = [p, ...prev.filter((x) => x.id !== p.id)].slice(0, RECENT_MAX);
      saveRecent(session.tenantId, next);
      return next;
    });
  }, [session.tenantId]);
  // Settings 页受控 Tab：默认 'cli'。新手任务清单「去设置 → 模型服务」会把它改成 'gateway'。
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('cli');
  // 模型配置刷新信号：设置页保存绑定后 bumpModelConfig() 递增，PluginCreatorHome 依赖它重拉模型。
  const [modelConfigVersion, setModelConfigVersion] = useState(0);
  const bumpModelConfig = useCallback(() => setModelConfigVersion((v) => v + 1), []);
  // 一键修复：Plugins 页设 stderr prompt，跳创建器后创建器读取并自动 send 给 AI 修。
  const [pendingAutoFixPrompt, setPendingAutoFixPrompt] = useState<string | null>(null);
  // 云同步平台信息：GET /api/platform-info（@Public），backendUrl 已配置时拉取。
  // platformName 缺省 'LingFang'，logoUrl 缺省空串。admin 改名后全端拉同一值（侧栏 header 同步）。
  const [platformName, setPlatformName] = useState('灵坊');
  const [platformLogoUrl, setPlatformLogoUrl] = useState('');
  // 组D 首次启动安装向导：backendUrl 已配置且无 token 时查 /api/setup/status，
  // needsSetup=true（DB 无 PLATFORM_ADMIN）则渲染 SetupWizard 替代 Auth。
  const [needsSetup, setNeedsSetup] = useState(false);

  // 项 14：路由到对应独立悬浮窗（保留原 openAccountSettings API，所有现有调用方零改动）。
  // 'account' → 个人资料、'team' → 切换团队、'wallet' → 钱包、'settings' → 设置（可用 nextSettingsTab 指定子 tab）。
  const openAccountSettings = useCallback((tab: AccountSettingsTab = 'account', nextSettingsTab?: SettingsTab) => {
    if (nextSettingsTab) setSettingsTab(nextSettingsTab);
    if (tab === 'wallet') setWalletOpen(true);
    else if (tab === 'team') setTeamOpen(true);
    else if (tab === 'settings') setSettingsOpen(true);
    else setProfileOpen(true);
  }, []);
  // 项 1：打开通知中心独立悬浮窗（AvatarMenu / 任意组件通过 context 调用）。
  const openNotifications = useCallback(() => setNotifOpen(true), []);
  // 项 5：打开团队管理居中悬浮窗。
  const openTeamAdmin = useCallback(() => setTeamAdminOpen(true), []);
  // 项 14：切换某 Skill 激活态（创建器 systemPrompt 据此动态拼装）。
  const toggleSkill = useCallback((id: string) => {
    setActiveSkillIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      saveActiveSkills(next);
      return next;
    });
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
    // 跳到其它页面时关闭所有功能悬浮窗 + 创建器（若开着），避免浮窗残留在新页面上。
    setWalletOpen(false);
    setTeamOpen(false);
    setSettingsOpen(false);
    setProfileOpen(false);
    setTeamAdminOpen(false);
    setNotifOpen(false);
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
    // 项 7：登出关闭创建器悬浮窗并清持久化，避免下次登录自动弹出（残留 lf:creator-open=1）。
    setCreatorOpen(false);
    sessionRef.current = emptySession;
    setSession(emptySession);
    setRunningPlugin(null);
    setView('home');
  }, [setCreatorOpen]);

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

  // 项 9：租户切换 / 登录态变化时重载「最近使用」插件列表。
  useEffect(() => {
    setRecentPlugins(loadRecent(session.tenantId));
  }, [session.tenantId]);

  // 侧栏开合持久化：用户切换后写盘，跨重启保留（首次无 key 默认折叠，见上 useState 初值）。
  useEffect(() => {
    try { localStorage.setItem('lf:sidebar-open', sidebarOpen ? '1' : '0'); } catch { /* 忽略配额/禁用 */ }
  }, [sidebarOpen]);

  // Task 15 多窗口：standalone 插件窗口（?standalone=1&plugin=<id>）启动时自动加载目标插件并设为 runningPlugin，
  // 让该窗口打开即运行指定插件，主窗口与各插件窗口互不干扰（不同插件各自独立窗口运行）。
  useEffect(() => {
    if (!isStandalonePluginWindow()) return;
    const targetId = standalonePluginId();
    if (!targetId || !session.token) return;
    let cancelled = false;
    void (async () => {
      try {
        const { plugins } = await loadPlugins();
        if (cancelled) return;
        const target = plugins.find((p) => p.id === targetId);
        if (target) setRunningPlugin(target);
      } catch {
        /* 加载失败静默：用户仍可手动在侧栏打开插件 */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token]);

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

  // Task 9：Esc 关闭创建器悬浮窗（与浮窗标题栏「返回（Esc）」提示一致）。
  // 若创建器内部有 Dialog/Sheet 打开（历史/预览/上传命名等），Esc 优先交给它们关闭，不连带关浮窗。
  useEffect(() => {
    if (!creatorOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const innerOverlayOpen = document.querySelector('[role="dialog"][data-state="open"], [role="presentation"][data-state="open"]');
      if (innerOverlayOpen) return; // 交给 Radix overlay 自身处理
      setCreatorOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [creatorOpen]);

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

  // Task 6/2：打开全局搜索悬浮窗（供首页居中搜索框 / 任意组件复用）。
  const openSearch = useCallback(() => setSearchOpen(true), []);

  // 项 11：关窗行为选择处理（由 CloseBehaviorDialog 回调）。
  // tray→隐藏到托盘、quit→调用 Rust quit_app 退出、cancel→什么都不做（窗口保持打开）。
  const handleCloseChoice = useCallback((action: 'tray' | 'quit' | 'cancel') => {
    setClosePromptOpen(false);
    if (action === 'tray') {
      void getCurrentWindow().hide();
    } else if (action === 'quit') {
      void tauriInvoke('quit_app');
    }
  }, []);

  // 项 11：监听 Rust 关窗拦截事件（main.rs on_window_event prevent_close 后 emit 'close-requested'）。
  // 按本地偏好 lf:close-action 决定：tray→隐藏、quit→退出、ask→弹 CloseBehaviorDialog。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    tauriListen('close-requested', () => {
      const pref = loadCloseAction();
      if (pref === 'tray') {
        void getCurrentWindow().hide();
      } else if (pref === 'quit') {
        void tauriInvoke('quit_app');
      } else {
        setClosePromptOpen(true);
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* 无 Tauri 壳（浏览器预览）静默忽略 */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const ctx: AppContextValue = {
    backendUrl, saveBackendUrl,
    session, applySession, applyCollabSession, refreshSession, resetSession,
    view, setView,
    currentDraft, setCurrentDraft,
    runningPlugin, setRunningPlugin,
    pinnedPlugins, recentPlugins, pinPlugin, unpinPlugin, isPinned,
    settingsTab, setSettingsTab,
    openAccountSettings, openNotifications, openTeamAdmin,
    activeSkillIds, toggleSkill,
    modelConfigVersion, bumpModelConfig,
    pendingAutoFixPrompt, setPendingAutoFixPrompt,
    platformName, platformLogoUrl,
    openSearch,
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
          <Sidebar
            collapsed={!sidebarOpen}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenAvatarMenu={() => setAvatarMenuOpen(true)}
          />
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
                  </>
                )}

                {/* Task 9 / 项 13 创建器悬浮窗：居中 ~70% 面板 + 模糊遮罩；始终挂载以保留对话 listener 状态。
                    外层 absolute inset-0 是半透模糊遮罩（bg-background/40 backdrop-blur），内层是居中不透明面板（约屏宽高 70%）。 */}
                <div className={creatorOpen ? 'absolute inset-0 z-30 flex items-center justify-center bg-background/40 backdrop-blur-xl' : 'hidden'}>
                  <div className="flex h-[85vh] w-[88vw] min-h-[480px] min-w-[960px] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
                    {/* 悬浮窗标题栏：独立的关闭入口，避免与创建器自身 header 的操作按钮重叠。 */}
                    <div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
                      <span className="text-xs text-muted-foreground">创建插件 · 悬浮窗</span>
                      <button
                        type="button"
                        onClick={() => setCreatorOpen(false)}
                        aria-label="关闭创建器"
                        title="返回（Esc）"
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <XIcon className="size-4" />
                      </button>
                    </div>
                    <div className="min-h-0 flex-1">
                      <PluginCreatorHome />
                    </div>
                  </div>
                </div>

                {/* Task 9 创建插件 FAB：右下角悬浮入口，创建器打开时自动隐藏。 */}
                <FloatingCreateButton open={creatorOpen} onClick={() => setCreatorOpen(true)} />
              </>
            )}
          </main>
        </div>
      </div>
      {/* 项 14：各功能独立悬浮窗（替代已删的 AccountDialog 聚合体）。每个由 AvatarMenu 对应按钮
          经 openAccountSettings 路由打开；Wallet/TeamHome/Settings 懒加载，Suspense 兜底首次加载。 */}
      <PanelDialog open={walletOpen} onOpenChange={setWalletOpen} title="钱包" size="md">
        <Suspense fallback={<ListSkeleton rows={6} />}><Wallet /></Suspense>
      </PanelDialog>
      <PanelDialog open={teamOpen} onOpenChange={setTeamOpen} title="切换团队" size="md">
        <Suspense fallback={<ListSkeleton rows={6} />}><TeamHome /></Suspense>
      </PanelDialog>
      <PanelDialog open={settingsOpen} onOpenChange={setSettingsOpen} title="设置" description="CLI / 模型服务 / 插件 / 后端地址">
        <Suspense fallback={<ListSkeleton rows={6} />}><Settings value={settingsTab} onValueChange={(v) => setSettingsTab(v as SettingsTab)} /></Suspense>
      </PanelDialog>
      <PanelDialog open={profileOpen} onOpenChange={setProfileOpen} title="个人资料" size="sm">
        <ProfilePanel session={session} applySession={applySession} resetSession={resetSession} onClose={() => setProfileOpen(false)} />
      </PanelDialog>
      {/* 项 5：团队管理居中悬浮窗（TeamAdmin 页，仅团队管理员；权限门控在 AvatarMenu 入口）。 */}
      <PanelDialog open={teamAdminOpen} onOpenChange={setTeamAdminOpen} title="团队管理" size="lg">
        <Suspense fallback={<ListSkeleton rows={6} />}><TeamAdmin /></Suspense>
      </PanelDialog>
      {/* 项 1：通知中心独立悬浮窗（Sheet portal，生命周期与 AvatarMenu 解耦，修复点击即关/卡死 bug）。 */}
      <NotificationCenter open={notifOpen} onOpenChange={setNotifOpen} />
      {/* 项 11：关窗询问悬浮窗（偏好 'ask' 时弹；tray/quit/cancel 三选项）。 */}
      <CloseBehaviorDialog open={closePromptOpen} onChoose={handleCloseChoice} />
      {/* 项 4：左下角用户按钮弹出的 AvatarMenu（v4 形态，适配当前 RBAC/View）。 */}
      <AvatarMenu open={avatarMenuOpen} onClose={() => setAvatarMenuOpen(false)} collapsed={!sidebarOpen} />
      {/* Task 6 全局搜索悬浮窗：Ctrl/Cmd+K 唤起，背景模糊居中浮层。 */}
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      {/* Task 14 系统级权限运行时确认框（监听 lf:permission-request 事件）。 */}
      <PermissionConsentDialog />
      <Toaster position="top-right" richColors closeButton />
    </AppContext.Provider>
  );
}

function Centered({ children, chrome = false, label = '灵坊' }: { children: ReactNode; chrome?: boolean; label?: string }) {
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
