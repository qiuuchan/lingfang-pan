import { PanelLeftCloseIcon, PanelLeftOpenIcon, MinusIcon, SquareIcon, XIcon, CopyIcon, PlayIcon, Code2Icon, SparklesIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '@/lib/utils';
import { dragRegionProps } from '@/lib/window-drag';
import type { PluginWorkspaceMode } from '@/lib/types';

// 自定义标题栏（隐藏系统 decorations 后承载窗口拖拽 + 最小化/最大化/关闭 + 侧边栏折叠 + 插件模式切换）。
// 拖动逻辑抽到 lib/window-drag.ts（dragRegionProps），主窗口 DOM 与 portal 弹窗统一复用。

interface TitleBarProps {
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  /** 标题栏文案（默认 '灵坊工作台'）。登录态等无侧边栏场景可传平台名展示。 */
  label?: string;
  /** 主窗口插件工作台模式切换；仅主界面传入，登录/安装向导不展示。 */
  pluginMode?: PluginWorkspaceMode;
  onPluginModeChange?: (mode: PluginWorkspaceMode) => void;
}

const PLUGIN_MODES: Array<{ value: PluginWorkspaceMode; label: string; icon: typeof PlayIcon }> = [
  { value: 'run', label: '运行插件', icon: PlayIcon },
  { value: 'develop', label: '开发插件', icon: Code2Icon },
];

export function TitleBar({ sidebarOpen, onToggleSidebar, label = '灵坊工作台', pluginMode, onPluginModeChange }: TitleBarProps) {
  const hasTauri = typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  const appWindow = hasTauri ? getCurrentWindow() : null;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!appWindow) return;
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    appWindow.onResized(() => { appWindow.isMaximized().then(setMaximized).catch(() => {}); })
      .then((fn) => { unlisten = fn as unknown as () => void; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, [appWindow]);

  const hasSidebar = typeof onToggleSidebar === 'function';
  const showPluginModeSwitch = Boolean(pluginMode && onPluginModeChange);

  return (
    <div
      {...dragRegionProps}
      className="grid h-[52px] shrink-0 select-none grid-cols-[1fr_auto_1fr] items-center border-b border-[#2a2a2c] bg-[#0d0d0d] shadow-[0_1px_0_rgba(255,255,255,0.03)]"
    >
      <div className="flex h-full min-w-0 items-center gap-2.5 px-3" {...dragRegionProps}>
        {hasSidebar && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleSidebar!(); }}
            className="inline-flex size-8 items-center justify-center rounded-lg text-[#8a8a8f] transition-colors hover:bg-[#2a2a2c] hover:text-[#e5e5e5]"
            aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
            title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          >
            {sidebarOpen ? <PanelLeftCloseIcon className="size-[18px]" /> : <PanelLeftOpenIcon className="size-[18px]" />}
          </button>
        )}
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#252528] text-[#e5e5e5] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
            <SparklesIcon className="size-4" />
          </span>
          <span className="truncate text-lg font-semibold text-[#e5e5e5]" data-tauri-drag-region>{label}</span>
        </div>
      </div>

      {showPluginModeSwitch ? (
        <div
          className="flex items-center gap-1 rounded-xl bg-[#252528] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_8px_24px_rgba(0,0,0,0.18)]"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {PLUGIN_MODES.map((mode) => {
            const Icon = mode.icon;
            const active = pluginMode === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                aria-pressed={active}
                title={mode.label}
                onClick={() => onPluginModeChange?.(mode.value)}
                className={cn(
                  'inline-flex h-8 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors duration-150',
                  active
                    ? 'bg-[#3a3a3c] text-white shadow-[0_1px_0_rgba(255,255,255,0.06),0_8px_18px_rgba(0,0,0,0.18)]'
                    : 'bg-transparent text-[#8a8a8f] hover:bg-[#2a2a2c] hover:text-[#e5e5e5]',
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span>{mode.label}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div />
      )}

      {appWindow && (
        <div className="flex h-full items-center justify-end gap-1 pr-2">
          <WinBtn title="最小化" onClick={() => appWindow.minimize()}>
            <MinusIcon className="size-4" />
          </WinBtn>
          <WinBtn title={maximized ? '还原' : '最大化'} onClick={() => appWindow.toggleMaximize()}>
            {maximized ? <CopyIcon className="size-3.5 rotate-180" /> : <SquareIcon className="size-3.5" />}
          </WinBtn>
          <WinBtn title="关闭" danger onClick={() => appWindow.close()}>
            <XIcon className="size-4" />
          </WinBtn>
        </div>
      )}
    </div>
  );
}

function WinBtn({ children, title, onClick, danger }: { children: ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-lg text-[#8a8a8f] transition-colors',
        danger ? 'hover:bg-[#ff5f57]/10 hover:text-[#ff5f57]' : 'hover:bg-[#2a2a2c] hover:text-[#e5e5e5]',
      )}
    >
      {children}
    </button>
  );
}
