import { useState } from 'react';
import { useApp } from '@/App';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { View } from '@/lib/types';
import { AccountDialog } from '@/components/AccountDialog';
import {
  HomeIcon,
  PackageIcon,
  SettingsIcon,
  UsersIcon,
  ChevronDownIcon,
  UserRoundIcon,
  SparklesIcon,
  StoreIcon,
  WalletIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from 'lucide-react';

interface NavItem { v: View; label: string; icon: LucideIcon; teamAdminOnly?: boolean; platformAdminOnly?: boolean }

const NAV: NavItem[] = [
  { v: 'home', label: '创建插件', icon: SparklesIcon },
  { v: 'team', label: '团队空间', icon: HomeIcon },
  { v: 'team-manage', label: '团队管理', icon: UsersIcon, teamAdminOnly: true },
  { v: 'plugins', label: '插件', icon: PackageIcon },
  { v: 'market', label: '市场', icon: StoreIcon },
  { v: 'wallet', label: '钱包', icon: WalletIcon },
  { v: 'review', label: '审核', icon: ShieldCheckIcon, platformAdminOnly: true },
  { v: 'settings', label: '设置', icon: SettingsIcon },
];

const ROLE_LABEL: Record<string, string> = {
  TEAM_ADMIN: '团队管理员',
  MEMBER: '成员',
};

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const { session, view, setView, setRunningPlugin, applySession, resetSession, platformName, platformLogoUrl } = useApp();
  const items = NAV.filter((n) => (!n.teamAdminOnly || session.role === 'TEAM_ADMIN') && (!n.platformAdminOnly || session.isPlatformAdmin));
  // R6：账户信息改居中悬浮 Dialog（替代原右对齐 Popover）。
  const [accountOpen, setAccountOpen] = useState(false);
  const tenantLabel = session.tenantName || (session.tenantId ? `团队 ${session.tenantId.slice(0, 8)}…` : '未加入团队');
  const roleLabel = session.role ? (ROLE_LABEL[session.role] || session.role) : '已登录';

  return (
    <aside className={cn(
      'flex h-full shrink-0 flex-col border-r bg-card transition-all duration-200 overflow-hidden',
      collapsed ? 'w-0' : 'w-56',
    )}>
      <div className="flex w-56 items-center gap-2 border-b px-4 py-3.5">
        {/* 云同步平台信息：logoUrl 有值显示图片，无值 fallback HomeIcon 默认图标。
            平台名取后端 platformName（admin 可在「设置 → 平台信息」改名，全端同步）。 */}
        <div className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded bg-primary/10 text-primary">
          {platformLogoUrl ? (
            <img
              src={platformLogoUrl}
              alt={platformName}
              className="size-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <HomeIcon className="size-5 text-primary" />
          )}
        </div>
        <span className="text-sm font-semibold leading-tight">{platformName}<br /><span className="text-xs font-normal text-muted-foreground">协作平台前台</span></span>
      </div>
      <nav className="flex w-56 flex-1 flex-col gap-1 overflow-y-auto p-2.5">
        {items.map(({ v, label, icon: Icon }) => {
          const active = view === v;
          return (
            <Button
              key={v}
              variant="ghost"
              onClick={() => { setRunningPlugin(null); setView(v); }}
              className={cn('h-9 justify-start gap-2.5 px-3 font-medium', active ? 'bg-primary text-primary-foreground hover:bg-primary! hover:text-primary-foreground!' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
            >
              <Icon className="size-4" />{label}
            </Button>
          );
        })}
      </nav>
      <div className="w-56 border-t p-2.5">
        {/* R6：点击底部账户信息 → 居中悬浮 AccountDialog（修改用户名/密码/邮箱/登出）。 */}
        <button
          type="button"
          onClick={() => setAccountOpen(true)}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-auto w-full justify-start gap-2 px-3 py-2')}
        >
          <UserRoundIcon className="size-4 shrink-0" />
          <span className="flex-1 truncate text-left text-xs"><span className="block truncate font-medium text-foreground">{tenantLabel}</span><span className="block truncate text-muted-foreground">{roleLabel}</span></span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
        </button>
      </div>
      <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} session={session} applySession={applySession} resetSession={resetSession} />
    </aside>
  );
}
