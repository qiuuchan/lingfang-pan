import { useEffect, useState, type ReactNode } from 'react';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MenuIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';

export type SidebarNavItem = {
  view: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

// 分组渲染：标题（muted 小字）+ 组内项；侧栏按分组层级展示。
export type SidebarNavGroup = {
  title: string;
  items: SidebarNavItem[];
};

type SidebarProps = {
  // 分组导航（组C 新增）：按「核心管理 / 内容 / 系统」分组渲染，标题为 muted 小字。
  groups?: SidebarNavGroup[];
  // 扁平导航（向后兼容）：未提供 groups 时按扁平列表渲染（不分组的旧调用方）。
  items?: SidebarNavItem[];
  activeView: string;
  onSelect: (view: string) => void;
  header?: ReactNode;
  footer?: ReactNode;
};

export function Sidebar({ groups, items, activeView, onSelect, header, footer }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Collapse sidebar on smaller screens
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1024px)');
    const handler = (e: MediaQueryListEvent) => setCollapsed(e.matches);
    setCollapsed(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // 渲染单个导航项：激活态高亮 + 折叠态居中（仅图标）+ 折叠态 tooltip。
  function renderItem({ view, label, icon: Icon }: SidebarNavItem) {
    const isActive = activeView === view;
    const button = (
      <button
        key={view}
        onClick={() => {
          onSelect(view);
          setMobileOpen(false);
        }}
        className={cn(
          'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all',
          isActive
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          collapsed && 'justify-center px-2',
        )}
      >
        <Icon className="size-4 shrink-0" />
        {!collapsed && <span>{label}</span>}
      </button>
    );

    if (collapsed) {
      return (
        <Tooltip key={view}>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="right" className="flex items-center gap-2">
            {label}
          </TooltipContent>
        </Tooltip>
      );
    }
    return button;
  }

  function renderGroup(group: SidebarNavGroup) {
    return (
      <div key={group.title} className="space-y-1">
        {!collapsed && (
          // 分组标题：muted 小字，仅展开态显示（折叠态省略以保持图标列对齐）。
          <div className="px-3 pb-0.5 pt-3 text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
            {group.title}
          </div>
        )}
        {group.items.map(renderItem)}
      </div>
    );
  }

  const sidebarContent = (
    <div className="flex h-full flex-col gap-2">
      {header && <div className="shrink-0">{header}</div>}
      <nav className="flex-1 space-y-2 overflow-y-auto py-1">
        {groups
          ? groups.map(renderGroup)
          : (items || []).map(renderItem)}
      </nav>
      {footer && <div className="shrink-0">{footer}</div>}
    </div>
  );

  return (
    <TooltipProvider>
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'hidden shrink-0 border-r bg-background transition-all duration-200 lg:flex lg:flex-col',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        <div className="relative flex-1 p-3">
          {sidebarContent}
        </div>
        <div className="shrink-0 border-t p-3">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex w-full items-center justify-center rounded-xl p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {collapsed ? <ChevronRightIcon className="size-4" /> : <ChevronLeftIcon className="size-4" />}
          </button>
        </div>
      </aside>

      {/* Mobile trigger */}
      <div className="fixed left-3 top-3 z-40 lg:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="shadow-sm">
              <MenuIcon className="size-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-3">
            <SheetTitle className="sr-only">导航菜单</SheetTitle>
            {sidebarContent}
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  );
}