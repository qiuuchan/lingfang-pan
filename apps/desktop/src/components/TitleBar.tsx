import { PanelLeftCloseIcon, PanelLeftOpenIcon, MinusIcon, SquareIcon, XIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '@/lib/utils';
import { dragRegionProps } from '@/lib/window-drag';

// 自定义标题栏（隐藏系统 decorations 后承载窗口拖拽 + 最小化/最大化/关闭 + 侧边栏折叠）。
// 拖动逻辑抽到 lib/window-drag.ts（dragRegionProps），主窗口 DOM 与 portal 弹窗统一复用。

interface TitleBarProps {
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  /** 标题栏文案（默认 'LingFang'）。登录态等无侧边栏场景可传平台名展示。 */
  label?: string;
}

export function TitleBar({ sidebarOpen, onToggleSidebar, label = '灵坊工作台' }: TitleBarProps) {
  // getCurrentWindow 在无 Tauri 壳（浏览器直连 vite dev server）时返回的对象不完整，
  // 调 isMaximized/onResized 会抛「Cannot read properties of undefined (reading 'metadata')」。
  // 运行时检测 __TAURI_INTERNALS__（withGlobalTauri:true 时注入），缺失则降级为纯展示标题栏（无窗口控制）。
  const hasTauri = typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  const appWindow = hasTauri ? getCurrentWindow() : null;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!appWindow) return;
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    // v2：onResized 回调无参，需在回调内重新查 isMaximized 同步状态。
    appWindow.onResized(() => { appWindow.isMaximized().then(setMaximized).catch(() => {}); })
      .then((fn) => { unlisten = fn as unknown as () => void; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, [appWindow]);

  // onToggleSidebar 缺省 = 无侧边栏场景（登录/安装向导/恢复中等 Centered 全屏态）：
  // 左侧不渲染折叠按钮，标题栏仅承载拖拽 + 右侧窗口控制。
  const hasSidebar = typeof onToggleSidebar === 'function';

  return (
    <div
      {...dragRegionProps}
      className="flex h-9 shrink-0 select-none items-center justify-between border-b bg-background/80 backdrop-blur"
    >
      {/* 左侧：侧边栏折叠按钮 + 应用名（无侧边栏场景仅留拖拽占位，保持窗口左右控制对齐） */}
      <div className="flex h-full items-center gap-1 px-2" {...dragRegionProps}>
        {hasSidebar && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleSidebar!(); }}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
            title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          >
            {sidebarOpen ? <PanelLeftCloseIcon className="size-4" /> : <PanelLeftOpenIcon className="size-4" />}
          </button>
        )}
        <span className="px-1 text-xs font-medium text-muted-foreground" data-tauri-drag-region>{label}</span>
      </div>

      {/* 右侧：窗口控制（最小化/最大化/关闭）。无 Tauri 壳时不渲染（浏览器环境无窗口控制语义）。 */}
      {appWindow && (
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
      )}
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
