import { cn } from '@/lib/utils';
import { Markdown } from '@/components/markdown';

export function Bubble({ role, content, error }: { role: 'user' | 'assistant'; content: string; error?: boolean }) {
  const isUser = role === 'user';
  return (
    <div className={cn('max-w-[82%] rounded-xl px-4 py-3 text-sm break-words', isUser ? 'self-end bg-primary text-primary-foreground whitespace-pre-wrap' : 'self-start bg-muted', error && 'whitespace-pre-wrap border border-destructive/30 bg-destructive/5 text-destructive')}>
      <span className="mb-1 block text-[11px] opacity-70">{isUser ? '你' : 'AI'}</span>
      {error ? <div className="max-h-72 overflow-auto">{content}</div> : isUser ? content : <Markdown>{content}</Markdown>}
    </div>
  );
}