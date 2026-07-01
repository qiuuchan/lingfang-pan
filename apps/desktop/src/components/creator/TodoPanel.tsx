// TodoPanel —— Agent 任务清单（底部折叠抽屉样式）。
//
// 配合 TodoWrite 工具：模型调用 TodoWrite 后，todo 经 callbacks.onTodoUpdate 同步到这里。
// 默认折叠为底部一条窄横条（显示进度概要），点击向上展开明细列表。
// 钉在对话区底部（不占对话滚动空间），类似 IDE 底部状态栏的折叠抽屉。
// 纯展示组件（不可编辑——状态由模型驱动，用户只看进度），与 ToolCallCard 风格一致。
import { useState } from 'react';
import {
  ChevronUpIcon, Loader2Icon, CheckCircle2Icon, CircleIcon, ListChecksIcon, PlayCircleIcon,
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
  const [open, setOpen] = useState(false);
  if (!todos.length) return null;

  const done = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const hasActive = streaming && todos.some((t) => t.status === 'in_progress');
  const allDone = done === total;
  // 当前进行中的任务（展开时高亮提示用户 AI 正在做的事）。
  const currentItem = todos.find((t) => t.status === 'in_progress');

  return (
    <div className="shrink-0 px-6">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            'overflow-hidden rounded-xl border shadow-lg backdrop-blur-md transition-all duration-200',
            open
              ? 'border-border/50 bg-card/90 shadow-black/10'
              : 'border-border/40 bg-card/70 shadow-black/5',
          )}
        >
          {/* 折叠条（点击展开/收起） */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="group flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-muted/30"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/40 bg-background/70">
              <ListChecksIcon className="size-3.5 shrink-0 text-primary" />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-xs font-semibold text-foreground">任务清单</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
                {done}/{total}
              </span>
              {/* 折叠时显示当前进行项，让用户一眼看到 AI 在做什么 */}
              {!open && currentItem && (
                <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="text-muted-foreground/40">·</span>
                  <Loader2Icon className="size-3 shrink-0 animate-spin text-primary" />
                  <span className="truncate">{currentItem.content}</span>
                </span>
              )}
            </span>
            {/* 进度条（折叠态紧凑显示在文字旁） */}
            <div className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted/60 sm:block">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  allDone
                    ? 'bg-gradient-to-r from-green-500 to-emerald-500'
                    : 'bg-gradient-to-r from-primary to-primary/80',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className={cn(
              'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums',
              allDone
                ? 'border-green-600/30 bg-green-500/10 text-green-600 dark:text-green-400'
                : 'border-primary/30 bg-primary/10 text-primary',
            )}>
              {hasActive ? <Loader2Icon className="size-3 animate-spin" /> : allDone ? <CheckCircle2Icon className="size-3" /> : <CircleIcon className="size-3" />}
              {pct}%
            </span>
            <ChevronUpIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-200', !open && 'rotate-180')} />
          </button>

          {/* 展开明细（向上展开） */}
          {open && (
            <div className="border-t border-border/25 bg-muted/10 px-3.5 py-2.5">
              {/* 顶部进度概览条（展开态） */}
              <div className="mb-2.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/60">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      allDone
                        ? 'bg-gradient-to-r from-green-500 to-emerald-500'
                        : 'bg-gradient-to-r from-primary to-primary/80',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">{pct}%</span>
              </div>
              <ul className="max-h-52 space-y-0.5 overflow-y-auto pr-1">
                {todos.map((t, i) => {
                  const isCurrent = t.status === 'in_progress';
                  return (
                    <li
                      key={i}
                      className={cn(
                        'flex items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                        isCurrent ? 'bg-primary/8' : 'hover:bg-muted/30',
                      )}
                    >
                      <span className="mt-0.5 shrink-0">
                        {t.status === 'completed' ? (
                          <CheckCircle2Icon className="size-3.5 text-green-600 dark:text-green-400" />
                        ) : isCurrent ? (
                          <Loader2Icon className="size-3.5 animate-spin text-primary" />
                        ) : (
                          <CircleIcon className="size-3.5 text-muted-foreground/40" />
                        )}
                      </span>
                      <span
                        className={cn(
                          'min-w-0 flex-1 leading-5',
                          t.status === 'completed'
                            ? 'text-muted-foreground/50 line-through'
                            : isCurrent
                              ? 'font-medium text-foreground'
                              : 'text-muted-foreground',
                        )}
                      >
                        {t.content}
                      </span>
                      <span className={cn('mt-0.5 shrink-0 rounded border px-1 py-0.5 text-[9px] font-medium leading-none', PRIORITY_STYLE[t.priority])}>
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
    </div>
  );
}
