import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ActivityIcon,
  BoxesIcon,
  CheckCircleIcon,
  CloudCogIcon,
  InfoIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  PlugIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UsersIcon,
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
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';
import { Sidebar, type SidebarNavItem } from '@/components/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Landing } from '@/components/landing/Landing';
import { LoginPage } from '@/components/landing/LoginPage';
import { DownloadPage } from '@/components/landing/DownloadPage';
import { ChangelogPage } from '@/components/landing/ChangelogPage';
import { Dashboard } from '@/components/dashboard';
import { UsersView } from '@/components/users-view';
import { TeamsView } from '@/components/teams-view';
import { PluginsView } from '@/components/plugins-view';
import { ApplicationsView } from '@/components/applications-view';
import { AdminsView } from '@/components/admins-view';
import { AuditView } from '@/components/audit-view';
import { ProvidersView } from '@/components/providers-view';
import { api, getToken, isPlatformAdminSession, setToken, UNAUTHORIZED_EVENT, type AdminSession } from '@/lib/api';
import type { View } from '@/lib/types';
import pkg from '../package.json';

const navItems: SidebarNavItem[] = [
  { view: 'dashboard', label: '仪表盘', icon: LayoutDashboardIcon },
  { view: 'users', label: '用户管理', icon: UsersIcon },
  { view: 'platformAdmins', label: '平台管理员', icon: ShieldCheckIcon },
  { view: 'teams', label: '团队管理', icon: BoxesIcon },
  { view: 'plugins', label: '插件管理', icon: PlugIcon },
  { view: 'llmProviders', label: '模型服务', icon: CloudCogIcon },
  { view: 'applications', label: '审批管理', icon: CheckCircleIcon },
  { view: 'audit', label: '审计日志', icon: ActivityIcon },
];

const VIEW_LABEL: Record<View, string> = {
  dashboard: '仪表盘',
  users: '用户管理',
  platformAdmins: '平台管理员',
  teams: '团队管理',
  plugins: '插件管理',
  llmProviders: '模型服务',
  applications: '审批管理',
  audit: '审计日志',
};

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

  useEffect(() => {
    if (!getToken()) return;
    api<AdminSession>('/api/auth/me')
      .then((next) => {
        if (!isPlatformAdminSession(next)) throw new Error('当前账号不是平台管理员');
        setSession(next);
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
      toast.error('登录已过期，请重新登录');
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
      // Fetch latest version info from the API or a version endpoint
      const baseUrl = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_COLLAB_API_BASE || '';
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const serverVersion = data.version || 'unknown';
        const currentVersion = pkg.version || '0.0.0';
        if (serverVersion === currentVersion) {
          setUpdateResult('current');
        } else {
          setUpdateResult(`new:${serverVersion}`);
        }
      } else {
        setUpdateResult('error');
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
        正在检查会话…
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
      <div className="flex min-h-screen bg-muted/30">
        <Sidebar
          items={navItems}
          activeView={view}
          onSelect={(v) => setView(v as View)}
          header={sidebarHeader}
          footer={sidebarFooter}
        />

        <main className="min-w-0 flex-1 px-4 pb-8 pt-14 sm:pt-8 lg:p-8">
          {/* Header */}
          <header className="mb-6 flex flex-col gap-2 rounded-2xl border bg-background p-5 shadow-sm">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage>{currentLabel}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <h1 className="text-2xl font-semibold tracking-tight">{currentLabel}</h1>
            <p className="text-sm text-muted-foreground">
              平台级治理入口：账号、团队、插件、审批和审计统一在这里处理。
            </p>
          </header>

          {/* Views with transition */}
          <div key={view} className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
            {view === 'dashboard' && <Dashboard onNavigate={setView} />}
            {view === 'users' && <UsersView />}
            {view === 'platformAdmins' && <AdminsView />}
            {view === 'teams' && <TeamsView />}
            {view === 'plugins' && <PluginsView />}
            {view === 'llmProviders' && <ProvidersView />}
            {view === 'applications' && <ApplicationsView />}
            {view === 'audit' && <AuditView />}
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
                无法连接服务器，请检查网络后再试。
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
    </TooltipProvider>
  );
}