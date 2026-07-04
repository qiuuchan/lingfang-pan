// TodoPanel —— Agent 任务清单（底部折叠抽屉样式）。
//
// 配合 TodoWrite 工具：模型调用 TodoWrite 后，todo 经 callbacks.onTodoUpdate 同步到这里。
// 默认折叠为底部一条窄横条（显示进度概要），点击向上展开明细列表。
// 钉在对话区底部（不占对话滚动空间），类似 IDE 底部状态栏的折叠抽屉。
// 纯展示组件（不可编辑——状态由模型驱动，用户只看进度），与 ToolCallCard 风格一致。
import { useState } from 'react';
import {
  ChevronUpIcon, Loader2Icon, CheckCircle2Icon, CircleIcon, ListChecksIcon,
} from 'lucide-react';
import type { TodoItem } from '@/lib/agent/tools';
import { cn } from '@/lib/utils';
import { CREATOR_COLUMN_CLASS } from '@/components/creator/creator-layout';

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
    <div className="shrink-0 px-5 py-4 sm:px-8 lg:px-10">
      <div className={CREATOR_COLUMN_CLASS}>
        <div
          className={cn(
            'overflow-hidden rounded-xl border shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-colors duration-200',
            open
              ? 'border-[#2a2a2c] bg-[#18181a]'
              : 'border-[#2a2a2c] bg-[#18181a]',
          )}
        >
          {/* 折叠条（点击展开/收起） */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[#202023]"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[#303034] bg-[#202023]">
              <ListChecksIcon className="size-4 shrink-0 text-[#d9d9dd]" />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-sm font-semibold text-[#f0f0f2]">任务清单</span>
              <span className="shrink-0 font-mono text-xs text-[#b8b8bd]">
                {done}/{total}
              </span>
              {/* 折叠时显示当前进行项，让用户一眼看到 AI 在做什么 */}
              {!open && currentItem && (
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-[#c4c4c8]">
                  <span className="text-[#5a5a5c]">·</span>
                  <Loader2Icon className="size-3.5 shrink-0 animate-spin text-[#f0f0f2]" />
                  <span className="truncate">{currentItem.content}</span>
                </span>
              )}
            </span>
            {/* 进度条（折叠态紧凑显示在文字旁） */}
            <div className="hidden h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-[#2a2a2c] sm:block">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  allDone ? 'bg-[#e5e5e5]' : 'bg-[#d9d9dd]',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[11px] font-semibold tabular-nums',
              allDone
                ? 'border-[#6f6f75]/50 bg-[#2a2a2c] text-[#e5e5e5]'
                : 'border-[#6f6f75]/50 bg-[#2a2a2c] text-[#f5f5f7]',
            )}>
              {hasActive ? <Loader2Icon className="size-3.5 animate-spin" /> : allDone ? <CheckCircle2Icon className="size-3.5" /> : <CircleIcon className="size-3.5" />}
              {pct}%
            </span>
            <ChevronUpIcon className={cn('size-4 shrink-0 text-[#8d8d92] transition-transform duration-200', !open && 'rotate-180')} />
          </button>

          {/* 展开明细（向上展开） */}
          {open && (
            <div className="border-t border-[#2a2a2c] bg-[#151517] px-4 py-4">
              {/* 顶部进度概览条（展开态） */}
              <div className="mb-2.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#2a2a2c]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      allDone ? 'bg-[#e5e5e5]' : 'bg-[#d9d9dd]',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="shrink-0 font-mono text-[11px] text-[#b8b8bd] tabular-nums">{pct}%</span>
              </div>
              <ul className="max-h-60 space-y-1 overflow-y-auto pr-3">
                {todos.map((t, i) => {
                  const isCurrent = t.status === 'in_progress';
                  return (
                    <li
                      key={i}
                      className={cn(
                        'flex items-start gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                        isCurrent ? 'bg-[#202023]' : 'hover:bg-[#202023]',
                      )}
                    >
                      <span className="mt-0.5 shrink-0">
                        {t.status === 'completed' ? (
                          <CheckCircle2Icon className="size-4 text-[#e5e5e5]" />
                        ) : isCurrent ? (
                          <Loader2Icon className="size-4 animate-spin text-[#f0f0f2]" />
                        ) : (
                          <CircleIcon className="size-4 text-[#6f7076]" />
                        )}
                      </span>
                      <span
                        className={cn(
                          'min-w-0 flex-1 leading-6',
                          t.status === 'completed'
                            ? 'text-[#a0a0a3] line-through'
                            : isCurrent
                              ? 'font-medium text-[#f0f0f2]'
                              : 'text-[#c4c4c8]',
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
