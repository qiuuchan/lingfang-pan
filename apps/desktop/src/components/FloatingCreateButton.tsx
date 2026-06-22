// FloatingCreateButton.tsx — 「创建插件」悬浮按钮（Task 9）。
//
// 固定在主体区右下角的 FAB，替代侧边栏「创建插件」导航项作为创建入口。
// 点击 → 打开创建器悬浮窗（App 内 PluginCreatorHome overlay）。
// 创建器打开时本按钮自动隐藏（避免遮挡）。
import { PlusIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function FloatingCreateButton({
  open,
  onClick,
}: {
  /** 创建器是否已打开（打开时隐藏 FAB）。 */
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="创建插件"
      title="创建插件"
      className={cn(
        'absolute bottom-6 right-6 z-20 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-all hover:bg-primary/90 hover:shadow-xl active:scale-95',
        // 创建器打开时收起（透明 + 禁用点击，避免与 overlay 重叠）。
        open ? 'pointer-events-none scale-90 opacity-0' : 'opacity-100',
      )}
    >
      <PlusIcon className="size-6" />
    </button>
  );
}
