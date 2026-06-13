import { PanelLeftCloseIcon, PanelLeftOpenIcon, MinusIcon, SquareIcon, XIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

// 自定义标题栏（隐藏系统 decorations 后承载窗口拖拽 + 最小化/最大化/关闭 + 侧边栏折叠）。
// data-tauri-drag-region 让 Tauri 识别为可拖拽区；按钮/输入区需 stopPropagation 避免被拖拽吞掉点击。
// 窗口控制走 withGlobalTauri 注入的 window.__TAURI__.window（无需额外 @tauri-apps/api 依赖）。

interface TitleBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function TitleBar({ sidebarOpen, onToggleSidebar }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const w = (window as unknown as { __TAURI__?: { window?: { getCurrent?: () => WinApi } } }).__TAURI__?.window;
    const current = w?.getCurrent?.();
    if (!current) return;
    let unlisten: (() => void) | undefined;
    current.isMaximized?.().then(setMaximized).catch(() => {});
    current.onResized?.((ok: boolean) => setMaximized(ok)).then?.((fn?: () => void) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  const api = () => (window as unknown as { __TAURI__?: { window?: { getCurrent?: () => WinApi } } }).__TAURI__?.window?.getCurrent?.();

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-center justify-between border-b bg-background/80 backdrop-blur"
    >
      {/* 左侧：侧边栏折叠按钮 + 应用名 */}
      <div className="flex h-full items-center gap-1 px-2" data-tauri-drag-region>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleSidebar(); }}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
        >
          {sidebarOpen ? <PanelLeftCloseIcon className="size-4" /> : <PanelLeftOpenIcon className="size-4" />}
        </button>
        <span className="px-1 text-xs font-medium text-muted-foreground" data-tauri-drag-region>LingFang</span>
      </div>

      {/* 右侧：窗口控制（最小化/最大化/关闭），点击需阻止拖拽冒泡 */}
      <div className="flex h-full items-center">
        <WinBtn title="最小化" onClick={() => api()?.minimize?.()}>
          <MinusIcon className="size-3.5" />
        </WinBtn>
        <WinBtn title={maximized ? '还原' : '最大化'} onClick={() => api()?.toggleMaximize?.()}>
          {maximized ? <CopyIcon className="size-3 rotate-180" /> : <SquareIcon className="size-3" />}
        </WinBtn>
        <WinBtn title="关闭" danger onClick={() => api()?.close?.()}>
          <XIcon className="size-3.5" />
        </WinBtn>
      </div>
    </div>
  );
}

interface WinApi {
  minimize?: () => Promise<void> | void;
  toggleMaximize?: () => Promise<void> | void;
  close?: () => Promise<void> | void;
  isMaximized?: () => Promise<boolean>;
  onResized?: (cb: (maximized: boolean) => void) => Promise<(() => void) | undefined>;
}

function WinBtn({ children, title, onClick, danger }: { children: React.ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        'inline-flex h-full w-11 items-center justify-center text-muted-foreground transition-colors',
        danger ? 'hover:bg-destructive hover:text-destructive-foreground' : 'hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
