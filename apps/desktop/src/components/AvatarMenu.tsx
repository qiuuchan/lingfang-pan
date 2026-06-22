// AvatarMenu.tsx — 左下角用户按钮弹出的富菜单（从 lingfang-v4 移植，适配当前 RBAC/View 架构）。
//
// 与 v4 原版的差异（见 task 06-22-desktop-shell-ui-revamp design §4.2）：
// - 去掉 token 余额请求：桌面端无 /api/teams/current/profile 数据契约，账号头只显示名/租户/角色。
// - 未读数复用 NotificationCenter 的 useUnreadCount（侧栏铃铛已移除，入口收进此菜单），避免重复轮询。
// - 角色门控改用 isTeamManager(session.permissions)（RBAC），非 v4 的硬编码 role 字符串比较。
// - View 映射：team-manage→team-admin（body 视图）、llm→设置 gateway tab；删除「版本发布管理」（桌面端无 releases 视图，属 collab-admin）。
// - 通知中心抽屉在本组件渲染（随菜单生命周期挂载）。
// - 弹出层 left 定位随 collapsed 切换（折叠态贴窄轨道 w-14，展开态贴宽轨道 + 间距）。
import { useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  ChevronRightIcon,
  LogOutIcon,
  BellIcon,
  WalletIcon,
  SettingsIcon,
  UsersIcon,
  PuzzleIcon,
  WrenchIcon,
  HelpCircleIcon,
  RepeatIcon,
  CpuIcon,
  KeyRoundIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
} from 'lucide-react';
import { useApp } from '@/App';
import { isTeamManager } from '@/lib/permissions';
import { NotificationCenter, useUnreadCount } from '@/components/NotificationCenter';
import { cn } from '@/lib/utils';
import type { View } from '@/lib/types';

export function AvatarMenu({
  open,
  onClose,
  collapsed,
}: {
  open: boolean;
  onClose: () => void;
  /** 侧栏折叠态：决定弹出层 left 定位（折叠态贴窄轨道）。 */
  collapsed: boolean;
}) {
  const { session, resetSession, setView, openAccountSettings } = useApp();
  const { theme, setTheme } = useTheme();
  const [notifOpen, setNotifOpen] = useState(false);
  // 仅菜单打开时轮询未读（与原侧栏铃铛同语义：登录态 + 可见时启用）。
  const unread = useUnreadCount(open);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭：延迟一帧绑定 mousedown，避免触发菜单的同一个点击事件立刻把它关掉。
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [open, onClose]);

  // Esc 关闭。
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const avatarChar = (session.displayName?.charAt(0) || '?').toUpperCase();
  // 团队管理 / 开发者入口同门控（团队管理员可见，与 v4 语义一致）。
  const canManageTeam = isTeamManager(session.permissions);
  const tenantLabel = session.tenantName || (session.tenantId ? `团队 ${session.tenantId.slice(0, 8)}…` : '未加入团队');
  const roleLabel = session.role === 'TEAM_ADMIN' ? '管理员' : session.role ? '成员' : '已登录';

  const go = (v: View) => {
    setView(v);
    onClose();
  };

  type Item = {
    key: string;
    label: string;
    icon: typeof SettingsIcon;
    visible: boolean;
    badge?: number;
    onClick: () => void;
  };

  // 上半部分菜单（通知 / 钱包 / 切团队 / 插件 / 团队管理 / 开发者 / LLM）。
  const items: Item[] = [
    { key: 'notif', label: '通知中心', icon: BellIcon, visible: true, badge: unread, onClick: () => { setNotifOpen(true); } },
    { key: 'wallet', label: '钱包', icon: WalletIcon, visible: true, onClick: () => { openAccountSettings('wallet'); onClose(); } },
    { key: 'switch-team', label: '切换团队', icon: RepeatIcon, visible: true, onClick: () => { openAccountSettings('team'); onClose(); } },
    { key: 'plugins', label: '插件管理', icon: PuzzleIcon, visible: true, onClick: () => go('plugins') },
    // team-admin 是 body 视图（主区渲染 TeamAdmin 页），区别于走 AccountDialog 的 'team' tab。
    { key: 'team-admin', label: '团队管理', icon: UsersIcon, visible: canManageTeam, onClick: () => go('team-admin') },
    { key: 'creator', label: '开发者模式', icon: WrenchIcon, visible: canManageTeam, onClick: () => go('creator') },
    // LLM 设置：桌面端无独立 view，跳设置页 gateway tab（模型服务）。
    { key: 'llm', label: 'LLM 设置', icon: CpuIcon, visible: true, onClick: () => { openAccountSettings('settings', 'gateway'); onClose(); } },
  ];

  // 下半部分菜单（设置 / 安全 / 帮助）。安全暂合并到设置页（无独立 tab）。
  const bottomItems: Item[] = [
    { key: 'settings', label: '设置与快捷键', icon: SettingsIcon, visible: true, onClick: () => { openAccountSettings('settings'); onClose(); } },
    { key: 'security', label: '本地权限与安全', icon: KeyRoundIcon, visible: true, onClick: () => { openAccountSettings('settings'); onClose(); } },
    { key: 'help', label: '帮助与反馈', icon: HelpCircleIcon, visible: true, onClick: () => window.open('https://lingfang.io/docs', '_blank') },
  ];

  const themeOpts: { value: string; label: string; icon: typeof SunIcon }[] = [
    { value: 'light', label: '亮色', icon: SunIcon },
    { value: 'dark', label: '暗色', icon: MoonIcon },
    { value: 'system', label: '跟随系统', icon: MonitorIcon },
  ];

  return (
    <>
      {/* 遮罩：挡住下层交互（点外关闭已由 mousedown effect 处理，遮罩兜底防穿透）。 */}
      <div className="fixed inset-0 z-40" />

      {/* 菜单：从左下角账户按钮上方弹出。left 贴近侧栏左内容边（侧栏 p-2 内边距 ≈ 8px），
          折叠/展开均锚定账户头像左缘，菜单向右展开覆盖侧栏底 + 主区底。 */}
      <div
        ref={menuRef}
        className={cn(
          'fixed bottom-14 z-50 w-72 overflow-hidden rounded-xl border bg-card shadow-2xl',
          collapsed ? 'left-3' : 'left-2',
        )}
        role="menu"
        aria-orientation="vertical"
      >
        {/* 头部：头像 + 显示名 + 租户 + 角色 */}
        <div className="flex items-center gap-3 border-b p-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
            {avatarChar}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {session.displayName || '未登录'}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {tenantLabel} · {roleLabel}
            </div>
          </div>
        </div>

        {/* 上半部分菜单 */}
        <div className="p-1.5">
          {items.filter((i) => i.visible).map((item) => (
            <MenuRow key={item.key} icon={item.icon} label={item.label} badge={item.badge} onClick={item.onClick} />
          ))}
        </div>

        <div className="h-px bg-border" />

        {/* 外观主题 */}
        <div className="p-1.5">
          <div className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">外观主题</div>
          <div className="flex gap-1 px-1.5 pb-1">
            {themeOpts.map((opt) => {
              const active = theme === opt.value;
              const OptIcon = opt.icon;
              return (
                <button
                  key={opt.value}
                  onClick={() => setTheme(opt.value)}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors',
                    active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  <OptIcon className="size-3.5" />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="h-px bg-border" />

        {/* 下半部分菜单 */}
        <div className="p-1.5">
          {bottomItems.filter((i) => i.visible).map((item) => (
            <MenuRow key={item.key} icon={item.icon} label={item.label} onClick={item.onClick} />
          ))}
        </div>

        <div className="h-px bg-border" />

        {/* 退出登录 */}
        <div className="p-1.5">
          <button
            onClick={() => {
              resetSession();
              onClose();
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
            role="menuitem"
          >
            <LogOutIcon className="size-4" />
            退出登录
          </button>
        </div>
      </div>

      {/* 通知中心抽屉（随菜单挂载，notifOpen 时打开）。 */}
      <NotificationCenter open={notifOpen} onOpenChange={setNotifOpen} />
    </>
  );
}

/** 菜单行：图标 + 文案 + 可选红点角标 + 右箭头。 */
function MenuRow({
  icon: Icon,
  label,
  badge,
  onClick,
}: {
  icon: typeof SettingsIcon;
  label: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
      role="menuitem"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] text-destructive-foreground">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/50" />
    </button>
  );
}
