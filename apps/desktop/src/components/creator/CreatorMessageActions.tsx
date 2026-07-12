import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2Icon, CopyIcon, RotateCcwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CreatorRetryButton({
  busy,
  onRetry,
  status,
  streaming,
}: {
  busy: boolean;
  onRetry: () => void;
  status?: 'generating' | 'done' | 'failed' | 'cancelled';
  streaming?: boolean;
}) {
  if (streaming || (status !== 'failed' && status !== 'cancelled')) return null;
  const isCancel = status === 'cancelled';
  return (
    <div className="mt-2 flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={onRetry} disabled={busy} className="h-7 gap-1.5 px-2.5 text-xs">
        <RotateCcwIcon className="size-3" />
        {isCancel ? '继续' : '重试'}
      </Button>
      {busy && <span className="text-[11px] text-muted-foreground/60">正在生成中…</span>}
    </div>
  );
}

export function CreatorCopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  if (!text.trim()) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast.success('已复制');
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error('复制失败，请手动选取');
        }
      }}
      title={copied ? '已复制' : '复制'}
      className={cn(
        'absolute right-1.5 top-1.5 z-10 inline-flex size-6 items-center justify-center rounded-sm border border-border/50 bg-card text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100',
        copied && 'opacity-100 text-green-600',
        className,
      )}
    >
      {copied ? <CheckCircle2Icon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}
