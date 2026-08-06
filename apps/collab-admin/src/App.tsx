import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { toast } from 'sonner';
import {
  CheckCircleIcon,
  InfoIcon,
  LogOutIcon,
  MenuIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Sidebar, type SidebarNavGroup, type SidebarSlotContext } from '@/components/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CommandPalette, useCommandPalette } from '@/components/command-palette';
import { Landing } from '@/components/landing/Landing';
import { LoginPage } from '@/components/landing/LoginPage';
import { DownloadPage } from '@/components/landing/DownloadPage';
import { ChangelogPage } from '@/components/landing/ChangelogPage';
import { SetupWizard } from '@/components/setup-wizard';
// 组D 加载优化：登录后各后台 View 按需懒加载，首屏（落地页/登录页）不进 bundle。
// 落地页四件套（Landing/LoginPage/DownloadPage/ChangelogPage）保持静态 import——
// 它们走未登录快速路径，且 Landing 是首屏，懒加载反而增加首次可交互延迟。
import { OnboardingWizard, ONBOARDING_DONE_KEY } from '@/components/onboarding-wizard';
import type { GovernanceIntent } from '@/components/governance/types';
import { NAV_GROUPS, VIEW_LABEL, VIEW_GROUP } from '@/lib/navigation';
import { api, isPlatformAdminSession, UNAUTHORIZED_EVENT, type AdminSession } from '@/lib/api';
import { initTheme } from '@/lib/theme';
import type { View } from '@/lib/types';
import { PageTransition, ListSkeleton } from '@/lib/motion';
import { getLatestRelease } from '@/lib/releases';
import pkg from '../package.json';

const Dashboard = lazy(() => import('@/components/dashboard').then((m) => ({ default: m.Dashboard })));
const UsersView = lazy(() => import('@/components/users-view').then((m) => ({ default: m.UsersView })));
const TeamsView = lazy(() => import('@/components/teams-view').then((m) => ({ default: m.TeamsView })));
const GovernanceView = lazy(() => import('@/components/governance-view').then((m) => ({ default: m.GovernanceView })));
const MarketplaceCommerceView = lazy(() => import('@/components/marketplace-commerce-view').then((m) => ({ default: m.MarketplaceCommerceView })));
const AdminsView = lazy(() => import('@/components/admins-view').then((m) => ({ default: m.AdminsView })));
const AuditView = lazy(() => import('@/components/audit-view').then((m) => ({ default: m.AuditView })));
const SettingsView = lazy(() => import('@/components/settings-view').then((m) => ({ default: m.SettingsView })));
const ReleasesView = lazy(() => import('@/components/releases-view').then((m) => ({ default: m.ReleasesView })));
const TicketsView = lazy(() => import('@/components/tickets-view').then((m) => ({ default: m.TicketsView })));
const RolesView = lazy(() => import('@/components/roles-view').then((m) => ({ default: m.RolesView })));
// 计费与模型（资源池模型重构后）：资源池/渠道/计费/灵石/调用日志。
const PoolsView = lazy(() => import('@/components/billing/pools-view').then((m) => ({ default: m.PoolsView })));
const ChannelsView = lazy(() => import('@/components/billing/channels-view').then((m) => ({ default: m.ChannelsView })));
const BillingView = lazy(() => import('@/components/billing/billing-view').then((m) => ({ default: m.BillingView })));
const CreditsView = lazy(() => import('@/components/billing/credits-view').then((m) => ({ default: m.CreditsView })));
const CallLogsView = lazy(() => import('@/components/billing/call-logs-view').then((m) => ({ default: m.CallLogsView })));
const RoadmapView = lazy(() => import('@/components/roadmap-view').then((m) => ({ default: m.RoadmapView })));

// 主题初始化：在模块加载时同步应用，避免首屏亮暗闪烁（FOUC）。
// 放在模块顶层执行一次，早于 React 渲染，读取 localStorage 的主题偏好并应用到 <html>。
initTheme();

// 分组导航配置（来自 @/lib/navigation 单一数据源）：核心管理 / 内容 / 系统。
// 侧栏、面包屑、命令面板统一引用，文案一处维护避免漂移。
const navGroups: SidebarNavGroup[] = NAV_GROUPS;

export default function App() {
  const [session, setSession] = useState<AdminSession | null>(null);
  // 加载即尝试基于 Cookie 恢复会话（HttpOnly Cookie 由浏览器自动携带），无需读取本地令牌。
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>('dashboard');
  const [governanceIntent, setGovernanceIntent] = useState<GovernanceIntent>({ tab: 'plugins', nonce: 0 });
  // 未登录态的落地页视图：首页 / 登录页 / 下载页 / 更新日志页（各自独立全屏页，状态机 AJAX 切换，无路由库）。
  const [landingView, setLandingView] = useState<'home' | 'login' | 'download' | 'changelog'>('home');
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  // 首次登录引导向导：session 建立时若本机无完成标记则弹出。
  // 关闭（完成/跳过）后由 OnboardingWizard 写入 ONBOARDING_DONE_KEY，并向导自管 open 状态。
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // 组D 首次启动安装向导：needsSetup=true（DB 无 PLATFORM_ADMIN）时渲染 SetupWizard。
  // setupChecking=true 表示正在查 /api/setup/status；needsSetup 由后端返回决定是否拦截进向导。
  const [setupChecking, setSetupChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  // 安装向导创建的管理员邮箱：完成后传给 LoginPage 预填，便于用户直接登录刚创建的账号。
  const [setupEmail, setSetupEmail] = useState('');
  // 组C：Cmd+K / Ctrl+K 快捷搜索面板。hook 内部挂全局快捷键，返回 open 态。
  const commandPalette = useCommandPalette();

  // 云同步平台信息：GET /api/platform-info（@Public），取 platformName/logoUrl 显示在侧栏 header。
  // 与桌面端 / 官网落地页共用同一公开端点，admin 改名/Logo 后全端拉到同一值。
  // 仅 session 建立后拉取（admin 主界面才需要），失败静默回退默认 'LingFang'。
  const [platformName, setPlatformName] = useState('LingFang');
  const [platformLogoUrl, setPlatformLogoUrl] = useState('');
  useEffect(() => {
    let cancelled = false;
    api<{ platformName?: string; logoUrl?: string }>('/api/platform-info', { auth: false })
      .then((info) => {
        if (cancelled) return;
        if (info.platformName) setPlatformName(info.platformName.trim());
        if (info.logoUrl) setPlatformLogoUrl(info.logoUrl.trim());
      })
      .catch(() => {
        /* 拉取失败不阻断主界面，保持默认 'LingFang' 标题 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // 加载即尝试恢复会话（Cookie 认证）；未登录（401）属正常空态，不提示。
    api<AdminSession>('/api/auth/me')
      .then((next) => {
        if (!isPlatformAdminSession(next)) throw new Error('当前账号不是平台管理员');
        setSession(next);
        // 首登判定：本机无完成标记 → 弹出引导向导。
        // 标记按设备维度持久（localStorage），换浏览器或清缓存会重新引导，符合「首次登录」语义。
        if (!localStorage.getItem(ONBOARDING_DONE_KEY)) setOnboardingOpen(true);
      })
      .catch((e) => {
        // ADMIN-01：401 已由 api() 的 UNAUTHORIZED 事件路径处理（refresh 失败后派发事件 + handler 已 toast），
        // 此处仅对非 401 错误（如网络异常、非管理员）toast，避免重复弹两条相同提示。
        const status = (e as { status?: number }).status;
        if (status !== 401) toast.error((e as Error).message);
      })
      .finally(() => setChecking(false));
  }, []);

  // 组D 首次启动安装向导：启动时查 /api/setup/status（@Public），needsSetup=true 则拦截进向导。
  // 与 token 检查解耦：即使无 token 也独立判定平台是否已初始化（向导发生在登录之前）。
  // status 端点查询失败（后端未启动 / 网络异常）不阻断流程：保守视为无需向导，进入正常登录。
  useEffect(() => {
    api<{ needsSetup: boolean }>('/api/setup/status', { auth: false })
      .then((res) => setNeedsSetup(!!res.needsSetup))
      .catch(() => {
        // 查询失败：保守不拦截，让用户走正常登录（后端未就绪时登录也会报错，但不在向导卡死）。
        setNeedsSetup(false);
      })
      .finally(() => setSetupChecking(false));
  }, []);

  // 安装向导完成：关闭向导 + 转登录页并预填邮箱。
  function handleSetupDone(prefillEmail: string) {
    setSetupEmail(prefillEmail);
    setNeedsSetup(false);
    setLandingView('login');
  }

  // ADMIN-01 修复：监听 api() 派发的 401 全局事件，清 session 回登录页。
  // 此前 token 过期后任意 /api/admin/* 请求仅弹 toast，session 不清空，用户卡死在已登录外壳。
  // 现由 api() 在 refresh 失败/已过期时派发 UNAUTHORIZED_EVENT，App.tsx 监听并 resetSession。
  useEffect(() => {
    const handler = () => {
      setSession(null);
      toast.error('登录已过期，重新登录');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
  }, []);

  function handleLogout() {
    setSession(null);
  }

  // 仅用稳定 setter，无闭包读值 → useCallback 空依赖，供 memo 化的 Sidebar 保持引用稳定。
  const navigate = useCallback((nextView: View, intent?: Omit<GovernanceIntent, 'nonce'>) => {
    if (nextView === 'governance') {
      setGovernanceIntent((current) => ({
        tab: intent?.tab ?? 'plugins',
        reviewStatus: intent?.reviewStatus,
        applicationStatus: intent?.applicationStatus,
        nonce: current.nonce + 1,
      }));
    }
    setView(nextView);
  }, []);

  async function checkUpdate() {
    setCheckingUpdate(true);
    setUpdateResult(null);
    try {
      const currentVersion = pkg.version || '0.0.0';
      // 透传 currentVersion 给后端，由 release.service.isNewer 做 semver 比较（主.次.修 + prerelease），
      // 避免前端用精确字符串比较 release.version === currentVersion 误判（v 前缀/尾零等格式差异导致永远误报）。
      const release = await getLatestRelease('STABLE', currentVersion);
      if (!release) {
        setUpdateResult('error');
        return;
      }
      // 优先用后端权威的 updateAvailable（undefined 时降级为「非最新」语义，保守提示有更新可下载）。
      if (release.updateAvailable === false) {
        setUpdateResult('current');
      } else {
        setUpdateResult(`new:${release.version}`);
      }
    } catch {
      setUpdateResult('error');
    } finally {
      setCheckingUpdate(false);
    }
  }

  if (checking || setupChecking) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
        检查中…
      </div>
    );
  }

  // 组D 首次启动安装向导：needsSetup=true（DB 无 PLATFORM_ADMIN）时拦截渲染向导，
  // 优先级高于登录页 / 落地页——平台未初始化时不应让用户尝试登录（必然失败）。
  if (needsSetup) {
    return <SetupWizard onDone={handleSetupDone} />;
  }

  if (!session) {
    // 未登录：按 landingView 在首页 / 登录页 / 下载页 / 更新日志页之间切换（各自独立全屏页，AJAX 无刷新）。
    // PageTransition 提供淡入淡出 + 轻微位移的切页动画。
    return (
      <PageTransition viewKey={landingView}>
        {landingView === 'login' && (
          <LoginPage initialEmail={setupEmail} onAuthed={setSession} onBack={() => setLandingView('home')} />
        )}
        {landingView === 'download' && <DownloadPage onBack={() => setLandingView('home')} />}
        {landingView === 'changelog' && <ChangelogPage onBack={() => setLandingView('home')} />}
        {landingView === 'home' && (
          <Landing
            onLogin={() => setLandingView('login')}
            onNavigateDownload={() => setLandingView('download')}
            onNavigateChangelog={() => setLandingView('changelog')}
          />
        )}
      </PageTransition>
    );
  }

  const currentLabel = VIEW_LABEL[view];
  const currentGroup = VIEW_GROUP[view];

  // header/footer 是函数槽 props，memo 化 Sidebar 需要它们引用稳定；
  // 用 useMemo 包裹后，App 外壳其它状态（对话框开合等）变化时侧栏不再重建。
  const sidebarHeader = useMemo(() => ({ compact }: SidebarSlotContext) => (
    <div className={compact ? 'flex justify-center py-1' : 'flex items-center gap-3 px-2 py-1'}>
      <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary text-primary-foreground">
          {/* logoUrl 有值显示图片，无值 fallback ShieldCheckIcon 默认图标。 */}
          {platformLogoUrl ? (
            <img
              src={platformLogoUrl}
              alt={platformName}
              className="size-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <ShieldCheckIcon className="size-4" />
          )}
      </div>
      {!compact && (
        <div className="min-w-0">
          {/* 云同步平台名：展示后端 platformName（admin 可在「设置 → 平台信息」改名）。 */}
          <div className="truncate text-sm font-semibold">{platformName}</div>
          <div className="text-xs text-muted-foreground">Platform Admin</div>
        </div>
      )}
    </div>
  ), [platformLogoUrl, platformName]);

  const sidebarFooter = useMemo(() => ({ compact }: SidebarSlotContext) => (
    <div className="space-y-1 border-t pt-2">
      {!compact && (
        <div className="truncate px-3 py-1 text-xs text-muted-foreground" title={session.user.email}>
          {session.user.email}
        </div>
      )}
      <button
        type="button"
        aria-label="退出登录"
        title={compact ? '退出登录' : undefined}
        onClick={() => setLogoutOpen(true)}
        className={`flex w-full items-center rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-destructive ${compact ? 'justify-center' : 'gap-3'}`}
      >
        <LogOutIcon className="size-4" />
        {!compact && '退出登录'}
      </button>
      <button
        type="button"
        aria-label="关于"
        title={compact ? '关于' : undefined}
        onClick={() => setAboutOpen(true)}
        className={`flex w-full items-center rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${compact ? 'justify-center' : 'gap-3'}`}
      >
        <InfoIcon className="size-4" />
        {!compact && '关于'}
      </button>
    </div>
  ), [session.user.email]);

  return (
    <TooltipProvider>
      <div className="flex h-dvh overflow-hidden bg-background">
        <Sidebar
          groups={navGroups}
          activeView={view}
          onSelect={navigate}
          header={sidebarHeader}
          footer={sidebarFooter}
          mobileOpen={mobileNavOpen}
          onMobileOpenChange={setMobileNavOpen}
          mobileTriggerRef={mobileNavTriggerRef}
          showMobileTrigger={false}
        />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b bg-background px-4 sm:px-5 lg:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                ref={mobileNavTriggerRef}
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 lg:hidden"
                aria-label="打开导航菜单"
                aria-expanded={mobileNavOpen}
                onClick={() => setMobileNavOpen(true)}
              >
                <MenuIcon className="size-4" />
              </Button>
              <div className="min-w-0">
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem>
                      <BreadcrumbLink className="cursor-pointer" onClick={() => navigate('dashboard')}>
                        {currentGroup}
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{currentLabel}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
                <h1 className="truncate text-lg font-semibold text-foreground sm:text-xl">{currentLabel}</h1>
              </div>
            </div>
            <button
              type="button"
              aria-label="打开快捷搜索"
              onClick={() => commandPalette.setOpen(true)}
              className="flex h-9 shrink-0 items-center gap-2 rounded-lg border bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:px-3"
            >
              <SearchIcon className="size-4" />
              <span className="hidden sm:inline">快捷搜索</span>
              <kbd className="hidden rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] md:inline">⌘K</kbd>
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <div className="mx-auto w-full max-w-[1600px] p-4 sm:p-5 lg:p-6">
              <PageTransition viewKey={view}>
                <Suspense fallback={<ListSkeleton rows={6} />}>
                  {view === 'dashboard' && <Dashboard onNavigate={navigate} />}
                  {view === 'users' && <UsersView />}
                  {view === 'platformAdmins' && <AdminsView />}
                  {view === 'teams' && <TeamsView />}
                  {view === 'governance' && <GovernanceView key={governanceIntent.nonce} intent={governanceIntent} />}
                  {view === 'marketplaceCommerce' && <MarketplaceCommerceView />}
                  {view === 'tickets' && <TicketsView />}
                  {view === 'audit' && <AuditView />}
                  {view === 'releases' && <ReleasesView />}
                  {view === 'roles' && <RolesView />}
                  {view === 'pools' && <PoolsView />}
                  {view === 'channels' && <ChannelsView />}
                  {view === 'billing' && <BillingView />}
                  {view === 'credits' && <CreditsView />}
                  {view === 'callLogs' && <CallLogsView />}
                  {view === 'settings' && <SettingsView />}
                  {view === 'roadmap' && <RoadmapView />}
                </Suspense>
              </PageTransition>
            </div>
          </div>
        </main>
      </div>

      {/* Logout confirm dialog */}
      <Dialog open={logoutOpen} onOpenChange={setLogoutOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>退出登录</DialogTitle>
            <DialogDescription>确认退出当前平台管理员账号？</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogoutOpen(false)}>取消</Button>
            <Button variant="destructive" onClick={handleLogout}>
              <LogOutIcon className="mr-1 size-4" />
              确认退出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* About dialog */}
      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheckIcon className="size-5 text-primary" />
              LingFang 协作平台
            </DialogTitle>
            <DialogDescription>平台管理端</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-1 rounded-lg border bg-muted/20 p-3 text-sm">
              <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
                <span className="text-muted-foreground">版本</span>
                <span className="font-mono text-xs text-foreground">v{pkg.version || '0.0.0'}</span>
              </div>
              <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
                <span className="text-muted-foreground">账号</span>
                <span className="text-foreground truncate">{session.user.email}</span>
              </div>
              <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
                <span className="text-muted-foreground">角色</span>
                <span className="text-foreground">平台管理员</span>
              </div>
              <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
                <span className="text-muted-foreground">技术栈</span>
                <span className="text-foreground">shadcn/ui + React + TS</span>
              </div>
            </div>

            {/* Check update */}
            <Button
              variant="outline"
              className="w-full"
              disabled={checkingUpdate}
              onClick={checkUpdate}
            >
              <RefreshCwIcon className={checkingUpdate ? 'mr-1.5 size-4 animate-spin' : 'mr-1.5 size-4'} />
              {checkingUpdate ? '检查中…' : '检查更新'}
            </Button>

            {updateResult === 'current' && (
              <p className="flex items-center justify-center gap-1.5 text-xs text-emerald-600">
                <CheckCircleIcon className="size-3.5" />
                已是最新版本
              </p>
            )}
            {updateResult === 'error' && (
              <p className="text-center text-xs text-muted-foreground">
              无法连接服务器，检查网络后重试。
              </p>
            )}
            {updateResult?.startsWith('new:') && (
              <p className="text-center text-xs text-amber-600">
                发现新版本 v{updateResult.replace('new:', '')}，建议更新。
              </p>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => { setAboutOpen(false); setUpdateResult(null); }} className="w-full">确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 首次登录引导向导：onboardingOpen 由 /api/auth/me 成功后按本机标记决定。
          「去完成」会跳转到对应 view 并关闭向导；「跳过」/「完成」均写入完成标记。 */}
      {onboardingOpen && (
        <OnboardingWizard
          onNavigate={(v) => navigate(v)}
          onClose={() => setOnboardingOpen(false)}
        />
      )}

      {/* 组C：Cmd+K / Ctrl+K 快捷搜索面板，命中视图名后跳转。
          通过 AnimatePresence 动画进出，z-50 浮于所有内容之上。 */}
      <CommandPalette
        open={commandPalette.open}
        onOpenChange={commandPalette.setOpen}
        onSelect={navigate}
      />
    </TooltipProvider>
  );
}
