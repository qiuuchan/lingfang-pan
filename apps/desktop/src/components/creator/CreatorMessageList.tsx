// CreatorMessageList.tsx —— 对话区消息列表（链式 parts 渲染）。
//
// 从 FloatingCreator 抽取（betav2 阶段4c）。包含：
//  - turns.map 渲染（user 气泡 / assistant parts 链式）
//  - parts：reasoning 折叠 / text Markdown / tool 工具卡片 / question 提问卡片
//  - 旧数据兜底（无 parts 的单气泡渲染）
//  - 保存成功卡片
//  - 任务清单 TodoPanel
//  - 上下文用量条 + 状态指示条（压缩/搜索/上传）
import { CheckCircle2Icon, EyeIcon, Loader2Icon } from 'lucide-react';
import type { RefObject, Ref } from 'react';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/utils';
import { ToolCallCard } from '@/components/creator/ToolCallCard';
import { TodoPanel } from '@/components/creator/TodoPanel';
import { CreatorCopyButton, CreatorRetryButton } from '@/components/creator/CreatorMessageActions';
import { QuestionCard } from '@/components/creator/QuestionCard';
import { CREATOR_COLUMN_CLASS } from '@/components/creator/creator-layout';
import type { TodoItem } from '@/lib/agent/tools';

// === Part/turn 类型（与 FloatingCreator 内部定义对齐）===

export interface ToolPart {
  type: 'tool';
  toolCallId: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: 'running' | 'ok' | 'error';
}
export interface TextPart { type: 'text'; content: string }
export interface ReasoningPart { type: 'reasoning'; content: string; done?: boolean }
export interface QuestionPart {
  type: 'question';
  toolCallId: string;
  question: string;
  options?: { label: string; value: string }[];
  allowFreeText: boolean;
  multiSelect: boolean;
  answer?: string;
  answered: boolean;
}
export type TurnPart = ToolPart | TextPart | ReasoningPart | QuestionPart;

export interface MessageTurn {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  status?: 'generating' | 'done' | 'failed' | 'cancelled';
  parts?: TurnPart[];
}

// === 组件 ===

export interface CreatorMessageListProps {
  turns: MessageTurn[];
  busy: boolean;
  /** 对话滚动容器 ref（父组件用于自动滚到底）。 */
  scrollRef?: RefObject<HTMLDivElement | null> | React.Ref<HTMLDivElement>;
  /** embedded 模式的内边距调整。 */
  embedded?: boolean;
  /** 思考/提问卡片的作答控制（受控，按 toolCallId 索引）。 */
  answerDrafts: Record<string, string>;
  multiSelectDrafts: Record<string, string[]>;
  /** 任务清单（底部抽屉）。 */
  todos: TodoItem[];
  /** 保存成功后展示的草稿名（null=不显示）。 */
  publishedName: string | null;
  /** 上下文用量（null=不显示用量条）。 */
  contextWindow: number | null;
  usedTokens: number;
  usagePct: number;
  compressHint: string;
  /** 状态指示（任一非空则显示状态条）。 */
  compressing: boolean;
  searchingQuery: string | null;
  uploadingViaTool: boolean;
  /** 作答回调（QuestionCard）。 */
  onAnswer: (turnIdx: number, toolCallId: string, answer: string) => void;
  onAnswerDraftChange: (toolCallId: string, text: string) => void;
  onToggleMultiSelect: (toolCallId: string, value: string) => void;
  onRetry: () => void;
  onOpenContext: () => void;
}

function normalizePart(part: unknown): TurnPart | null {
  if (!part || typeof part !== 'object') return null;
  const raw = part as Record<string, unknown>;
  switch (raw.type) {
    case 'text':
      return { type: 'text', content: typeof raw.content === 'string' ? raw.content : '' };
    case 'reasoning':
      return { type: 'reasoning', content: typeof raw.content === 'string' ? raw.content : '', done: raw.done === true };
    case 'tool':
      return {
        type: 'tool',
        toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : 'legacy',
        name: typeof raw.name === 'string' ? raw.name : 'Tool',
        args: raw.args, result: raw.result,
        status: raw.status === 'ok' || raw.status === 'error' ? raw.status : 'running',
      };
    case 'question':
      return {
        type: 'question',
        toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : 'legacy',
        question: typeof raw.question === 'string' ? raw.question : '请补充信息',
        options: Array.isArray(raw.options)
          ? raw.options.flatMap((o) => {
            if (!o || typeof o !== 'object') return [];
            const item = o as Record<string, unknown>;
            const label = typeof item.label === 'string' ? item.label : '';
            const value = typeof item.value === 'string' ? item.value : label;
            return label ? [{ label, value }] : [];
          })
          : undefined,
        allowFreeText: raw.allowFreeText !== false,
        multiSelect: raw.multiSelect === true,
        answer: typeof raw.answer === 'string' ? raw.answer : undefined,
        answered: raw.answered === true,
      };
    default:
      return null;
  }
}

function cleanParts(parts: unknown): TurnPart[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((p) => normalizePart(p) ?? []);
}

export function CreatorMessageList(props: CreatorMessageListProps) {
  const {
    turns, busy, scrollRef, embedded, answerDrafts, multiSelectDrafts, todos, publishedName,
    contextWindow, usedTokens, usagePct, compressHint,
    compressing, searchingQuery, uploadingViaTool,
    onAnswer, onAnswerDraftChange, onToggleMultiSelect, onRetry, onOpenContext,
  } = props;

  return (
    <div className="min-h-0 flex flex-1 flex-col">
      {/* 对话滚动区 */}
      <div ref={scrollRef as React.Ref<HTMLDivElement>} className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-8 [scrollbar-gutter:stable] sm:px-8', embedded && 'px-6 py-10 lg:px-10')}>
        <div className={cn(CREATOR_COLUMN_CLASS, 'flex flex-col gap-6')}>
          {turns.map((t, i) => (
            <div key={i} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
              {t.role === 'user' ? (
                <div className="group relative max-w-[72%] whitespace-pre-wrap break-words rounded-md bg-[#2a2a2c] px-4 py-2.5 text-sm leading-6 text-[#f0f0f2] shadow-[0_8px_22px_rgba(0,0,0,0.16)]">
                  <CreatorCopyButton text={t.content} className="bg-white/10 text-[#f0f0f2] hover:bg-white/15 hover:text-white" />
                  {t.content}
                </div>
              ) : (
                cleanParts(t.parts).length > 0 ? (
                  <div className="flex w-full flex-col gap-4">
                    {cleanParts(t.parts).map((p, pi) => {
                      if (p.type === 'reasoning') {
                        return (
                          <details key={`r-${pi}`} className="overflow-hidden rounded-xl border border-[#2a2a2c] bg-[#18181a] text-xs shadow-[0_10px_28px_rgba(0,0,0,0.16)]" open={!p.done && t.streaming}>
                            <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 font-mono font-medium text-[#b6b6ba] transition-colors hover:bg-[#202023] hover:text-[#f0f0f2]">
                              {!p.done && t.streaming ? 'Thinking...' : 'Thinking'}
                              {!p.done && t.streaming && <Loader2Icon className="size-2.5 animate-spin" />}
                            </summary>
                            <div className="max-h-44 overflow-y-auto whitespace-pre-wrap break-words border-t border-[#2a2a2c] bg-[#151517] px-4 py-3 pr-5 font-mono text-[11px] leading-6 text-[#d7d7db]">
                              {p.content}
                            </div>
                          </details>
                        );
                      }
                      if (p.type === 'text') {
                        if (!p.content.trim()) return null;
                        return (
                          <div key={`t-${pi}`} className="creator-assistant-bubble group relative overflow-hidden rounded-xl border border-[#2a2a2c] bg-[#18181a] px-5 py-4 text-[15px] leading-7 text-[#e8e8eb] shadow-[0_10px_28px_rgba(0,0,0,0.16)]">
                            <CreatorCopyButton text={p.content} />
                            <div className="break-words">
                              <Markdown>{p.content}</Markdown>
                            </div>
                          </div>
                        );
                      }
                      if (p.type === 'tool') {
                        return <ToolCallCard key={p.toolCallId} data={p} />;
                      }
                      // question part
                      return (
                        <QuestionCard
                          key={p.toolCallId}
                          question={p.question}
                          toolCallId={p.toolCallId}
                          options={p.options}
                          allowFreeText={p.allowFreeText}
                          multiSelect={p.multiSelect}
                          answer={p.answer}
                          answered={p.answered}
                          draftText={answerDrafts[p.toolCallId] ?? ''}
                          selected={multiSelectDrafts[p.toolCallId] ?? []}
                          onAnswer={(answer) => onAnswer(i, p.toolCallId, answer)}
                          onDraftChange={(text) => onAnswerDraftChange(p.toolCallId, text)}
                          onToggleOption={(value) => onToggleMultiSelect(p.toolCallId, value)}
                        />
                      );
                    })}
                    <CreatorRetryButton busy={busy} status={t.status} streaming={t.streaming} onRetry={onRetry} />
                  </div>
                ) : (
                  // 向后兼容 / 兜底：旧会话只有 content 或无任何 part 时，单个气泡渲染。
                  <div className="creator-assistant-bubble group relative w-full overflow-hidden rounded-xl border border-[#2a2a2c] bg-[#18181a] px-5 py-4 text-[15px] leading-7 text-[#e8e8eb] shadow-[0_10px_28px_rgba(0,0,0,0.16)]">
                    {t.content && <CreatorCopyButton text={t.content} />}
                    {t.content ? (
                      <Markdown>{t.content}</Markdown>
                    ) : t.status === 'failed' ? (
                      <span className="text-destructive">调用失败</span>
                    ) : t.status === 'cancelled' ? (
                      <span className="text-muted-foreground">已取消</span>
                    ) : !t.streaming ? (
                      <span className="text-muted-foreground">无内容</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Loader2Icon className="size-3.5 animate-spin" />生成中…</span>
                    )}
                    <CreatorRetryButton busy={busy} status={t.status} streaming={t.streaming} onRetry={onRetry} />
                  </div>
                )
              )}
            </div>
          ))}
        </div>

        {/* 保存成功卡片 */}
        {publishedName && (
          <div className={cn(CREATOR_COLUMN_CLASS, 'mt-8 animate-in fade-in slide-in-from-bottom-4 duration-500')}>
            <div className="flex items-start gap-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-green-600">
                <CheckCircle2Icon className="size-5 text-white" />
              </div>
              <div className="flex-1 space-y-1">
                <div className="font-semibold text-green-900 dark:text-green-100">草稿「{publishedName}」已保存到本地</div>
                <div className="text-sm text-green-800/80 dark:text-green-200/70">已保存到本地插件目录，可在插件中心「我的草稿」查看、运行和发布到团队。点击「+ 新建对话」继续创建下一个插件。</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 任务清单（底部折叠抽屉） */}
      {todos.length > 0 && <TodoPanel todos={todos} streaming={busy} />}

      {/* 上下文用量条 */}
      {contextWindow && turns.length > 0 && (
        <div className="shrink-0 border-t bg-muted/20 px-6 py-2">
          <div className={CREATOR_COLUMN_CLASS}>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="font-mono font-medium">context</span>
              <div className="flex items-center gap-2">
                <span className="font-mono tabular-nums">
                  {usedTokens.toLocaleString()} / {contextWindow.toLocaleString()} tok（{usagePct}%）
                  {compressHint && <span className="ml-1 text-amber-600 dark:text-amber-400">· {compressHint}</span>}
                </span>
                <Button variant="ghost" size="sm" onClick={onOpenContext} className="h-6 gap-1 px-2 text-[10px]">
                  <EyeIcon className="size-3" />
                  查看
                </Button>
              </div>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
              <div className={`h-full rounded-full transition-all duration-300 ${usagePct > 80 ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: `${usagePct}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* 状态指示条（压缩中 / 联网搜索中 / 上传中） */}
      {(compressing || searchingQuery != null || uploadingViaTool) && (
        <div className="shrink-0 border-t bg-muted/20 px-6 py-2.5">
          <div className={cn(CREATOR_COLUMN_CLASS, 'flex items-center gap-2 font-mono text-xs text-[#a6a6ac]')}>
            <Loader2Icon className="size-3.5 animate-spin text-primary" />
            <span>
              {compressing
                ? '正在压缩对话上下文…'
                : searchingQuery != null
                  ? `正在联网搜索：${searchingQuery}…`
                  : 'AI 正在生成插件草稿…'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
