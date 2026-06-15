import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { XIcon } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

// 详情侧边抽屉：用 framer-motion 驱动 slide-in-from-right 入场与退出动画。
// 不复用 Radix Dialog 的 Sheet（其动画走 tailwindcss-animate），此处统一用 motion 控制位移/透明度，
// 与任务约束「详情 Sheet 用 framer-motion 入场」一致。overlay 遮罩同步淡入淡出，ESC 关闭 + 点击遮罩关闭。
export function DetailSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  // ESC 关闭。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50">
          {/* 遮罩：淡入淡出，点击关闭。 */}
          <motion.div
            className="absolute inset-0 bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => onOpenChange(false)}
          />
          {/* 面板：slide-in-from-right，退出时滑回右侧。 */}
          <motion.div
            className={cn(
              'absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l bg-background shadow-xl',
              className,
            )}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 360, damping: 38 }}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-start justify-between gap-3 border-b p-5">
              <div className="min-w-0">
                <div className="truncate text-lg font-semibold text-foreground">{title}</div>
                {description ? (
                  <div className="mt-0.5 truncate text-sm text-muted-foreground">{description}</div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="关闭"
              >
                <XIcon className="size-4" />
              </button>
            </div>
            <ScrollArea className="flex-1">
              <div className="space-y-5 p-5">{children}</div>
            </ScrollArea>
            {footer ? <div className="border-t p-4">{footer}</div> : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
