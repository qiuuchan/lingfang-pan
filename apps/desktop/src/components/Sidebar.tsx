import { useState } from 'react';
import { useApp } from '@/App';
import { Button, buttonVariants } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { View } from '@/lib/types';
import {
  SparklesIcon, PackageIcon, StoreIcon, WalletIcon, ShieldCheckIcon, SettingsIcon,
  ChevronDownIcon, ChevronRightIcon, LogOutIcon, UserRoundIcon, PinOffIcon, PlayIcon, type LucideIcon,
} from 'lucide-react';

interface NavItem { v: View; label: string; icon: LucideIcon; adminOnly?: boolean }

const NAV: NavItem[] = [
  { v: 'generator', label: '造插件', icon: SparklesIcon },
  { v: 'plugins', label: '我的插件', icon: PackageIcon },
  { v: 'market', label: '市场', icon: StoreIcon },
  { v: 'wallet', label: '钱包', icon: WalletIcon },
  { v: 'review', label: '审核', icon: ShieldCheckIcon, adminOnly: true },
  { v: 'settings', label: '设置', icon: SettingsIcon },
];

// 租户角色 → 中文显示。
const ROLE_LABEL: Record<string, string> = {
  owner: '团队所有者',
  admin: '管理员',
  member: '成员',
};

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="break-all text-right font-mono">{value}</span>
    </div>
  );
}

export function Sidebar() {
  const { session, view, setView, runningPlugin, setRunningPlugin, resetSession, pinnedPlugins, unpinPlugin } = useApp();
  const items = NAV.filter((n) => !n.adminOnly || session.isPlatformAdmin);
  // 「我的插件」子菜单默认展开（有固定插件时）。
  const [pluginsOpen, setPluginsOpen] = useState(true);
  // 主显示：租户名称（回退到「未选租户」）；副显示：中文角色 + 平台管理员徽标。
  const tenantLabel = session.tenantName || (session.tenantId ? `租户 ${session.tenantId.slice(0, 8)}…` : '未选租户');
  const roleLabel = session.role ? (ROLE_LABEL[session.role] || session.role) : '已登录';

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-card">
      {/* 品牌 */}
      <div className="flex items-center gap-2 border-b px-4 py-3.5">
        <SparklesIcon className="size-5 text-primary" />
        <span className="text-sm font-semibold leading-tight">LingFang<br /><span className="text-xs font-normal text-muted-foreground">AI 插件生成平台</span></span>
      </div>

      {/* 纵向导航 */}
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2.5">
        {items.map(({ v, label, icon: Icon }) => {
          const active = view === v && !runningPlugin;
          // 「我的插件」带可展开的固定插件子菜单。
          if (v === 'plugins') {
            return (
              <div key={v}>
                <div
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <button className="flex flex-1 items-center gap-2.5" onClick={() => { setRunningPlugin(null); setView(v); }}>
                    <Icon className="size-4" />
                    {label}
                  </button>
                  {pinnedPlugins.length > 0 && (
                    <button onClick={() => setPluginsOpen((o) => !o)} className="opacity-70 hover:opacity-100" title={pluginsOpen ? '收起' : '展开'}>
                      {pluginsOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
                    </button>
                  )}
                </div>
                {/* 固定的插件子项：点击直接运行 */}
                {pluginsOpen && pinnedPlugins.length > 0 && (
                  <div className="mt-0.5 flex flex-col gap-0.5 pl-3">
                    {pinnedPlugins.map((p) => {
                      const running = runningPlugin?.id === p.id;
                      return (
                        <div
                          key={p.id}
                          className={cn(
                            'group flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                            running ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                        >
                          <button className="flex min-w-0 flex-1 items-center gap-1.5" onClick={() => { setView('plugins'); setRunningPlugin(p); }} title={`运行 ${p.name}`}>
                            <PlayIcon className="size-3 shrink-0" />
                            <span className="truncate">{p.name}</span>
                          </button>
                          <button onClick={() => unpinPlugin(p.id)} className="shrink-0 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-70" title="取消固定">
                            <PinOffIcon className="size-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }
          return (
            <button
              key={v}
              onClick={() => { setRunningPlugin(null); setView(v); }}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          );
        })}
      </nav>

      {/* 底部账户 */}
      <div className="border-t p-2.5">
        <Popover>
          <PopoverTrigger className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-auto w-full justify-start gap-2 px-3 py-2')}>
            <UserRoundIcon className="size-4 shrink-0" />
            <span className="flex-1 truncate text-left text-xs">
              <span className="block truncate font-medium text-foreground">{tenantLabel}</span>
              <span className="block truncate text-muted-foreground">
                {roleLabel}{session.isPlatformAdmin ? ' · 平台管理员' : ''}
              </span>
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
          </PopoverTrigger>
          <PopoverContent side="right" align="end" className="w-80">
            <p className="font-medium">账户信息</p>
            <div className="flex flex-col gap-1.5">
              <InfoRow label="昵称" value={session.displayName || '—'} />
              <InfoRow label="租户" value={session.tenantName || '未选择'} />
              <InfoRow label="角色" value={roleLabel} />
              <InfoRow label="用户 ID" value={session.userId || '—'} />
              <InfoRow label="租户 ID" value={session.tenantId || '未选择'} />
              {session.isPlatformAdmin && <InfoRow label="平台身份" value="平台管理员（可审核）" />}
            </div>
            <div className="border-t pt-2">
              <Button variant="ghost" size="sm" className="w-full justify-start text-destructive hover:text-destructive" onClick={resetSession}>
                <LogOutIcon className="size-4" />退出登录
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </aside>
  );
}
