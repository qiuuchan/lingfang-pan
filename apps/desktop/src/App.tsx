import { createContext, useContext, useState, useCallback, useEffect, useRef, lazy, Suspense, type ReactNode } from 'react';
import { Loader2Icon, SparklesIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, apiBase, clearApiBase, configureApiBase, errorMessage, getAuthToken, normalizeBackendUrl, setAuthToken, tauriInvoke, tauriListen, UNAUTHORIZED_EVENT, BACKEND_UNREACHABLE_EVENT, BACKEND_REACHABLE_EVENT, type ApiError } from '@/lib/api';
import type { AccountSettingsTab, CollabSessionResponse, LoadedPlugin, PendingAutoFix, PendingDraftEdit, PluginDraft, Session, SettingsTab, View } from '@/lib/types';
import { loadCloseAction } from '@/lib/close-behavior';
import { checkUpdate, loadUpdateChannel } from '@/lib/updater';
import { Sidebar } from '@/components/Sidebar';
import { TitleBar } from '@/components/TitleBar';
import { BackendUnreachable } from '@/components/BackendUnreachable';
import { PanelDialog } from '@/components/PanelDialog';
import { ProfilePanel } from '@/components/ProfilePanel';
import { NotificationCenter } from '@/components/NotificationCenter';
import { CloseBehaviorDialog } from '@/components/CloseBehaviorDialog';
import { AvatarMenu } from '@/components/AvatarMenu';
import { CommandPalette } from '@/components/CommandPalette';
import { ContextMenu } from '@/components/ContextMenu';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

import { PermissionConsentDialog } from '@/components/PermissionConsentDialog';
import { SchedulerAgentRunner } from '@/components/SchedulerAgentRunner';
import { SchedulerNotifier } from '@/components/SchedulerNotifier';
import { isStandalonePluginWindow, standalonePluginId } from '@/lib/plugin-window';
import { Auth } from '@/pages/Auth';
import { Onboarding } from '@/pages/Onboarding';
import { SetupWizard } from '@/pages/SetupWizard';
import { Home } from '@/pages/Home';
import { ListSkeleton, PageTransition } from '@/lib/motion';
import type { PluginCenterTab } from '@/pages/plugins/PluginCenterBody';
import { checkRuntimeAccess, requiresRegistryRuntimeAccess } from '@/lib/plugin-runtime-access';
import {
  discardPendingPluginUpdate,
  INSTALLATIONS_CHANGED_EVENT,
  listInstallations,
  loadInstalledPlugin,
  previewPendingInstalledPlugin,
} from '@/lib/plugin-registry';

const PluginCenterBody = lazy(() => import('@/pages/plugins/PluginCenterBody').then((m) => ({ default: m.PluginCenterBody })));
const PluginRunner = lazy(() => import('@/pages/plugins/PluginRunner').then((m) => ({ default: m.PluginRunner })));
const Review = lazy(() => import('./pages/Review').then((m) => ({ default: m.Review })));
const TeamAdmin = lazy(() => import('./pages/TeamAdmin').then((m) => ({ default: m.TeamAdmin })));
const HelpFeedback = lazy(() => import('./pages/HelpFeedback').then((m) => ({ default: m.HelpFeedback })));
// 项 14：AccountDialog 已删，其承载的功能改为各自由 PanelDialog 包裹的独立悬浮窗，
// 在 App 顶层懒加载挂载（与原 AccountDialog 内的懒加载同款）。
// 06-24 计费钱包重构：原「钱包」(Wallet) + 「团队空间」(TeamHome) 两页合并为「团队钱包」(TeamWallet)。
const TeamWallet = lazy(() => import('@/pages/TeamWallet').then((m) => ({ default: m.TeamWallet })));
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })));
const CreatorWorkspace = lazy(() => import('@/components/creator/CreatorWorkspace').then((m) => ({ default: m.CreatorWorkspace })));
const DraftPlugins = lazy(() => import('@/pages/DraftPlugins').then((m) => ({ default: m.DraftPlugins })));
const Schedules = lazy(() => import('@/pages/Schedules').then((m) => ({ default: m.Schedules })));

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
  removeFromRecent: (id: string) => void;
  // 受控的 Settings 页 Tab（供新手任务清单「去设置 → 模型服务」等定向跳转）。
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  openAccountSettings: (tab?: AccountSettingsTab, settingsTab?: SettingsTab) => void;
  /** 项 1/14：打开通知中心悬浮窗（App 顶层独立挂载，不依赖 AvatarMenu 生命周期）。 */
  openNotifications: () => void;
  /** 项 5：打开团队管理居中悬浮窗。 */
  openTeamAdmin: () => void;
  /** 帮助与反馈：打开工单中心悬浮窗。 */
  openHelpFeedback: () => void;
  /** 打开主区插件工作台运行页（可选初始 tab：本地/团队/市场）。 */
  openPluginCenter: (tab?: PluginCenterTab) => void;
  // 模型配置刷新信号：设置页保存模型绑定后递增，对话页据此重新拉取生效模型，
  // 避免保存后必须重启应用才在模型选择器看到新模型（跨页面通信，无持久化必要）。
  modelConfigVersion: number;
  bumpModelConfig: () => void;
  // 一键修复跨页传递：插件启动/运行报错 → 设结构化载荷（提示词 + 出错插件）→ 跳创建器 →
  // 创建器读取并预填输入框 + 引用插件源码（不自动发送，用户点发送即修）。用完即清（null），无持久化必要。
  pendingAutoFix: PendingAutoFix | null;
  setPendingAutoFix: (fix: PendingAutoFix | null) => void;
  // 草稿编辑跨页传递（task 06-25 增强）：草稿列表点「编辑」→ 设草稿+对话历史 → 跳创建器 →
  // 创建器恢复对话轮次 + 引用草稿源码。用完即清（null）。
  pendingDraftEdit: PendingDraftEdit | null;
  setPendingDraftEdit: (edit: PendingDraftEdit | null) => void;
  // 云同步平台信息：platformName/logoUrl（GET /api/platform-info @Public），供侧栏 / 落地展示。
  // admin 改名后全端拉同一值；未配置时为默认 'LingFang' 与空 logoUrl（前端用图标 fallback）。
  platformName: string;
  platformLogoUrl: string;
  // Task 6/2：全局搜索悬浮窗开关。首页居中搜索框 / 侧栏搜索按钮 / Ctrl+K 共用此入口。
  openSearch: () => void;
  /** 打开左下角用户菜单 AvatarMenu（主侧栏 + 开发插件侧栏底部用户按钮共用）。 */
  openAvatarMenu: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}

const pinKey = (tenantId: string | null) => `lf:pins:${tenantId || 'none'}`;
function loadPins(tenantId: string | null): string[] {
  try {
    const raw = localStorage.getItem(pinKey(tenantId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map((item) => typeof item === 'string' ? item : item?.installationId || item?.id).filter((item): item is string => Boolean(item)) : [];
  } catch {
    return [];
  }
}
function savePins(tenantId: string | null, pins: LoadedPlugin[]) {
  try {
    localStorage.setItem(pinKey(tenantId), JSON.stringify(pins.map((plugin) => plugin.installationId).filter(Boolean)));
  } catch (err) {
    // DESK-SHELL-04 修复：配额满 / localStorage 被禁用时不再静默吞错，
    // 给用户可见提示（持久化失败会导致下次重启「固定插件丢失」，需提示）。
    reportPersistenceFailure(err);
  }
}

// 项 9：最近使用插件（与 pins 同构：租户隔离、置顶去重、限量 5）。运行插件时记入，侧栏分区展示。
const RECENT_MAX = 5;
const recentKey = (tenantId: string | null) => `lf:recent:${tenantId || 'none'}`;
const COMPACT_SIDEBAR_QUERY = '(max-width: 767px)';

function loadSidebarOpen(): boolean {
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.(COMPACT_SIDEBAR_QUERY).matches) return false;
    return localStorage.getItem('lf:sidebar-open') === '1';
  } catch {
    return false;
  }
}

function loadRecent(tenantId: string | null): string[] {
  try {
    const raw = localStorage.getItem(recentKey(tenantId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map((item) => typeof item === 'string' ? item : item?.installationId || item?.id).filter((item): item is string => Boolean(item)) : [];
  } catch {
    return [];
  }
}
function saveRecent(tenantId: string | null, recent: LoadedPlugin[]) {
  try {
    localStorage.setItem(recentKey(tenantId), JSON.stringify(recent.map((plugin) => plugin.installationId).filter(Boolean)));
  } catch (err) {
    reportPersistenceFailure(err);
  }
}

async function hydrateInstallationPreferences(ids: string[]): Promise<LoadedPlugin[]> {
  if (!ids.length) return [];
  try {
    const installed = new Set((await listInstallations()).map((item) => item.installationId));
    const loaded = await Promise.all(ids.filter((id) => installed.has(id)).map((id) => loadInstalledPlugin(id).catch(() => null)));
    return loaded.filter((plugin): plugin is LoadedPlugin => Boolean(plugin));
  } catch {
    return [];
  }
}

// 激活 Skill 集合已随创建器移除（systemPrompt 拼装是创建器专属）。

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
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(loadSidebarOpen);
  // Task 6 全局搜索悬浮窗：Ctrl/Cmd+K 或侧边栏搜索按钮唤起。
  const [searchOpen, setSearchOpen] = useState(false);
  const [creatorFloatingOpen, setCreatorFloatingOpen] = useState(false);
  // 项 14：AccountDialog 已拆为独立悬浮窗——每个功能各自一个 open state，由 openAccountSettings 路由分发。
  // 06-24：原 walletOpen + teamOpen 合并为单一 teamWalletOpen（团队钱包）。
  const [teamWalletOpen, setTeamWalletOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // 项 5：团队管理改为居中悬浮窗（原主区页面导航）。
  const [teamAdminOpen, setTeamAdminOpen] = useState(false);
  // 帮助与反馈：工单中心悬浮窗。
  const [helpFeedbackOpen, setHelpFeedbackOpen] = useState(false);
  const [pluginCenterTab, setPluginCenterTab] = useState<PluginCenterTab>('installed');
  const [creatorReturnView, setCreatorReturnView] = useState<'run-plugins' | 'draft-plugins'>('run-plugins');
  // 项 1：通知中心独立悬浮窗（不再嵌套在 AvatarMenu 内，修复点击即关闭/卡死 bug）。
  const [notifOpen, setNotifOpen] = useState(false);
  // 项 11：关窗询问悬浮窗（偏好为 'ask' 时弹出）。
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  // 本地定时任务（local-scheduler）：关窗对话框展示当前 ACTIVE 任务数。
  const [closeActiveSchedules, setCloseActiveSchedules] = useState(0);
  // 左下角用户按钮弹出的 AvatarMenu 开关（项 4：替代直接打开 AccountDialog）。
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [currentDraft, setCurrentDraft] = useState<PluginDraft | null>(null);
  const [runningPlugin, setRunningPluginState] = useState<LoadedPlugin | null>(null);
  const runningPluginRequestRef = useRef(0);
  const [pinnedPlugins, setPinnedPlugins] = useState<LoadedPlugin[]>([]);
  // 项 9：最近使用插件（与 pinnedPlugins 同构，按 tenantId 持久化隔离）。
  const [recentPlugins, setRecentPlugins] = useState<LoadedPlugin[]>([]);
  // 项 9：包装 setRunningPlugin —— 运行插件时记入「最近使用」（置顶、去重、限量 RECENT_MAX、按租户持久化）。
  // 保留 ctx 上 setRunningPlugin 原签名，所有现有调用方（Sidebar/Home/Plugins 等）自动走包装逻辑。
  const setRunningPlugin = useCallback((plugin: LoadedPlugin | null) => {
    const requestId = ++runningPluginRequestRef.current;
    if (!plugin) {
      setRunningPluginState(null);
      return;
    }
    const commit = (prepared: LoadedPlugin) => {
      if (runningPluginRequestRef.current !== requestId) return;
      setRunningPluginState(prepared);
      if (!prepared.installationId) return;
      setRecentPlugins((prev) => {
        const next = [prepared, ...prev.filter((item) => item.id !== prepared.id)].slice(0, RECENT_MAX);
        saveRecent(session.tenantId, next);
        return next;
      });
    };
    if (!plugin.installationId) {
      commit(plugin);
      return;
    }

    const isCurrent = () => runningPluginRequestRef.current === requestId;
    void (async () => {
      try {
        const installations = await listInstallations();
        if (!isCurrent()) return;
        const installation = installations.find((item) => item.installationId === plugin.installationId);
        if (!installation) throw new Error('本机安装项不存在或已卸载');

        if (requiresRegistryRuntimeAccess(installation.origin)) {
          const selectedRelease = installation.pendingRelease ?? installation.activeRelease;
          await checkRuntimeAccess(installation.packageId, selectedRelease);
          if (!isCurrent()) return;
        }

        if (!installation.pendingRelease) {
          commit(plugin);
          return;
        }

        let pending: LoadedPlugin;
        try {
          pending = await previewPendingInstalledPlugin(installation.installationId);
        } catch (caught) {
          if (!isCurrent()) return;
          const reason = errorMessage(caught, '待更新版本校验失败');
          await discardPendingPluginUpdate(installation.installationId, reason);
          if (!isCurrent()) return;
          toast.error(`${reason}，已恢复活动版本`);
          commit(await loadInstalledPlugin(installation.installationId));
          return;
        }
        if (!isCurrent()) return;

        // client/cloud 由 Runner 成功挂载后激活；Node/Python 由进程成功启动后激活。
        commit(pending);
      } catch (caught) {
        if (isCurrent()) toast.error(errorMessage(caught, '插件运行准备失败'));
      }
    })();
  }, [session.tenantId]);
  // 项 9：从「最近使用」中移除指定插件（侧栏历史区删除按钮用）。
  const removeFromRecent = useCallback((pluginId: string) => {
    setRecentPlugins((prev) => {
      const next = prev.filter((x) => x.id !== pluginId);
      saveRecent(session.tenantId, next);
      return next;
    });
  }, [session.tenantId]);
  // Settings 页受控 Tab：默认 'cli'。新手任务清单「去设置 → 模型服务」会把它改成 'gateway'。
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('cli');
  // 模型配置刷新信号已随创建器移除（relay 上线后无需前端 bumpModelConfig）。
  // 保留 no-op 存根维持 useApp 形状稳定，避免大面积类型改动。
  const modelConfigVersion = 0;
  const bumpModelConfig = useCallback(() => undefined, []);
  // 一键修复：插件启动/运行报错时设结构化载荷（提示词 + 出错插件），跳创建器后预填并引用源码给 AI 修。
  const [pendingAutoFix, setPendingAutoFix] = useState<PendingAutoFix | null>(null);
  // 草稿编辑（task 06-25 增强）：草稿列表点「编辑」设草稿+对话历史，跳创建器后恢复对话轮次。
  const [pendingDraftEdit, setPendingDraftEdit] = useState<PendingDraftEdit | null>(null);
  // 云同步平台信息：GET /api/platform-info（@Public），backendUrl 已配置时拉取。
  // platformName 缺省 'LingFang'，logoUrl 缺省空串。admin 改名后全端拉同一值（侧栏 header 同步）。
  const [platformName, setPlatformName] = useState('灵坊');
  const [platformLogoUrl, setPlatformLogoUrl] = useState('');
  // 组D 首次启动安装向导：backendUrl 已配置且无 token 时查 /api/setup/status，
  // needsSetup=true（DB 无 PLATFORM_ADMIN）则渲染 SetupWizard 替代 Auth。
  const [needsSetup, setNeedsSetup] = useState(false);

  // 项 14：路由到对应独立悬浮窗（保留原 openAccountSettings API，所有现有调用方零改动）。
  // 'account' → 个人资料、'team-wallet' → 团队钱包（余额+灵石）、'settings' → 设置（可用 nextSettingsTab 指定子 tab）。
  const openAccountSettings = useCallback((tab: AccountSettingsTab = 'account', nextSettingsTab?: SettingsTab) => {
    if (nextSettingsTab) setSettingsTab(nextSettingsTab);
    if (tab === 'team-wallet') setTeamWalletOpen(true);
    else if (tab === 'settings') setSettingsOpen(true);
    else setProfileOpen(true);
  }, []);
  // 项 1：打开通知中心独立悬浮窗（AvatarMenu / 任意组件通过 context 调用）。
  const openNotifications = useCallback(() => setNotifOpen(true), []);
  // 项 5：打开团队管理居中悬浮窗。
  const openTeamAdmin = useCallback(() => setTeamAdminOpen(true), []);
  // 帮助与反馈：打开工单中心悬浮窗。
  const openHelpFeedback = useCallback(() => setHelpFeedbackOpen(true), []);

  const closeFeaturePanels = useCallback(() => {
    setTeamWalletOpen(false);
    setSettingsOpen(false);
    setProfileOpen(false);
    setTeamAdminOpen(false);
    setNotifOpen(false);
  }, []);

  // 打开运行插件主界面（带可选初始 tab，承接原 market 直达语义）。
  const openPluginCenter = useCallback((tab?: PluginCenterTab) => {
    if (tab) setPluginCenterTab(tab);
    closeFeaturePanels();
    setRunningPlugin(null);
    setViewState('run-plugins');
  }, [closeFeaturePanels, setRunningPlugin]);

  const setView = useCallback((nextView: View) => {
    if (nextView === 'settings') {
      openAccountSettings('settings');
      return;
    }
    if (nextView === 'team-wallet') {
      openAccountSettings('team-wallet');
      return;
    }
    // 'creator' 是兼容入口：拦截后切到独立的开发插件主界面。
    // 承接 Home / CommandPalette / 新手任务清单 / 插件运行「继续修改」等所有 setView('creator') 调用。
    if (nextView === 'creator') {
      setCreatorReturnView(view === 'draft-plugins' ? 'draft-plugins' : 'run-plugins');
      closeFeaturePanels();
      setRunningPlugin(null);
      setViewState('develop-plugins');
      return;
    }
    if (nextView === 'develop-plugins') {
      setCreatorReturnView(view === 'draft-plugins' ? 'draft-plugins' : 'run-plugins');
    }
    // 跳到其它页面时关闭所有功能悬浮窗，避免浮窗残留在新页面上。
    closeFeaturePanels();
    setViewState(nextView);
  }, [closeFeaturePanels, openAccountSettings, setRunningPlugin, view]);

  const revokePluginBridgeSessions = useCallback(async () => {
    try {
      await tauriInvoke<void>('revoke_all_plugin_bridge_sessions');
    } catch {
      // Web 预览或旧壳没有该命令时继续清理本地会话；服务端 JWT version 仍是最终防线。
    }
  }, []);

  const saveBackendUrl = useCallback((url: string) => {
    const resetForBackendChange = (nextUrl: string | null) => {
      if (nextUrl) configureApiBase(nextUrl, { persist: true });
      else clearApiBase();
      setBackendUrl(nextUrl);
      setAuthToken(null);
      clearStoredSession();
      sessionRef.current = emptySession;
      setSession(emptySession);
      setBackendUnreachable(false);
      setView('home');
    };
    if (!url.trim()) {
      if (sessionRef.current.token) void revokePluginBridgeSessions().finally(() => resetForBackendChange(null));
      else resetForBackendChange(null);
      return true;
    }
    const normalized = normalizeBackendUrl(url);
    if (!normalized) return false;
    if (sessionRef.current.token) void revokePluginBridgeSessions().finally(() => resetForBackendChange(normalized));
    else resetForBackendChange(normalized);
    return true;
  }, [revokePluginBridgeSessions, setView]);

  // DESK-SHELL-03 修复：applySession / applyCollabSession 不再把 setAuthToken / saveStoredSession /
  // setView 等副作用放进 setSession updater（React 要求 updater 纯函数；StrictMode dev 下双调
  // 与并发渲染可能丢弃该次更新，副作用已落盘但内存 session 未变更，造成状态不一致）。
  // 改为先在函数体内顺序执行副作用，再调纯 setSession 拼接 next 状态。
  // 用 ref 跟踪最新 session，使 updater 之外也能读到 prev（避免闭包陈旧）。
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  const applySession = useCallback((patch: Partial<Session>) => {
    const previous = sessionRef.current;
    const next = { ...previous, ...patch };
    const commit = () => {
      setAuthToken(next.token);
      saveStoredSession(next);
      sessionRef.current = next;
      setSession(next);
    };
    const teamContextChanged = Boolean(previous.token)
      && (next.token !== previous.token || next.tenantId !== previous.tenantId);
    if (teamContextChanged) void revokePluginBridgeSessions().finally(commit);
    else commit();
  }, [revokePluginBridgeSessions]);

  const applyCollabSession = useCallback((payload: CollabSessionResponse) => {
    const previous = sessionRef.current;
    const next = sessionFromPayload(payload, previous.token);
    const commit = () => {
      setAuthToken(next.token);
      saveStoredSession(next);
      sessionRef.current = next;
      setView('home');
      setSession(next);
    };
    const teamContextChanged = Boolean(previous.token)
      && (next.token !== previous.token || next.tenantId !== previous.tenantId);
    if (teamContextChanged) void revokePluginBridgeSessions().finally(commit);
    else commit();
  }, [revokePluginBridgeSessions, setView]);

  const refreshSession = useCallback(async () => {
    const payload = await api<CollabSessionResponse>('/api/auth/me');
    applyCollabSession(payload);
  }, [applyCollabSession]);

  const resetSession = useCallback(() => {
    const commit = () => {
      setAuthToken(null);
      clearStoredSession();
      // DESK-SHELL-07 修复：登出时清空 currentDraft，避免同机下一登录用户短暂看到上一用户的草稿。
      // App 始终挂载（登出渲染 Auth 不卸载），useState 不会自动重置。
      setCurrentDraft(null);
      sessionRef.current = emptySession;
      setSession(emptySession);
      setRunningPlugin(null);
      setView('home');
    };
    if (sessionRef.current.token) void revokePluginBridgeSessions().finally(commit);
    else commit();
  }, [revokePluginBridgeSessions, setRunningPlugin, setView]);

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

  // R9 启动静默检查更新：登录后后台查一次 /api/releases/latest，有更新弹非阻塞 toast 引导去设置页更新。
  // 用 sessionStorage 标记「本次启动已检查」避免重复打扰（租户切换/重渲染不重复弹）。
  // 失败静默（网络/无更新均不打扰），仅 Tauri 桌面环境执行（checkUpdate 走 Tauri 命令）。
  useEffect(() => {
    if (!backendUrl || !session.token) return;
    const isTauri = Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (!isTauri) return;
    const FLAG = 'lf:update-checked-this-launch';
    if (sessionStorage.getItem(FLAG)) return;
    sessionStorage.setItem(FLAG, '1');

    let cancelled = false;
    const channel = loadUpdateChannel();
    checkUpdate(backendUrl, channel)
      .then((meta) => {
        if (cancelled || !meta) return;
        void import('sonner').then(({ toast }) => {
          toast.info(`发现${channel === 'BETA' ? ' beta' : ''}新版本 ${meta.version}`, {
            description: `前往设置 → 检查${channel === 'BETA' ? ' beta' : '正式版'}更新可立即升级。`,
            action: { label: '去更新', onClick: () => openAccountSettings('settings', 'backend') },
            duration: 8000,
          });
        });
      })
      .catch(() => {
        /* 静默：网络失败 / 无更新均不打扰用户 */
      });
    return () => {
      cancelled = true;
    };
  }, [backendUrl, session.token, openAccountSettings]);

  useEffect(() => {
    let cancelled = false;
    const pinIds = loadPins(session.tenantId);
    void hydrateInstallationPreferences(pinIds).then((plugins) => {
      if (cancelled) return;
      setPinnedPlugins(plugins);
      savePins(session.tenantId, plugins);
    });
    return () => { cancelled = true; };
  }, [session.tenantId]);

  useEffect(() => {
    const refreshPreferences = () => {
      void hydrateInstallationPreferences(loadPins(session.tenantId)).then((plugins) => {
        setPinnedPlugins(plugins);
        savePins(session.tenantId, plugins);
      });
      void hydrateInstallationPreferences(loadRecent(session.tenantId)).then((plugins) => {
        const next = plugins.slice(0, RECENT_MAX);
        setRecentPlugins(next);
        saveRecent(session.tenantId, next);
      });
    };
    window.addEventListener(INSTALLATIONS_CHANGED_EVENT, refreshPreferences);
    return () => window.removeEventListener(INSTALLATIONS_CHANGED_EVENT, refreshPreferences);
  }, [session.tenantId]);

  // 项 9：租户切换 / 登录态变化时重载「最近使用」插件列表。
  useEffect(() => {
    let cancelled = false;
    const recentIds = loadRecent(session.tenantId);
    void hydrateInstallationPreferences(recentIds).then((plugins) => {
      if (cancelled) return;
      setRecentPlugins(plugins.slice(0, RECENT_MAX));
      saveRecent(session.tenantId, plugins.slice(0, RECENT_MAX));
    });
    return () => { cancelled = true; };
  }, [session.tenantId]);

  // 小视口进入时自动收起一次，保留标题栏按钮供用户按需重新展开。
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia(COMPACT_SIDEBAR_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) setSidebarOpen(false);
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  // 侧栏开合持久化：用户切换后写盘，跨重启保留；小视口默认折叠。
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
        const installations = await listInstallations();
        if (cancelled) return;
        const installation = installations.find((item) => item.installationId === targetId);
        const target = installation ? await loadInstalledPlugin(installation.installationId) : null;
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

  const pinPlugin = useCallback((p: LoadedPlugin) => {
    if (!p.installationId) return;
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
        // 拉一次 ACTIVE 定时任务数，传给 CloseBehaviorDialog 展示告警。
        import('@/lib/local-scheduler')
          .then(({ schedulerActiveCount }) => schedulerActiveCount())
          .then((n) => setCloseActiveSchedules(n))
          .catch(() => setCloseActiveSchedules(0))
          .finally(() => setClosePromptOpen(true));
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
    pinnedPlugins, recentPlugins, pinPlugin, unpinPlugin, isPinned, removeFromRecent,
    settingsTab, setSettingsTab,
    openAccountSettings, openNotifications, openTeamAdmin, openPluginCenter, openHelpFeedback,
    modelConfigVersion, bumpModelConfig,
    pendingAutoFix, setPendingAutoFix,
    pendingDraftEdit, setPendingDraftEdit,
    platformName, platformLogoUrl,
    openSearch,
    openAvatarMenu: () => setAvatarMenuOpen(true),
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
        {/* 关窗询问悬浮窗：登录前的居中态也需渲染，否则关闭按钮 prevent_close 后无对话框、应用关不掉。 */}
        <CloseBehaviorDialog open={closePromptOpen} onChoose={handleCloseChoice} activeSchedules={closeActiveSchedules} />
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
    return <AppContext.Provider value={ctx}><Centered chrome label={platformName}>{authBody}</Centered><CloseBehaviorDialog open={closePromptOpen} onChoose={handleCloseChoice} /><Toaster position="top-right" richColors closeButton /></AppContext.Provider>;
  }

  if (session.onboarding && !['TEAM_SPACE', 'TEAM_ADMIN_SPACE'].includes(session.onboarding)) {
    return <AppContext.Provider value={ctx}><Centered chrome label={platformName}><Onboarding /></Centered><CloseBehaviorDialog open={closePromptOpen} onChoose={handleCloseChoice} /><Toaster position="top-right" richColors closeButton /></AppContext.Provider>;
  }

  let body: ReactNode;
  if (view === 'home') body = <Home />;
  else if (view === 'review') body = session.isPlatformAdmin ? <Review /> : <Home />;
  else if (view === 'team-admin') body = <TeamAdmin />;
  else if (view === 'draft-plugins') body = <DraftPlugins />;
  else if (view === 'schedules') body = <Schedules />;
  else body = null;
  // 开发插件页隐藏外层 Sidebar；创建器会话侧栏维护自己的折叠偏好与切换入口。
  const showAppSidebar = view !== 'develop-plugins';
  const showAppSidebarToggle = view !== 'develop-plugins';

  return (
    <AppContext.Provider value={ctx}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <ContextMenu />
        {/* 紧凑自定义标题栏：侧边栏折叠按钮 + 应用名 + 窗口控制。 */}
        <TitleBar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={showAppSidebarToggle ? () => setSidebarOpen((v) => !v) : undefined}
        />
        <div className="flex min-h-0 flex-1">
          {showAppSidebar && (
            <Sidebar
              collapsed={!sidebarOpen}
              onOpenSearch={() => setSearchOpen(true)}
              onOpenAvatarMenu={() => setAvatarMenuOpen(true)}
            />
          )}
          <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {backendUnreachable ? (
              // R6 后端不可达：替换业务页为友好页（保留 TitleBar/Sidebar，用户仍可拖窗）。
              // 「重试」探测成功后派发 reachable 退出此态。
              <BackendUnreachable />
            ) : (
              <>
                {/* 主体业务页：插件工作台在主区渲染，运行插件仍全屏接管主体区。 */}
                {runningPlugin ? (
                  // 插件运行从 view 解耦——只要 runningPlugin 存在就全屏铺满运行，与任何 view 无关。
                  // 返回（onBack）：清运行态 + 回到插件工作台运行页（保持「返回插件列表」语义）。
                  // 全屏（无 padding/max-w/边框），iframe 撑满整个主体区。
                  <div className="min-h-0 flex-1">
                    <Suspense fallback={null}>
                      <PluginRunner
                        plugin={runningPlugin}
                        onBack={() => {
                          setRunningPlugin(null);
                          setViewState('run-plugins');
                        }}
                      />
                    </Suspense>
                  </div>
                ) : (
                  // 组D：主体区 flex-col 布局——内容区 flex-1 独占滚动空间（overflow-y-auto），
                  // Footer 作为 shrink-0 固定在视口底部（不随主内容滚动，不被顶下去，无需滚到底才可见）。
                  // 主内容滚不动 Footer；Footer 与侧边栏协调（侧边栏亦固定，二者一致）。
                  // Suspense 兜底懒加载 chunk（首次进入该 view 时），ListSkeleton 作占位；
                  // PageTransition 按 viewKey 切换做淡入/位移转场（尊重 useReducedMotion）。
                  <>
                    {view === 'run-plugins' || view === 'develop-plugins' ? (
                      <div className="min-h-0 flex-1 overflow-hidden">
                        <Suspense fallback={<ListSkeleton rows={6} />}>
                          <PageTransition viewKey={view} className="flex h-full min-h-0 flex-col">
                            {view === 'run-plugins' ? (
                              <PluginCenterBody
                                tab={pluginCenterTab}
                                onTabChange={setPluginCenterTab}
                                onRun={setRunningPlugin}
                                onCreate={() => setViewState('develop-plugins')}
                                onClose={() => undefined}
                              />
                            ) : (
                              <CreatorWorkspace onClose={() => { setViewState(creatorReturnView); setCreatorReturnView('run-plugins'); }} />
                            )}
                          </PageTransition>
                        </Suspense>
                      </div>
                    ) : (
                      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                        <div className="mx-auto w-full max-w-6xl">
                          <Suspense fallback={<ListSkeleton rows={6} />}>
                            <PageTransition viewKey={view}>{body}</PageTransition>
                          </Suspense>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </main>
        </div>
      </div>
      {/* 项 14：各功能独立悬浮窗（替代已删的 AccountDialog 聚合体）。每个由 AvatarMenu 对应按钮
          经 openAccountSettings 路由打开；TeamWallet/Settings 懒加载，Suspense 兜底首次加载。
          06-24：原「钱包」+「团队空间」两窗合并为「团队钱包」（同页展示团队余额 + 团队灵石两类账户）。 */}
      <PanelDialog open={teamWalletOpen} onOpenChange={setTeamWalletOpen} title="团队钱包" description="团队共享余额（插件市场）与灵石（AI 计费）" size="md">
        <Suspense fallback={<ListSkeleton rows={6} />}><TeamWallet /></Suspense>
      </PanelDialog>
      <PanelDialog open={settingsOpen} onOpenChange={setSettingsOpen} title="设置" description="通用 / 脚本运行环境 / 模型与计费 / 插件 / 更新 / 关于">
        <Suspense fallback={<ListSkeleton rows={6} />}><Settings value={settingsTab} onValueChange={(v) => setSettingsTab(v as SettingsTab)} /></Suspense>
      </PanelDialog>
      <PanelDialog open={profileOpen} onOpenChange={setProfileOpen} title="个人资料" size="auto">
        <ProfilePanel session={session} applySession={applySession} resetSession={resetSession} onClose={() => setProfileOpen(false)} />
      </PanelDialog>
      {/* 项 5：团队管理居中悬浮窗（TeamAdmin 页，仅团队管理员；权限门控在 AvatarMenu 入口）。 */}
      <PanelDialog open={teamAdminOpen} onOpenChange={setTeamAdminOpen} title="团队管理" size="lg">
        <Suspense fallback={<ListSkeleton rows={6} />}><TeamAdmin /></Suspense>
      </PanelDialog>
      {/* 帮助与反馈：工单中心悬浮窗（提交/查询/对话，入口在 AvatarMenu）。 */}
      <PanelDialog open={helpFeedbackOpen} onOpenChange={setHelpFeedbackOpen} title="帮助与反馈" size="md">
        <Suspense fallback={<ListSkeleton rows={4} />}><HelpFeedback /></Suspense>
      </PanelDialog>
      {/* 项 1：通知中心独立悬浮窗（Sheet portal，生命周期与 AvatarMenu 解耦，修复点击即关/卡死 bug）。 */}
      <NotificationCenter open={notifOpen} onOpenChange={setNotifOpen} />
      {/* 项 11：关窗询问悬浮窗（偏好 'ask' 时弹；tray/quit/cancel 三选项）。 */}
      <CloseBehaviorDialog open={closePromptOpen} onChoose={handleCloseChoice} activeSchedules={closeActiveSchedules} />
      {/* 项 4：左下角用户按钮弹出的 AvatarMenu（v4 形态，适配当前 RBAC/View）。 */}
      <AvatarMenu open={avatarMenuOpen} onClose={() => setAvatarMenuOpen(false)} collapsed={!sidebarOpen} />
      {/* Task 6 全局搜索悬浮窗：Ctrl/Cmd+K 唤起，背景模糊居中浮层。 */}
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      {view !== 'develop-plugins' && !creatorFloatingOpen && (
        <Button
          type="button"
          size="icon"
          className="fixed bottom-6 right-6 z-40 size-12 rounded-xl shadow-lg"
          onClick={() => setCreatorFloatingOpen(true)}
          title="打开 AI 插件创建器"
          aria-label="打开 AI 插件创建器"
        >
          <SparklesIcon className="size-5" />
        </Button>
      )}
      <Dialog open={creatorFloatingOpen} onOpenChange={setCreatorFloatingOpen}>
        <DialogContent showCloseButton={false} className="flex h-[88vh] max-h-[88vh] w-[94vw] max-w-[1500px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1500px]">
          <DialogTitle className="sr-only">AI 创建插件</DialogTitle>
          <DialogDescription className="sr-only">通过 AI 对话创建、编辑并发布插件</DialogDescription>
          <Suspense fallback={<ListSkeleton rows={8} />}>
            <CreatorWorkspace onClose={() => setCreatorFloatingOpen(false)} />
          </Suspense>
        </DialogContent>
      </Dialog>
      {/* Task 14 系统级权限运行时确认框（监听 lf:permission-request 事件）。 */}
      <PermissionConsentDialog />
      {/* 本地定时任务（local-scheduler）：常驻隐藏 Agent 执行器（监听 scheduler:trigger / cancel）。 */}
      <SchedulerAgentRunner />
      {/* 本地定时任务通知分发：监听 scheduler:notify → toast + 系统通知（尊重勿扰时段）。 */}
      <SchedulerNotifier />
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
