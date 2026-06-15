import { useEffect, useState, lazy, Suspense } from 'react';
import { toast } from 'sonner';
import {
  CheckCircleIcon,
  InfoIcon,
  LogOutIcon,
  RefreshCwIcon,
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
import { Sidebar, type SidebarNavGroup } from '@/components/sidebar';
import { Footer } from '@/components/Footer';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CommandPalette, useCommandPalette } from '@/components/command-palette';
import { Landing } from '@/components/landing/Landing';
import { LoginPage } from '@/components/landing/LoginPage';
import { DownloadPage } from '@/components/landing/DownloadPage';
import { ChangelogPage } from '@/components/landing/ChangelogPage';
// 组D 加载优化：登录后各后台 View 按需懒加载，首屏（落地页/登录页）不进 bundle。
// 落地页四件套（Landing/LoginPage/DownloadPage/ChangelogPage）保持静态 import——
// 它们走未登录快速路径，且 Landing 是首屏，懒加载反而增加首次可交互延迟。
import { OnboardingWizard, ONBOARDING_DONE_KEY } from '@/components/onboarding-wizard';
import { NAV_GROUPS, VIEW_LABEL, VIEW_GROUP } from '@/lib/navigation';
import { api, getToken, isPlatformAdminSession, setToken, UNAUTHORIZED_EVENT, type AdminSession } from '@/lib/api';
import { initTheme } from '@/lib/theme';
import type { View } from '@/lib/types';
import { PageTransition, ListSkeleton } from '@/lib/motion';
import { getLatestRelease } from '@/lib/releases';
import pkg from '../package.json';

const Dashboard = lazy(() => import('@/components/dashboard').then((m) => ({ default: m.Dashboard })));
const UsersView = lazy(() => import('@/components/users-view').then((m) => ({ default: m.UsersView })));
const TeamsView = lazy(() => import('@/components/teams-view').then((m) => ({ default: m.TeamsView })));
const PluginsView = lazy(() => import('@/components/plugins-view').then((m) => ({ default: m.PluginsView })));
const ApplicationsView = lazy(() => import('@/components/applications-view').then((m) => ({ default: m.ApplicationsView })));
const AdminsView = lazy(() => import('@/components/admins-view').then((m) => ({ default: m.AdminsView })));
const AuditView = lazy(() => import('@/components/audit-view').then((m) => ({ default: m.AuditView })));
const ProvidersView = lazy(() => import('@/components/providers-view').then((m) => ({ default: m.ProvidersView })));
const SettingsView = lazy(() => import('@/components/settings-view').then((m) => ({ default: m.SettingsView })));

// 主题初始化：在模块加载时同步应用，避免首屏亮暗闪烁（FOUC）。
// 放在模块顶层执行一次，早于 React 渲染，读取 localStorage 的主题偏好并应用到 <html>。
initTheme();

// 分组导航配置（来自 @/lib/navigation 单一数据源）：核心管理 / 内容 / 系统。
// 侧栏、面包屑、命令面板统一引用，文案一处维护避免漂移。
const navGroups: SidebarNavGroup[] = NAV_GROUPS;

export default function App() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const [view, setView] = useState<View>('dashboard');
  // 未登录态的落地页视图：首页 / 登录页 / 下载页 / 更新日志页（各自独立全屏页，状态机 AJAX 切换，无路由库）。
  const [landingView, setLandingView] = useState<'home' | 'login' | 'download' | 'changelog'>('home');
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  // 首次登录引导向导：session 建立时若本机无完成标记则弹出。
  // 关闭（完成/跳过）后由 OnboardingWizard 写入 ONBOARDING_DONE_KEY，并向导自管 open 状态。
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // 组C：Cmd+K / Ctrl+K 快捷搜索面板。hook 内部挂全局快捷键，返回 open 态。
  const commandPalette = useCommandPalette();

  useEffect(() => {
    if (!getToken()) return;
    api<AdminSession>('/api/auth/me')
      .then((next) => {
        if (!isPlatformAdminSession(next)) throw new Error('当前账号不是平台管理员');
        setSession(next);
        // 首登判定：本机无完成标记 → 弹出引导向导。
        // 标记按设备维度持久（localStorage），换浏览器或清缓存会重新引导，符合「首次登录」语义。
        if (!localStorage.getItem(ONBOARDING_DONE_KEY)) setOnboardingOpen(true);
      })
      .catch((e) => {
        setToken(null);
        // ADMIN-01：401 已由 api() 的 UNAUTHORIZED 事件路径处理（refresh 失败后派发事件 + handler 已 toast），
        // 此处仅对非 401 错误（如网络异常、非管理员）toast，避免重复弹两条相同提示。
        const status = (e as { status?: number }).status;
        if (status !== 401) toast.error((e as Error).message);
      })
      .finally(() => setChecking(false));
  }, []);

  // ADMIN-01 修复：监听 api() 派发的 401 全局事件，清 session 回登录页。
  // 此前 token 过期后任意 /api/admin/* 请求仅弹 toast，session 不清空，用户卡死在已登录外壳。
  // 现由 api() 在 refresh 失败/已过期时派发 UNAUTHORIZED_EVENT，App.tsx 监听并 resetSession。
  useEffect(() => {
    const handler = () => {
      setToken(null);
      setSession(null);
      toast.error('登录已过期，重新登录');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
  }, []);

  function handleLogout() {
    setToken(null);
    setSession(null);
  }

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

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        检查中…
      </div>
    );
  }

  if (!session) {
    // 未登录：按 landingView 在首页 / 登录页 / 下载页 / 更新日志页之间切换（各自独立全屏页，AJAX 无刷新）。
    if (landingView === 'login') {
      return <LoginPage onAuthed={setSession} onBack={() => setLandingView('home')} />;
    }
    if (landingView === 'download') {
      return <DownloadPage onBack={() => setLandingView('home')} />;
    }
    if (landingView === 'changelog') {
      return <ChangelogPage onBack={() => setLandingView('home')} />;
    }
    return (
      <Landing
        onLogin={() => setLandingView('login')}
        onNavigateDownload={() => setLandingView('download')}
        onNavigateChangelog={() => setLandingView('changelog')}
      />
    );
  }

  const currentLabel = VIEW_LABEL[view];
  const currentGroup = VIEW_GROUP[view];

  const sidebarHeader = (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <ShieldCheckIcon className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">协作平台管理端</div>
          <div className="text-xs text-muted-foreground">Platform Admin</div>
        </div>
      </div>
    </div>
  );

  const sidebarFooter = (
    <div className="space-y-1">
      <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground break-all">
        {session.user.email}
      </div>
      <button
        onClick={() => setLogoutOpen(true)}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
      >
        <LogOutIcon className="size-4" />
        退出登录
      </button>
      <button
        onClick={() => setAboutOpen(true)}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <InfoIcon className="size-4" />
        关于
      </button>
    </div>
  );

  return (
    <TooltipProvider>
      {/* 固定视口高度 + overflow-hidden：侧栏 stretch 撑满不滚动，主内容区独立 overflow-y-auto。 */}
      <div className="flex h-screen overflow-hidden bg-muted/30">
        <Sidebar
          groups={navGroups}
          activeView={view}
          onSelect={(v) => setView(v as View)}
          header={sidebarHeader}
          footer={sidebarFooter}
        />

        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-8 pt-14 sm:pt-8 lg:p-8">
          {/* Header */}
          <header className="mb-6 flex flex-col gap-2 rounded-2xl border bg-background p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              {/* 面包屑：分组 / 视图，分组为可点击返回仪表盘的链接 */}
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink
                      className="cursor-pointer"
                      onClick={() => setView('dashboard')}
                    >
                      {currentGroup}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{currentLabel}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              {/* Cmd+K 快捷搜索入口 */}
              <button
                onClick={() => commandPalette.setOpen(true)}
                className="flex items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <span>快捷搜索</span>
                <kbd className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
              </button>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">{currentLabel}</h1>
            <p className="text-sm text-muted-foreground">
              平台级治理入口：账号、团队、插件、审批和审计统一在这里处理。
            </p>
          </header>

          {/* Views with transition：各 View 懒加载，Suspense 用列表骨架兜底首次加载。 */}
          <PageTransition viewKey={view}>
            <Suspense fallback={<ListSkeleton rows={6} />}>
              {view === 'dashboard' && <Dashboard onNavigate={setView} />}
              {view === 'users' && <UsersView />}
              {view === 'platformAdmins' && <AdminsView />}
              {view === 'teams' && <TeamsView />}
              {view === 'plugins' && <PluginsView />}
              {view === 'llmProviders' && <ProvidersView />}
              {view === 'applications' && <ApplicationsView />}
              {view === 'audit' && <AuditView />}
              {view === 'settings' && <SettingsView />}
            </Suspense>
          </PageTransition>

          {/* 页脚：主内容区底部，随主内容滚到底可见。 */}
          <Footer />
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
            <div className="grid gap-1 rounded-xl border bg-muted/20 p-3 text-sm">
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
          onNavigate={(v) => setView(v)}
          onClose={() => setOnboardingOpen(false)}
        />
      )}

      {/* 组C：Cmd+K / Ctrl+K 快捷搜索面板，命中视图名后跳转。
          通过 AnimatePresence 动画进出，z-50 浮于所有内容之上。 */}
      <CommandPalette
        open={commandPalette.open}
        onOpenChange={commandPalette.setOpen}
        onSelect={(v) => setView(v)}
      />
    </TooltipProvider>
  );
}