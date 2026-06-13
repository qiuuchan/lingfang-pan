import * as React from 'react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/markdown';

// design §3.4.2：增加可选 actions 渲染槽（assistant 气泡下挂「转为插件草稿」按钮等）。
// 主体渲染逻辑不变，仅把内容下方扩出一个可选节点。
export function Bubble({ role, content, actions }: { role: 'user' | 'assistant'; content: string; actions?: React.ReactNode }) {
  const isUser = role === 'user';
  return (
    <div className={cn('max-w-[82%] rounded-xl px-4 py-3 text-sm break-words', isUser ? 'self-end bg-primary text-primary-foreground whitespace-pre-wrap' : 'self-start bg-muted')}>
      <span className="mb-1 block text-[11px] opacity-70">{isUser ? '你' : 'AI'}</span>
      {isUser ? content : <Markdown>{content}</Markdown>}
      {actions ? <div className="mt-2">{actions}</div> : null}
    </div>
  );
}
