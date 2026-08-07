import { memo, useEffect, useState, type ReactNode, type RefObject } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, MenuIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTrigger,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { preloadView } from '@/lib/view-preload';
import type { View } from '@/lib/types';

export type SidebarNavItem = {
  view: View;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

// 分组渲染：标题（muted 小字）+ 组内项；侧栏按分组层级展示。
export type SidebarNavGroup = {
  title: string;
  items: SidebarNavItem[];
};

export type SidebarSlotContext = {
  compact: boolean;
  mobile: boolean;
};

type SidebarSlot = ReactNode | ((context: SidebarSlotContext) => ReactNode);

type SidebarProps = {
  // 分组导航（组C 新增）：按「核心管理 / 内容 / 系统」分组渲染，标题为 muted 小字。
  groups?: SidebarNavGroup[];
  // 扁平导航（向后兼容）：未提供 groups 时按扁平列表渲染（不分组的旧调用方）。
  items?: SidebarNavItem[];
  activeView: string;
  onSelect: (view: View) => void;
  header?: SidebarSlot;
  footer?: SidebarSlot;
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
  mobileTriggerRef?: RefObject<HTMLButtonElement>;
  showMobileTrigger?: boolean;
};

// memo：侧栏 props 稳定（groups/onSelect/header/footer 均引用稳定），
// 仅在 activeView/mobileOpen 变化时重渲染，避免 App 外壳开关弹窗等状态变化时整栏重建。
export const Sidebar = memo(function Sidebar({
  groups,
  items,
  activeView,
  onSelect,
  header,
  footer,
  mobileOpen: controlledMobileOpen,
  onMobileOpenChange,
  mobileTriggerRef,
  showMobileTrigger = true,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [uncontrolledMobileOpen, setUncontrolledMobileOpen] = useState(false);
  const mobileOpen = controlledMobileOpen ?? uncontrolledMobileOpen;

  function setMobileOpen(open: boolean) {
    if (controlledMobileOpen === undefined) {
      setUncontrolledMobileOpen(open);
    }
    onMobileOpenChange?.(open);
  }

  // Collapse sidebar on smaller screens
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1024px)');
    const handler = (e: MediaQueryListEvent) => setCollapsed(e.matches);
    setCollapsed(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // compact 只属于桌面栏；移动 Sheet 始终传 false，避免继承桌面折叠状态。
  function renderItem(
    { view, label, icon: Icon }: SidebarNavItem,
    compact: boolean,
    closeAfterSelect: boolean
  ) {
    const isActive = activeView === view;
    const button = (
      <button
        key={view}
        type="button"
        aria-current={isActive ? 'page' : undefined}
        onClick={() => {
          onSelect(view);
          if (closeAfterSelect) setMobileOpen(false);
        }}
        onFocus={() => preloadView(view)}
        onMouseEnter={() => preloadView(view)}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
          isActive
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          compact && 'justify-center px-2'
        )}
      >
        <Icon className="size-4 shrink-0" />
        {!compact && <span>{label}</span>}
      </button>
    );

    if (compact) {
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

  function renderGroup(group: SidebarNavGroup, compact: boolean, closeAfterSelect: boolean) {
    return (
      <div key={group.title} className="space-y-1">
        {!compact && (
          // 分组标题：muted 小字，仅展开态显示（折叠态省略以保持图标列对齐）。
          <div className="px-3 pb-0.5 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
            {group.title}
          </div>
        )}
        {group.items.map((item) => renderItem(item, compact, closeAfterSelect))}
      </div>
    );
  }

  function renderSlot(slot: SidebarSlot | undefined, context: SidebarSlotContext) {
    return typeof slot === 'function' ? slot(context) : slot;
  }

  function renderSidebarContent(context: SidebarSlotContext, closeAfterSelect: boolean) {
    const renderedHeader = renderSlot(header, context);
    const renderedFooter = renderSlot(footer, context);

    return (
      <div className="flex h-full flex-col gap-2">
        {renderedHeader && <div className="shrink-0">{renderedHeader}</div>}
        <nav aria-label="管理导航" className="flex-1 space-y-2 overflow-y-auto py-1 scrollbar-thin">
          {groups
            ? groups.map((group) => renderGroup(group, context.compact, closeAfterSelect))
            : (items || []).map((item) => renderItem(item, context.compact, closeAfterSelect))}
        </nav>
        {renderedFooter && <div className="shrink-0">{renderedFooter}</div>}
      </div>
    );
  }

  return (
    <TooltipProvider>
      {/* Desktop sidebar */}
      <aside
        aria-label="桌面导航"
        className={cn(
          'hidden shrink-0 border-r bg-background transition-all duration-200 lg:flex lg:flex-col',
          collapsed ? 'w-16' : 'w-64'
        )}
      >
        <div className="relative flex-1 p-3">
          {renderSidebarContent({ compact: collapsed, mobile: false }, false)}
        </div>
        <div className="shrink-0 border-t p-3">
          <button
            type="button"
            aria-label={collapsed ? '展开导航栏' : '收起导航栏'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((current) => !current)}
            className="flex w-full items-center justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {collapsed ? (
              <ChevronRightIcon className="size-4" />
            ) : (
              <ChevronLeftIcon className="size-4" />
            )}
          </button>
        </div>
      </aside>

      {/* Mobile Sheet uses its own expanded render and can be controlled by the App header. */}
      <div className="lg:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          {showMobileTrigger && (
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="打开导航菜单"
                className="fixed left-3 top-3 z-40 shadow-sm"
              >
                <MenuIcon className="size-4" />
              </Button>
            </SheetTrigger>
          )}
          <SheetContent
            side="left"
            className="w-72 max-w-[calc(100vw-2rem)] p-3"
            onCloseAutoFocus={(event) => {
              if (!mobileTriggerRef?.current) return;
              event.preventDefault();
              mobileTriggerRef.current.focus({ preventScroll: true });
            }}
          >
            <SheetTitle className="sr-only">导航菜单</SheetTitle>
            <SheetDescription className="sr-only">在管理后台各功能之间切换。</SheetDescription>
            {renderSidebarContent({ compact: false, mobile: true }, true)}
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  );
});
