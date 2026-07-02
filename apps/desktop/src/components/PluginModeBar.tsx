import { PlayIcon, Code2Icon } from 'lucide-react';
import type { PluginWorkspaceMode } from '@/lib/types';
import { cn } from '@/lib/utils';

// 插件模式切换栏：独立于标题栏，渲染在「灵坊工作台」标题下方单独一行。
// 直角风格 + 12px 圆角（rounded-xl），两个按钮当前态用 primary 高亮。

const PLUGIN_MODES: Array<{ value: PluginWorkspaceMode; label: string; desc: string; icon: typeof PlayIcon }> = [
  { value: 'run', label: '运行插件', desc: '浏览、固定和启动已安装的插件', icon: PlayIcon },
  { value: 'develop', label: '开发插件', desc: '用 AI 对话生成和调试插件草稿', icon: Code2Icon },
];

export function PluginModeBar({
  mode,
  onChange,
}: {
  mode: PluginWorkspaceMode;
  onChange: (mode: PluginWorkspaceMode) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-background/60 px-3 py-2 backdrop-blur">
      {PLUGIN_MODES.map((item) => {
        const Icon = item.icon;
        const active = mode === item.value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.value)}
            title={item.desc}
            className={cn(
              'inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-all duration-150',
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
