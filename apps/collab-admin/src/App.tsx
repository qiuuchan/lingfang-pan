import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ActivityIcon,
  BoxesIcon,
  CheckCircleIcon,
  InfoIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  PlugIcon,
  ShieldCheckIcon,
  UsersIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';
import { Sidebar, type SidebarNavItem } from '@/components/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Login } from '@/components/login';
import { Dashboard } from '@/components/dashboard';
import { UsersView } from '@/components/users-view';
import { TeamsView } from '@/components/teams-view';
import { PluginsView } from '@/components/plugins-view';
import { ApplicationsView } from '@/components/applications-view';
import { AdminsView } from '@/components/admins-view';
import { AuditView } from '@/components/audit-view';
import { api, getToken, isPlatformAdminSession, setToken, type AdminSession } from '@/lib/api';
import type { View } from '@/lib/types';

const navItems: SidebarNavItem[] = [
  { view: 'dashboard', label: '仪表盘', icon: LayoutDashboardIcon },
  { view: 'users', label: '用户管理', icon: UsersIcon },
  { view: 'platformAdmins', label: '平台管理员', icon: ShieldCheckIcon },
  { view: 'teams', label: '团队管理', icon: BoxesIcon },
  { view: 'plugins', label: '插件管理', icon: PlugIcon },
  { view: 'applications', label: '审批管理', icon: CheckCircleIcon },
  { view: 'audit', label: '审计日志', icon: ActivityIcon },
];

const VIEW_LABEL: Record<View, string> = {
  dashboard: '仪表盘',
  users: '用户管理',
  platformAdmins: '平台管理员',
  teams: '团队管理',
  plugins: '插件管理',
  applications: '审批管理',
  audit: '审计日志',
};

export default function App() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const [view, setView] = useState<View>('dashboard');

  useEffect(() => {
    if (!getToken()) return;
    api<AdminSession>('/api/auth/me')
      .then((next) => {
        if (!isPlatformAdminSession(next)) throw new Error('当前账号不是平台管理员');
        setSession(next);
      })
      .catch((e) => {
        setToken(null);
        toast.error((e as Error).message);
      })
      .finally(() => setChecking(false));
  }, []);

  function handleLogout() {
    setToken(null);
    setSession(null);
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        正在检查会话…
      </div>
    );
  }

  if (!session) {
    return <Login onAuthed={setSession} />;
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
      <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground break-all">
        {session.user.email}
      </div>
      <button
        onClick={handleLogout}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
      >
        <LogOutIcon className="size-4" />
        退出登录
      </button>
      <button
        onClick={() => alert('LingFang 协作平台管理端 v0.1')}
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

          {/* Views */}
          {view === 'dashboard' && <Dashboard />}
          {view === 'users' && <UsersView />}
          {view === 'platformAdmins' && <AdminsView />}
          {view === 'teams' && <TeamsView />}
          {view === 'plugins' && <PluginsView />}
          {view === 'applications' && <ApplicationsView />}
          {view === 'audit' && <AuditView />}
        </main>
      </div>
    </TooltipProvider>
  );
}