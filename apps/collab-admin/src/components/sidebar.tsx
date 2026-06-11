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

type SidebarProps = {
  items: SidebarNavItem[];
  activeView: string;
  onSelect: (view: string) => void;
  header?: ReactNode;
  footer?: ReactNode;
};

export function Sidebar({ items, activeView, onSelect, header, footer }: SidebarProps) {
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

  const sidebarContent = (
    <div className="flex h-full flex-col gap-2">
      {header && <div className="shrink-0">{header}</div>}
      <nav className="flex-1 space-y-1 overflow-y-auto py-1">
        {items.map(({ view, label, icon: Icon }) => {
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
        })}
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