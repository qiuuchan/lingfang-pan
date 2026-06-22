// FloatingCreateButton —— 右下角悬浮「创建插件」入口（v4 形态）。
// 创建器打开时隐藏（避免遮挡面板）。点击唤起悬浮创建器。
import { SparklesIcon } from 'lucide-react';

export function FloatingCreateButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  if (open) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="创建插件"
      title="创建插件"
      className="absolute bottom-6 right-6 z-20 inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95"
    >
      <SparklesIcon className="size-5" />
    </button>
  );
}
