// Sidebar.tsx — 应用侧边栏（Task 3+6+8：可伸缩 + v4 风格 + 搜索入口）。
//
// 设计（参考 lingfang-v4，按 main 的 RBAC/View 架构适配）：
// - 二态 + 可拖拽：
//   · collapsed=true（标题栏汉堡折叠）→ 图标轨道 w-14，保留全部功能按钮（Task 3「保留所有功能按钮」）。
//   · collapsed=false → 展开态，宽度可拖拽（200–320px），默认 224，持久化 lf:sidebar-width。
//     拖拽手柄在右边缘，双击复位默认宽度。
// - 顶部搜索按钮（Task 6）：点击 / Ctrl+K 唤起 CommandPalette（背景模糊居中浮层，由 App 渲染）。
// - 底部账户信息：点击 → 唤起 AvatarMenu（项 4，v4 富菜单形态，由 App 统一渲染）。团队管理 / 通知入口已迁入其中（项 3）。
// - 样式沿用 v4 / 现有 shadcn token：bg-card、border-r、ghost 按钮、active 态 primary 高亮。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/App';
import { Button, buttonVariants } from '@/components/ui/button';
import { PluginIcon, readPluginIcon } from '@/components/plugins/author-actions';
import { cn } from '@/lib/utils';
import type { View } from '@/lib/types';
import {
  HomeIcon,
  PackageIcon,
  ChevronDownIcon,
  UserRoundIcon,
  ShieldCheckIcon,
  SearchIcon,
  type LucideIcon,
} from 'lucide-react';
import { preloadView } from '@/lib/view-preload';
import { isTeamManager } from '@/lib/permissions';

// 导航项：多数项是切 view（kind='view'）；「插件」项是打开插件中心悬浮窗（kind='plugin-center'，路线 A）。
type NavItem =
  | { kind: 'view'; v: View; label: string; icon: LucideIcon; teamAdminOnly?: boolean; platformAdminOnly?: boolean }
  | { kind: 'plugin-center'; label: string; icon: LucideIcon; teamAdminOnly?: boolean; platformAdminOnly?: boolean };

const NAV: NavItem[] = [
  { kind: 'view', v: 'home', label: '首页', icon: HomeIcon },
  // AI 创建插件入口为右下角 FAB（悬浮窗形态，非页面），不占侧栏导航位。
  // 项 3：团队管理入口迁至左下角 AvatarMenu，不再占用侧栏导航位。
  // 路线 A：插件中心改为悬浮窗（openPluginCenter），不再是主区 view。
  { kind: 'plugin-center', label: '插件', icon: PackageIcon },
  { kind: 'view', v: 'review', label: '审核', icon: ShieldCheckIcon, platformAdminOnly: true },
];

const ROLE_LABEL: Record<string, string> = {
  TEAM_ADMIN: '团队管理员',
  MEMBER: '成员',
};

// 展开态宽度范围与默认（Task 3：缩小默认宽度 + 可伸缩）。
const WIDTH_DEFAULT = 224;
const WIDTH_MIN = 200;
const WIDTH_MAX = 320;
const WIDTH_STORAGE = 'lf:sidebar-width';
const COLLAPSED_WIDTH = 56; // w-14：图标轨道宽度。

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, n)) : WIDTH_DEFAULT;
  } catch {
    return WIDTH_DEFAULT;
  }
}

export function Sidebar({
  collapsed,
  onOpenSearch,
  onOpenAvatarMenu,
}: {
  collapsed: boolean;
  /** 唤起全局搜索（Task 6）。App 传入，打开 CommandPalette。 */
  onOpenSearch: () => void;
  /** 唤起左下角用户菜单 AvatarMenu（项 4：替代直接打开 AccountDialog）。 */
  onOpenAvatarMenu: () => void;
}) {
  const { session, view, setView, setRunningPlugin, recentPlugins, openPluginCenter } = useApp();
  const items = NAV.filter((n) => (!n.teamAdminOnly || isTeamManager(session.permissions)) && (!n.platformAdminOnly || session.isPlatformAdmin));
  const tenantLabel = session.tenantName || (session.tenantId ? `团队 ${session.tenantId.slice(0, 8)}…` : '未加入团队');
  const roleLabel = session.role ? (ROLE_LABEL[session.role] || session.role) : '已登录';

  const [width, setWidth] = useState<number>(loadWidth);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  // 持久化最终宽度（拖拽结束时调用，避免每次 mousemove 写 localStorage）。
  const persist = useCallback((w: number) => {
    try { localStorage.setItem(WIDTH_STORAGE, String(w)); } catch { /* 忽略配额/禁用 */ }
  }, []);

  // 拖拽右边缘调整宽度（仅展开态）。document 级 mousemove/mouseup，避免鼠标移出 handle 失去捕获。
  const startResize = useCallback((e: React.MouseEvent) => {
    if (collapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, startWidth + (ev.clientX - startX)));
      setWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persist(widthRef.current);
      setDragging(false);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [collapsed, persist]);

  // 双击手柄 → 复位默认宽度。
  const resetWidth = useCallback(() => {
    setWidth(WIDTH_DEFAULT);
    persist(WIDTH_DEFAULT);
  }, [persist]);

  // 展开态宽度变化时调整 CSS 变量（供 main 区 min-width/过渡参考，可选）。
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${collapsed ? COLLAPSED_WIDTH : width}px`);
  }, [width, collapsed]);

  // 路线 A：插件中心是悬浮窗（无 view），其按钮不参与 view 高亮——恒非 active。
  const activeView = (v: View) => view === v;

  return (
    <aside
      className={cn(
        'relative flex h-full shrink-0 flex-col border-r bg-card overflow-hidden',
        // 仅在非拖拽时过渡宽度（汉堡折叠/复位用）；拖拽中逐帧改 width，过渡会卡顿。
        !dragging && 'transition-[width] duration-200',
      )}
      style={{ width: collapsed ? COLLAPSED_WIDTH : width }}
    >
      {/* 搜索入口（Task 6）。通知铃铛已按项 3 迁入 AvatarMenu，搜索栏独占侧栏顶部。 */}
      <div className="border-b p-2">
        <button
          type="button"
          onClick={onOpenSearch}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'h-9 w-full justify-start gap-2 px-2.5 text-muted-foreground',
            collapsed && 'justify-center px-0',
          )}
          title="搜索（Ctrl K）"
          aria-label="搜索"
        >
          <SearchIcon className="size-4 shrink-0" />
          {!collapsed && <span className="text-xs">搜插件、搜功能…</span>}
          {!collapsed && (
            <kbd className="ml-auto rounded border bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">⌘K</kbd>
          )}
        </button>
      </div>

      {/* 主导航 */}
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {items.map((item) => {
          const Icon = item.icon;
          // 路线 A：插件中心项打开悬浮窗（非 view 切换），其余项切 view。
          const isPluginCenter = item.kind === 'plugin-center';
          const active = isPluginCenter ? false : activeView(item.v);
          const key = isPluginCenter ? 'plugin-center' : item.v;
          return (
            <Button
              key={key}
              variant="ghost"
              onClick={() => {
                if (isPluginCenter) { openPluginCenter(); return; }
                setRunningPlugin(null);
                setView(item.v);
              }}
              onFocus={() => { if (!isPluginCenter) preloadView(item.v); }}
              onMouseEnter={() => { if (!isPluginCenter) preloadView(item.v); }}
              title={collapsed ? item.label : undefined}
              className={cn(
                'h-9 shrink-0 gap-2.5 font-medium',
                collapsed ? 'w-full justify-center px-0' : 'justify-start px-3',
                active
                  ? 'bg-primary text-primary-foreground hover:bg-primary! hover:text-primary-foreground!'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && item.label}
            </Button>
          );
        })}
      </nav>

      {/* 项 9：最近使用的插件（运行插件时记入，置顶去重限量 5，按租户持久化）。空列表不渲染整块。 */}
      {recentPlugins.length > 0 && (
        <div className="shrink-0 border-t p-2">
          {!collapsed && (
            <div className="px-1 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
              最近使用
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {recentPlugins.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { setRunningPlugin(p); }}
                title={collapsed ? p.name : undefined}
                className={cn(
                  buttonVariants({ variant: 'ghost', size: 'sm' }),
                  'h-9 gap-2.5 font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
                  collapsed ? 'w-full justify-center px-0' : 'justify-start px-3',
                )}
              >
                {/* 侧栏小号图标：显式 size-5 覆盖 PluginIcon 默认 size-10（项 6 放大后默认偏大）。 */}
                <PluginIcon icon={readPluginIcon(p)} className="size-5 shrink-0 rounded object-cover" />
                {!collapsed && <span className="truncate text-sm">{p.name}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 账户信息：点击弹出 AvatarMenu（项 4，v4 形态富菜单）。 */}
      <div className="border-t p-2">
        <button
          type="button"
          onClick={onOpenAvatarMenu}
          title={collapsed ? tenantLabel : undefined}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-auto w-full gap-2 px-2 py-2', collapsed && 'justify-center px-0')}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserRoundIcon className="size-4" />
          </span>
          {!collapsed && (
            <span className="flex-1 truncate text-left text-xs">
              <span className="block truncate font-medium text-foreground">{tenantLabel}</span>
              <span className="block truncate text-muted-foreground">{roleLabel}</span>
            </span>
          )}
          {!collapsed && <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />}
        </button>
      </div>

      {/* 拖拽手柄（仅展开态）：右边缘 1px 热区，hover/active 高亮。 */}
      {!collapsed && (
        <div
          onMouseDown={startResize}
          onDoubleClick={resetWidth}
          className="group/resizer absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
          title="拖拽调整宽度（双击复位）"
          role="separator"
          aria-orientation="vertical"
        />
      )}
    </aside>
  );
}
