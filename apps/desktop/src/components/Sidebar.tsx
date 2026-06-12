import { useState, useEffect } from 'react';
import { useApp } from '@/App';
import { Button, buttonVariants } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { View } from '@/lib/types';
import { TenantSelect } from '@/pages/TenantSelect';
import {
  HomeIcon,
  PackageIcon,
  SettingsIcon,
  UsersIcon,
  ChevronDownIcon,
  LogOutIcon,
  UserRoundIcon,
  SparklesIcon,
  StoreIcon,
  WalletIcon,
  ShieldCheckIcon,
  ArrowLeftRightIcon,
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-3 text-xs"><span className="shrink-0 text-muted-foreground">{label}</span><span className="break-all text-right font-mono">{value}</span></div>;
}

export function Sidebar() {
  const { session, view, setView, setRunningPlugin, resetSession } = useApp();
  const items = NAV.filter((n) => (!n.teamAdminOnly || session.role === 'TEAM_ADMIN') && (!n.platformAdminOnly || session.isPlatformAdmin));
  const [open, setOpen] = useState(false);
  const [tenantOpen, setTenantOpen] = useState(false);
  const tenantLabel = session.tenantName || (session.tenantId ? `团队 ${session.tenantId.slice(0, 8)}…` : '未加入团队');
  const roleLabel = session.role ? (ROLE_LABEL[session.role] || session.role) : '已登录';

  // 切换/创建团队成功后 tenantId 变化，自动关闭切换团队弹窗。
  useEffect(() => { setTenantOpen(false); }, [session.tenantId]);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3.5">
        <HomeIcon className="size-5 text-primary" />
        <span className="text-sm font-semibold leading-tight">LingFang<br /><span className="text-xs font-normal text-muted-foreground">协作平台前台</span></span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2.5">
        {items.map(({ v, label, icon: Icon }) => {
          const active = view === v;
          return (
            <Button
              key={v}
              variant="ghost"
              onClick={() => { setRunningPlugin(null); setView(v); }}
              className={cn('h-9 justify-start gap-2.5 px-3 font-medium', active ? 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
            >
              <Icon className="size-4" />{label}
            </Button>
          );
        })}
      </nav>
      <div className="border-t p-2.5">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-auto w-full justify-start gap-2 px-3 py-2')}>
            <UserRoundIcon className="size-4 shrink-0" />
            <span className="flex-1 truncate text-left text-xs"><span className="block truncate font-medium text-foreground">{tenantLabel}</span><span className="block truncate text-muted-foreground">{roleLabel}</span></span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
          </PopoverTrigger>
          <PopoverContent side="right" align="end" className="w-80">
            <p className="font-medium">账户信息</p>
            <div className="flex flex-col gap-1.5">
              <InfoRow label="昵称" value={session.displayName || '—'} />
              <InfoRow label="邮箱" value={session.email || '—'} />
              <InfoRow label="团队" value={session.tenantName || '未加入'} />
              <InfoRow label="角色" value={roleLabel} />
              <InfoRow label="用户 ID" value={session.userId || '—'} />
            </div>
            <div className="mt-2 flex flex-col gap-1 border-t pt-2">
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { setOpen(false); setTenantOpen(true); }}>
                <ArrowLeftRightIcon className="size-4" />切换团队
              </Button>
              <Button variant="ghost" size="sm" className="w-full justify-start text-destructive hover:text-destructive" onClick={resetSession}>
                <LogOutIcon className="size-4" />退出登录
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <Dialog open={tenantOpen} onOpenChange={setTenantOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>切换或创建团队</DialogTitle>
          </DialogHeader>
          <TenantSelect />
        </DialogContent>
      </Dialog>
    </aside>
  );
}