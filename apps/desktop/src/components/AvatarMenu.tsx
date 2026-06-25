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
import { AnimatePresence, motion } from 'framer-motion';
import { MOTION } from '@/lib/motion';
import {
  ChevronRightIcon,
  LogOutIcon,
  BellIcon,
  WalletIcon,
  SettingsIcon,
  UsersIcon,
  UserRoundIcon,
  PuzzleIcon,
  WrenchIcon,
  HelpCircleIcon,
  CpuIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
} from 'lucide-react';
import { useApp } from '@/App';
import { isTeamManager } from '@/lib/permissions';
import { useUnreadCount } from '@/components/NotificationCenter';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
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
  const { session, resetSession, setView, openAccountSettings, openNotifications, openTeamAdmin, openPluginCenter, openHelpFeedback } = useApp();
  const { theme, setTheme } = useTheme();
  // 项 11：退出登录确认弹窗。
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  // 通知中心已提为 App 顶层独立悬浮窗（项 1，修复嵌套导致的点击即关/卡死 bug）；
  // 菜单仅显示未读角标（useUnreadCount），点击交给 openNotifications。
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

  // 不再 early return——用 AnimatePresence 做开关过渡（项 15b）。菜单关闭时 open=false，
  // 下方 {open && ...} 不渲染菜单本体，但退出动画由 AnimatePresence 在卸载前播放。

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

  // 上半部分菜单（个人资料 / 通知 / 团队钱包 / 插件 / 团队管理 / 开发者 / 其他设置）。
  const items: Item[] = [
    { key: 'profile', label: '个人资料', icon: UserRoundIcon, visible: true, onClick: () => { openAccountSettings('account'); onClose(); } },
    // 项 1：通知中心改为 App 顶层独立悬浮窗（openNotifications），不再嵌套本菜单内。
    { key: 'notif', label: '通知中心', icon: BellIcon, visible: true, badge: unread, onClick: () => { openNotifications(); onClose(); } },
    // 06-24：原「钱包」+「团队空间」两项合并为「团队钱包」（团队共享余额 + 灵石）。
    { key: 'team-wallet', label: '团队钱包', icon: WalletIcon, visible: true, onClick: () => { openAccountSettings('team-wallet'); onClose(); } },
    { key: 'plugins', label: '插件管理', icon: PuzzleIcon, visible: true, onClick: () => { openPluginCenter(); onClose(); } },
    // 项 5：团队管理改为居中悬浮窗（openTeamAdmin），不再走主区页面导航。
    { key: 'team-admin', label: '团队管理', icon: UsersIcon, visible: canManageTeam, onClick: () => { openTeamAdmin(); onClose(); } },
    // AI 创建插件入口为右下角 FAB（悬浮窗），不在此菜单。
    // 项 8：「LLM 设置」改为「其他设置」，点击进设置页第一个 tab（general）。
    { key: 'other-settings', label: '其他设置', icon: CpuIcon, visible: true, onClick: () => { openAccountSettings('settings', 'general'); onClose(); } },
  ];

  // 下半部分菜单（帮助）。项 9/10：「设置与快捷键」「本地权限与安全」已删除（统一并入「其他设置」）。
  const bottomItems: Item[] = [
    { key: 'help', label: '帮助与反馈', icon: HelpCircleIcon, visible: true, onClick: () => { openHelpFeedback(); onClose(); } },
  ];

  const themeOpts: { value: string; label: string; icon: typeof SunIcon }[] = [
    { value: 'light', label: '亮色', icon: SunIcon },
    { value: 'dark', label: '暗色', icon: MoonIcon },
    { value: 'system', label: '跟随系统', icon: MonitorIcon },
  ];

  return (
    <>
      {/* 遮罩：挡住下层交互（透明，无需过渡；点外关闭由 mousedown effect 处理）。 */}
      {open && <div className="fixed inset-0 z-40" />}

      {/* 项 15b：菜单开关过渡（淡入 + 轻微上滑 + 缩放）。left 贴近侧栏左内容边。 */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="avatar-menu"
            ref={menuRef}
            className={cn(
              'fixed bottom-14 z-50 w-72 overflow-hidden rounded-xl border bg-card shadow-2xl',
              collapsed ? 'left-3' : 'left-2',
            )}
            role="menu"
            aria-orientation="vertical"
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={{ duration: MOTION.menu, ease: 'easeOut' }}
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
                    'flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-lg border px-1.5 py-1.5 text-xs transition-colors',
                    active
                      ? 'border-transparent bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  <OptIcon className="size-3.5 shrink-0" />
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

        {/* 退出登录（项 11：点击弹确认，不直接退出） */}
        <div className="p-1.5">
          <button
            onClick={() => setLogoutConfirmOpen(true)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
            role="menuitem"
          >
            <LogOutIcon className="size-4" />
            退出登录
          </button>
        </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 项 11：退出登录确认弹窗。 */}
      <Dialog open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>退出登录</DialogTitle>
            <DialogDescription>确认退出当前账号？退出后需重新登录。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogoutConfirmOpen(false)}>取消</Button>
            <Button variant="destructive" onClick={() => { resetSession(); setLogoutConfirmOpen(false); onClose(); }}>
              <LogOutIcon className="size-4" /> 确认退出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
