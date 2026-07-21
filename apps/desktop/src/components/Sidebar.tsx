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
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '@/App';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { LoadedPlugin, View } from '@/lib/types';
import {
  HomeIcon,
  PackageIcon,
  ChevronDownIcon,
  UserRoundIcon,
  ShieldCheckIcon,
  SearchIcon,
  PinIcon,
  PinOffIcon,
  HistoryIcon,
  XIcon,
  FileEditIcon,
  ClockIcon,
  type LucideIcon,
} from 'lucide-react';
import { preloadView } from '@/lib/view-preload';
import { isTeamManager } from '@/lib/permissions';
import { tauriListen } from '@/lib/api';

// 导航项：切换主区 view。插件工作台在主区展示运行/开发两个模式。
type NavItem = { kind: 'view'; v: View; label: string; icon: LucideIcon; teamAdminOnly?: boolean; platformAdminOnly?: boolean };

const NAV: NavItem[] = [
  { kind: 'view', v: 'home', label: '首页', icon: HomeIcon },
  // 项 3：团队管理入口迁至左下角 AvatarMenu，不再占用侧栏导航位。
  { kind: 'view', v: 'run-plugins', label: '插件', icon: PackageIcon },
  { kind: 'view', v: 'draft-plugins', label: '草稿', icon: FileEditIcon },
  // 本地定时任务（local-scheduler）：顶级导航 + 失败红点徽章。
  { kind: 'view', v: 'schedules', label: '定时', icon: ClockIcon },
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
  const { session, view, setView, setRunningPlugin, pinnedPlugins, recentPlugins, isPinned, pinPlugin, unpinPlugin, removeFromRecent, openPluginCenter } = useApp();
  const items = NAV.filter((n) => (!n.teamAdminOnly || isTeamManager(session.permissions)) && (!n.platformAdminOnly || session.isPlatformAdmin));
  // 历史使用中已固定的项不重复展示，避免与「固定常用」区冗余。
  const recentUnpinned = recentPlugins.filter((p) => !isPinned(p.id));
  const tenantLabel = session.tenantName || (session.tenantId ? `团队 ${session.tenantId.slice(0, 8)}…` : '未加入团队');
  const roleLabel = session.role ? (ROLE_LABEL[session.role] || session.role) : '已登录';

  const [width, setWidth] = useState<number>(loadWidth);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  // 本地定时任务失败红点：监听 scheduler:run_finished；FAILED|TIMEOUT 时亮红点；
  // 用户进入 schedules 页时清除（视作"已确认"）。
  const [scheduleFailed, setScheduleFailed] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      unlisten = await tauriListen<{
        run: { status: string };
      }>('scheduler:run_finished', (event) => {
        const status = event.payload?.run?.status;
        if (status === 'FAILED' || status === 'TIMEOUT') {
          setScheduleFailed(true);
        }
      });
    })();
    return () => unlisten?.();
  }, []);
  // 进入 schedules 页清除红点。
  useEffect(() => {
    if (view === 'schedules') setScheduleFailed(false);
  }, [view]);

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
          const active = item.v === 'run-plugins'
            ? view === 'run-plugins' || view === 'develop-plugins'
            : activeView(item.v);
          // 定时任务红点：仅在 schedules 项 + scheduleFailed=true 时显示。
          const showDot = item.v === 'schedules' && scheduleFailed && !active;
          return (
            <Button
              key={item.v}
              variant="ghost"
              onClick={() => {
                if (item.v === 'run-plugins') { openPluginCenter(); return; }
                setRunningPlugin(null);
                setView(item.v);
              }}
              onFocus={() => { preloadView(item.v); }}
              onMouseEnter={() => { preloadView(item.v); }}
              title={collapsed ? item.label : undefined}
              className={cn(
                'relative h-9 shrink-0 gap-2.5 font-medium',
                collapsed ? 'w-full justify-center px-0' : 'justify-start px-3',
                active
                  ? 'bg-primary text-primary-foreground hover:bg-primary! hover:text-primary-foreground!'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && item.label}
              {showDot && (
                <span
                  className="absolute right-2 top-2 size-2 rounded-full bg-red-500 ring-2 ring-card"
                  aria-label="有任务执行失败"
                />
              )}
            </Button>
          );
        })}

        {/* 固定常用（pinnedPlugins）：放在导航按钮下方。空列表不渲染该分区。 */}
        {pinnedPlugins.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5">
            {!collapsed && (
              <div className="flex items-center gap-1.5 px-1 pb-0.5 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                <PinIcon className="size-3" />固定常用
              </div>
            )}
            {pinnedPlugins.map((p) => (
              <SidebarPluginItem
                key={p.id}
                plugin={p}
                collapsed={collapsed}
                actionIcon={<PinOffIcon className="size-3.5" />}
                actionTitle="取消固定"
                onAction={() => unpinPlugin(p.id)}
                onClick={() => { setRunningPlugin(p); }}
              />
            ))}
          </div>
        )}

        {/* 历史使用（recentPlugins，已固定的不重复）：运行插件时记入，置顶去重限量 5，按租户持久化。 */}
        {recentUnpinned.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5">
            {!collapsed && (
              <div className="flex items-center gap-1.5 px-1 pb-0.5 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                <HistoryIcon className="size-3" />历史使用
              </div>
            )}
            {recentUnpinned.map((p) => (
              <SidebarRecentItem
                key={p.id}
                plugin={p}
                collapsed={collapsed}
                onPin={() => pinPlugin(p)}
                onRemove={() => removeFromRecent(p.id)}
                onClick={() => { setRunningPlugin(p); }}
              />
            ))}
          </div>
        )}
      </nav>

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

// 侧栏插件项（固定常用 / 历史使用复用）：点击运行；hover 显示固定/取消固定按钮（折叠态不显示按钮）。
function SidebarPluginItem({
  plugin,
  collapsed,
  actionIcon,
  actionTitle,
  onAction,
  onClick,
}: {
  plugin: LoadedPlugin;
  collapsed: boolean;
  actionIcon: ReactNode;
  actionTitle: string;
  onAction: () => void;
  onClick: () => void;
}) {
  return (
    <div className="group/item relative flex items-center">
      <button
        type="button"
        onClick={onClick}
        title={collapsed ? plugin.name : undefined}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'h-9 flex-1 gap-2.5 font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
          collapsed ? 'w-full justify-center px-0' : 'justify-start px-3',
        )}
      >
        {/* 去图标后用插件名首字符占位（折叠态仅显示首字符,展开态显示全名+草稿徽章）。 */}
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-xs font-medium text-muted-foreground">
          {plugin.name.trim().charAt(0) || '?'}
        </span>
        {!collapsed && (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm">{plugin.name}</span>
            {plugin.draft && (
              <span className="shrink-0 rounded border border-amber-500/30 bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
                草稿
              </span>
            )}
          </span>
        )}
      </button>
      {!collapsed && (
        <Button
          variant="ghost"
          size="icon-sm"
          title={actionTitle}
          onClick={(e) => { e.stopPropagation(); onAction(); }}
          className="absolute right-1 size-6 opacity-0 transition-opacity group-hover/item:opacity-100"
        >
          {actionIcon}
        </Button>
      )}
    </div>
  );
}

// 侧栏历史使用项：hover 显示双操作按钮（固定 + 移除）。
function SidebarRecentItem({
  plugin,
  collapsed,
  onPin,
  onRemove,
  onClick,
}: {
  plugin: LoadedPlugin;
  collapsed: boolean;
  onPin: () => void;
  onRemove: () => void;
  onClick: () => void;
}) {
  return (
    <div className="group/item relative flex items-center">
      <button
        type="button"
        onClick={onClick}
        title={collapsed ? plugin.name : undefined}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'h-9 flex-1 gap-2.5 font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
          collapsed ? 'w-full justify-center px-0' : 'justify-start px-3',
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-xs font-medium text-muted-foreground">
          {plugin.name.trim().charAt(0) || '?'}
        </span>
        {!collapsed && (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm">{plugin.name}</span>
            {plugin.draft && (
              <span className="shrink-0 rounded border border-amber-500/30 bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700 group-hover/item:opacity-0 dark:bg-amber-950/30 dark:text-amber-400">
                草稿
              </span>
            )}
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="absolute right-1 flex gap-0.5 opacity-0 transition-opacity group-hover/item:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            title="固定常用"
            onClick={(e) => { e.stopPropagation(); onPin(); }}
            className="size-6"
          >
            <PinIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="从历史中移除"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="size-6 text-destructive hover:text-destructive"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
