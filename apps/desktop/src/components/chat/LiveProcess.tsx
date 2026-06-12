import { Loader2Icon, TerminalIcon, AlertCircleIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TranscriptEvent } from '@/lib/plugin-draft';

export function LiveProcess({ stage, events }: { stage: string; events: TranscriptEvent[] }) {
  return (
    <div className="max-w-[82%] self-start rounded-xl border bg-muted/60 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground/80">
        <Loader2Icon className="size-3.5 animate-spin text-primary" />
        {stage || '生成中…'}
      </div>
      <div className="flex flex-col gap-1.5">
        {events.length === 0 && <span className="text-xs text-muted-foreground">等待模型输出…</span>}
        {events.map((ev, i) => {
          if (ev.event !== 'output') return null;
          const stream = (ev.payload?.stream as string) || 'stdout';
          const text = (ev.payload?.text as string) || '';
          const isErr = stream === 'stderr';
          return (
            <div key={i} className="flex items-start gap-2 text-xs">
              {isErr ? <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" /> : <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
              <span className={cn('shrink-0 rounded px-1 font-mono', isErr ? 'bg-amber-500/15 text-amber-500' : 'bg-muted text-muted-foreground')}>{isErr ? '诊断' : '输出'}</span>
              <pre className="whitespace-pre-wrap break-words font-mono text-muted-foreground">{text.replace(/\n$/, '')}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}