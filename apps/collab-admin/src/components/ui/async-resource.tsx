import type { ReactNode } from 'react';
import { AlertCircleIcon, InboxIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AsyncResourceStatus } from '@/lib/async-resource';
import { cn } from '@/lib/utils';

export interface AsyncResourceProps {
  status: AsyncResourceStatus;
  error?: Error | string | null;
  retry?: () => void;
  isEmpty?: boolean;
  loadingFallback?: ReactNode;
  emptyFallback?: ReactNode;
  children: ReactNode;
  className?: string;
}

function errorMessage(error: AsyncResourceProps['error']): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;
  return '请求失败，请稍后重试。';
}

export function AsyncResource({
  status,
  error,
  retry,
  isEmpty = false,
  loadingFallback,
  emptyFallback,
  children,
  className,
}: AsyncResourceProps) {
  if (status === 'idle') return null;

  if (status === 'loading') {
    if (loadingFallback !== undefined) return <>{loadingFallback}</>;
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn('flex min-h-32 items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground', className)}
      >
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        正在加载
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div
        role="alert"
        className={cn(
          'flex min-h-32 flex-col items-center justify-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-8 text-center',
          className,
        )}
      >
        <AlertCircleIcon className="size-5 text-destructive" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">加载失败</p>
          <p className="max-w-xl text-xs leading-5 text-muted-foreground">{errorMessage(error)}</p>
        </div>
        {retry && (
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            <RefreshCwIcon className="size-3.5" aria-hidden="true" />
            重试
          </Button>
        )}
      </div>
    );
  }

  if (status === 'empty' || isEmpty) {
    if (emptyFallback !== undefined) return <>{emptyFallback}</>;
    return (
      <div
        role="status"
        className={cn('flex min-h-32 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground', className)}
      >
        <InboxIcon className="size-5 opacity-60" aria-hidden="true" />
        暂无数据
      </div>
    );
  }

  return <>{children}</>;
}
