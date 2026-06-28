// TodoPanel —— Agent 任务清单展示卡片。
//
// 配合 TodoWrite 工具：模型调用 TodoWrite 后，todo 经 callbacks.onTodoUpdate 同步到这里。
// 展示每项的状态图标 + 优先级标签 + 内容；底部显示完成进度条。
// 纯展示组件（不可编辑——状态由模型驱动，用户只看进度），与 ToolCallCard 风格一致。
import { useState } from 'react';
import {
  ChevronRightIcon, Loader2Icon, CheckCircle2Icon, CircleIcon, ListChecksIcon, PlayCircleIcon,
} from 'lucide-react';
import type { TodoItem } from '@/lib/agent/tools';
import { cn } from '@/lib/utils';

const PRIORITY_STYLE: Record<TodoItem['priority'], string> = {
  high: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  low: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
};
const PRIORITY_LABEL: Record<TodoItem['priority'], string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export function TodoPanel({ todos, streaming }: { todos: TodoItem[]; streaming?: boolean }) {
  const [open, setOpen] = useState(true);
  if (!todos.length) return null;

  const done = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const hasActive = streaming && todos.some((t) => t.status === 'in_progress');

  return (
    <div className="mx-auto max-w-3xl">
      <div className="overflow-hidden rounded-lg border border-border/40 bg-card/70 text-sm shadow-sm">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="grid w-full grid-cols-[auto_auto_1fr_auto] items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/25"
        >
          <ChevronRightIcon className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className="flex size-6 items-center justify-center rounded-md border border-border/40 bg-background/70">
            <ListChecksIcon className="size-3.5 shrink-0 text-primary" />
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-xs font-medium text-foreground">任务清单</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground/70">
              {done}/{total} 完成
            </span>
          </span>
          <span className={cn(
            'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
            done === total
              ? 'border-green-600/30 bg-green-500/10 text-green-600 dark:text-green-400'
              : 'border-primary/30 bg-primary/10 text-primary',
          )}>
            {hasActive ? <Loader2Icon className="size-3 animate-spin" /> : done === total ? <CheckCircle2Icon className="size-3" /> : <CircleIcon className="size-3" />}
            {pct}%
          </span>
        </button>
        {open && (
          <div className="border-t border-border/25 bg-muted/10 px-3 py-2">
            {/* 进度条 */}
            <div className="mb-2 h-1 overflow-hidden rounded-full bg-muted/60">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary to-primary/80 transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <ul className="space-y-1">
              {todos.map((t, i) => {
                const isCurrent = t.status === 'in_progress';
                return (
                  <li
                    key={i}
                    className={cn(
                      'flex items-start gap-2 rounded px-1.5 py-1 text-xs',
                      isCurrent && 'bg-primary/5',
                    )}
                  >
                    <span className="mt-0.5 shrink-0">
                      {t.status === 'completed' ? (
                        <CheckCircle2Icon className="size-3.5 text-green-600 dark:text-green-400" />
                      ) : isCurrent ? (
                        <PlayCircleIcon className="size-3.5 text-primary" />
                      ) : (
                        <CircleIcon className="size-3.5 text-muted-foreground/50" />
                      )}
                    </span>
                    <span
                      className={cn(
                        'min-w-0 flex-1 leading-5',
                        t.status === 'completed'
                          ? 'text-muted-foreground/60 line-through'
                          : isCurrent
                            ? 'text-foreground'
                            : 'text-muted-foreground',
                      )}
                    >
                      {t.content}
                    </span>
                    <span className={cn('shrink-0 rounded border px-1 py-0.5 text-[9px] font-medium leading-none', PRIORITY_STYLE[t.priority])}>
                      {PRIORITY_LABEL[t.priority]}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
