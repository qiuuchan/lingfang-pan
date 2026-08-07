// TodoPanel —— Agent 任务清单（底部折叠抽屉样式）。
//
// 配合 TodoWrite 工具：模型调用 TodoWrite 后，todo 经 callbacks.onTodoUpdate 同步到这里。
// 默认折叠为底部一条窄横条（显示进度概要），点击向上展开明细列表。
// 钉在对话区底部（不占对话滚动空间），类似 IDE 底部状态栏的折叠抽屉。
// 纯展示组件（不可编辑——状态由模型驱动，用户只看进度），与 ToolCallCard 风格一致。
import { useState } from 'react';
import {
  ChevronUpIcon,
  Loader2Icon,
  CheckCircle2Icon,
  CircleIcon,
  ListChecksIcon,
} from 'lucide-react';
import type { TodoItem } from '@/lib/agent/tools';
import { cn } from '@/lib/utils';
import { CREATOR_COLUMN_CLASS } from '@/components/creator/creator-layout';

const PRIORITY_STYLE: Record<TodoItem['priority'], string> = {
  high: 'border-destructive/40 bg-destructive/10 text-destructive',
  medium: 'border-warning/40 bg-warning/10 text-warning',
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
    <div className="shrink-0 px-5 py-4 sm:px-8 lg:px-10">
      <div className={CREATOR_COLUMN_CLASS}>
        <div className="overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm">
          {/* 折叠条（点击展开/收起） */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted text-muted-foreground">
              <ListChecksIcon className="size-4 shrink-0" />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-sm font-semibold text-foreground">任务清单</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {done}/{total}
              </span>
              {/* 折叠时显示当前进行项，让用户一眼看到 AI 在做什么 */}
              {!open && currentItem && (
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span>·</span>
                  <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
                  <span className="truncate">{currentItem.content}</span>
                </span>
              )}
            </span>
            {/* 进度条（折叠态紧凑显示在文字旁） */}
            <div className="hidden h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted sm:block">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  allDone ? 'bg-success' : 'bg-primary'
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[11px] font-semibold tabular-nums',
                allDone
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-border bg-muted text-foreground'
              )}
            >
              {hasActive ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : allDone ? (
                <CheckCircle2Icon className="size-3.5" />
              ) : (
                <CircleIcon className="size-3.5" />
              )}
              {pct}%
            </span>
            <ChevronUpIcon
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
                !open && 'rotate-180'
              )}
            />
          </button>

          {/* 展开明细（向上展开） */}
          {open && (
            <div className="border-t border-border/70 bg-muted/15 px-4 py-4">
              {/* 顶部进度概览条（展开态） */}
              <div className="mb-2.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      allDone ? 'bg-success' : 'bg-primary'
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                  {pct}%
                </span>
              </div>
              <ul className="max-h-60 space-y-1 overflow-y-auto pr-3">
                {todos.map((t, i) => {
                  const isCurrent = t.status === 'in_progress';
                  return (
                    <li
                      key={i}
                      className={cn(
                        'flex items-start gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                        isCurrent ? 'bg-accent' : 'hover:bg-accent/60'
                      )}
                    >
                      <span className="mt-0.5 shrink-0">
                        {t.status === 'completed' ? (
                          <CheckCircle2Icon className="size-4 text-success" />
                        ) : isCurrent ? (
                          <Loader2Icon className="size-4 animate-spin text-primary" />
                        ) : (
                          <CircleIcon className="size-4 text-muted-foreground" />
                        )}
                      </span>
                      <span
                        className={cn(
                          'min-w-0 flex-1 leading-6',
                          t.status === 'completed'
                            ? 'text-muted-foreground line-through'
                            : isCurrent
                              ? 'font-medium text-foreground'
                              : 'text-foreground/80'
                        )}
                      >
                        {t.content}
                      </span>
                      <span
                        className={cn(
                          'mt-0.5 shrink-0 rounded border px-1 py-0.5 text-[9px] font-medium leading-none',
                          PRIORITY_STYLE[t.priority]
                        )}
                      >
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
