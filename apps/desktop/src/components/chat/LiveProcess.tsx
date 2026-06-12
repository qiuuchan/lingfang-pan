import { Loader2Icon } from 'lucide-react';

export function LiveProcess({ stage, text, reasoning }: { stage: string; text: string; reasoning: string }) {
  return (
    <div className="max-w-[82%] self-start rounded-xl border bg-muted/60 px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground/80"><Loader2Icon className="size-3.5 animate-spin text-primary" />{stage || '生成中…'}</div>
      {reasoning && <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap border-l-2 border-primary/30 pl-2 font-mono text-xs text-muted-foreground">{reasoning}</pre>}
      {text ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{text}</pre> : <span className="text-xs text-muted-foreground">等待模型输出…</span>}
    </div>
  );
}