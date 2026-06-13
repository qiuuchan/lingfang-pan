import { AlertTriangleIcon, InfoIcon, RefreshCwIcon } from 'lucide-react';
import type { CreatorError, CreatorErrorLevel } from '@/lib/creator-error';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// 等级 → 图标 + 边框/底色映射。error 用红色，warning 用琥珀，info 降级为中性提示。
const LEVEL_STYLE: Record<CreatorErrorLevel, { icon: typeof AlertTriangleIcon; className: string }> = {
  error: { icon: AlertTriangleIcon, className: 'border-destructive/30 bg-destructive/5' },
  warning: { icon: AlertTriangleIcon, className: 'border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30' },
  info: { icon: InfoIcon, className: 'border-border bg-muted/60' },
};

/**
 * 对话区错误气泡：把 CreatorError 渲染为带图标/标题/详情的结构化卡片，
 * 替代 Bubble.error 的裸文本堆栈。
 * - 折叠的 raw 区域用可见细滚动条（scrollbar-thin），便于排障。
 * - retryable 且提供 onRetry 时渲染「重试」按钮。
 */
export function ErrorBubble({ error, onRetry }: { error: CreatorError; onRetry?: () => void }) {
  const { icon: Icon, className } = LEVEL_STYLE[error.level];
  return (
    <div className={cn('self-start max-w-[82%] rounded-xl border px-4 py-3 text-sm break-words', className)}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{error.title}</div>
          {error.detail && <p className="mt-1 text-xs text-muted-foreground">{error.detail}</p>}
          {error.raw && (
            <details className="mt-2">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground">查看详细信息</summary>
              {/* 折叠的原始技术信息：功能性滚动区，需可见细滚动条。 */}
              <pre className="scrollbar-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-xs">{error.raw}</pre>
            </details>
          )}
        </div>
        {error.retryable && onRetry && (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onRetry}>
            <RefreshCwIcon className="size-3.5" />
            重试
          </Button>
        )}
      </div>
    </div>
  );
}
