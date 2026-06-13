import { PanelLeftCloseIcon, PanelLeftOpenIcon, MinusIcon, SquareIcon, XIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '@/lib/utils';

// 自定义标题栏（隐藏系统 decorations 后承载窗口拖拽 + 最小化/最大化/关闭 + 侧边栏折叠）。
// 用 @tauri-apps/api 标准导入（v2 推荐），不依赖猜测全局 __TAURI__ 结构。
// 拖拽：mousedown 调 startDragging（最可靠），仅左键 + 非交互元素触发。

interface TitleBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function TitleBar({ sidebarOpen, onToggleSidebar }: TitleBarProps) {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    // v2：onResized 回调无参，需在回调内重新查 isMaximized 同步状态。
    appWindow.onResized(() => { appWindow.isMaximized().then(setMaximized).catch(() => {}); })
      .then((fn) => { unlisten = fn as unknown as () => void; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, [appWindow]);

  // 拖拽：左键按下且非按钮/输入元素时调 startDragging（Tauri v2 推荐方式）。
  const onDragStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, [role="button"]')) return;
    void appWindow.startDragging();
  };

  return (
    <div
      data-tauri-drag-region
      onMouseDown={onDragStart}
      className="flex h-9 shrink-0 select-none items-center justify-between border-b bg-background/80 backdrop-blur"
    >
      {/* 左侧：侧边栏折叠按钮 + 应用名 */}
      <div className="flex h-full items-center gap-1 px-2" data-tauri-drag-region onMouseDown={onDragStart}>
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

      {/* 右侧：窗口控制（最小化/最大化/关闭） */}
      <div className="flex h-full items-center">
        <WinBtn title="最小化" onClick={() => appWindow.minimize()}>
          <MinusIcon className="size-3.5" />
        </WinBtn>
        <WinBtn title={maximized ? '还原' : '最大化'} onClick={() => appWindow.toggleMaximize()}>
          {maximized ? <CopyIcon className="size-3 rotate-180" /> : <SquareIcon className="size-3" />}
        </WinBtn>
        <WinBtn title="关闭" danger onClick={() => appWindow.close()}>
          <XIcon className="size-3.5" />
        </WinBtn>
      </div>
    </div>
  );
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
