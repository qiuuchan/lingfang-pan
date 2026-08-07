import { memo } from 'react';
import { CheckCircle2Icon, Loader2Icon, SparklesIcon } from 'lucide-react';
import type { RefObject } from 'react';
import type * as React from 'react';
import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/utils';
import { ToolCallCard } from '@/components/creator/ToolCallCard';
import { TodoPanel } from '@/components/creator/TodoPanel';
import { CreatorCopyButton, CreatorRetryButton } from '@/components/creator/CreatorMessageActions';
import { QuestionCard } from '@/components/creator/QuestionCard';
import { CREATOR_COLUMN_CLASS } from '@/components/creator/creator-layout';
import type { TodoItem } from '@/lib/agent/tools';
import { cleanTurnParts, type Turn } from '@/lib/plugin-creator/creator-session';

export interface CreatorMessageListProps {
  turns: Turn[];
  busy: boolean;
  scrollRef?: RefObject<HTMLDivElement | null> | React.Ref<HTMLDivElement>;
  answerDrafts: Record<string, string>;
  multiSelectDrafts: Record<string, string[]>;
  todos: TodoItem[];
  publishedName: string | null;
  compressing: boolean;
  searchingQuery: string | null;
  uploadingViaTool: boolean;
  onAnswer: (turnIdx: number, toolCallId: string, answer: string) => void;
  onAnswerDraftChange: (toolCallId: string, text: string) => void;
  onToggleMultiSelect: (toolCallId: string, value: string) => void;
  onRetry: () => void;
}

// Markdown 解析 + 高亮较贵，content 字符串不变时直接复用，避免流式期间未变气泡反复重解析。
const MemoMarkdown = memo(function MemoMarkdown({ content }: { content: string }) {
  return <Markdown>{content}</Markdown>;
});

interface TurnBubbleProps {
  turn: Turn;
  turnIndex: number;
  busy: boolean;
  answerDrafts: Record<string, string>;
  multiSelectDrafts: Record<string, string[]>;
  onAnswer: (turnIdx: number, toolCallId: string, answer: string) => void;
  onAnswerDraftChange: (toolCallId: string, text: string) => void;
  onToggleMultiSelect: (toolCallId: string, value: string) => void;
  onRetry: () => void;
}

// 单个会话轮气泡。父级 setTurns 只替换变化轮的对象引用（CreatorWorkspace 各 updater），
// 未变轮保持引用稳定，React.memo 使流式时其它气泡整体跳过重渲染。
const TurnBubble = memo(function TurnBubble({
  turn,
  turnIndex,
  busy,
  answerDrafts,
  multiSelectDrafts,
  onAnswer,
  onAnswerDraftChange,
  onToggleMultiSelect,
  onRetry,
}: TurnBubbleProps) {
  const parts = cleanTurnParts(turn.parts);
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="group relative max-w-[78%] whitespace-pre-wrap break-words rounded-lg bg-muted px-4 py-2.5 pr-9 text-sm leading-6 text-foreground">
          <CreatorCopyButton text={turn.content} />
          {turn.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full items-start gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <SparklesIcon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        {parts.length > 0 ? (
          parts.map((part, partIndex) => {
            if (part.type === 'reasoning') {
              return (
                <details
                  key={`reasoning-${partIndex}`}
                  className="overflow-hidden rounded-lg border border-border/70 bg-muted/25 text-xs"
                  open={!part.done && turn.streaming}
                >
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
                    {!part.done && turn.streaming ? '正在思考' : '思考过程'}
                    {!part.done && turn.streaming && (
                      <Loader2Icon className="size-3 animate-spin" />
                    )}
                  </summary>
                  <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-t border-border/60 px-3 py-3 font-mono text-[11px] leading-6 text-muted-foreground">
                    {part.content}
                  </div>
                </details>
              );
            }
            if (part.type === 'text') {
              if (!part.content.trim()) return null;
              return (
                <div
                  key={`text-${partIndex}`}
                  className="creator-assistant-bubble group relative py-0.5 pr-8 text-[15px] leading-7 text-foreground"
                >
                  <CreatorCopyButton text={part.content} className="top-0" />
                  <div className="break-words">
                    <MemoMarkdown content={part.content} />
                  </div>
                </div>
              );
            }
            if (part.type === 'tool') return <ToolCallCard key={part.toolCallId} data={part} />;
            return (
              <QuestionCard
                key={part.toolCallId}
                question={part.question}
                toolCallId={part.toolCallId}
                options={part.options}
                allowFreeText={part.allowFreeText}
                multiSelect={part.multiSelect}
                answer={part.answer}
                answered={part.answered}
                draftText={answerDrafts[part.toolCallId] ?? ''}
                selected={multiSelectDrafts[part.toolCallId] ?? []}
                onAnswer={(answer) => onAnswer(turnIndex, part.toolCallId, answer)}
                onDraftChange={(text) => onAnswerDraftChange(part.toolCallId, text)}
                onToggleOption={(value) => onToggleMultiSelect(part.toolCallId, value)}
              />
            );
          })
        ) : (
          <div className="creator-assistant-bubble group relative min-h-6 pr-8 text-[15px] leading-7 text-foreground">
            {turn.content && <CreatorCopyButton text={turn.content} className="top-0" />}
            {turn.content ? (
              <MemoMarkdown content={turn.content} />
            ) : turn.status === 'failed' ? (
              <span className="text-destructive">调用失败</span>
            ) : turn.status === 'cancelled' ? (
              <span className="text-muted-foreground">已取消</span>
            ) : !turn.streaming ? (
              <span className="text-muted-foreground">无内容</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" />
                生成中…
              </span>
            )}
          </div>
        )}
        <CreatorRetryButton
          busy={busy}
          status={turn.status}
          streaming={turn.streaming}
          onRetry={onRetry}
        />
      </div>
    </div>
  );
});

export function CreatorMessageList(props: CreatorMessageListProps) {
  const {
    turns,
    busy,
    scrollRef,
    answerDrafts,
    multiSelectDrafts,
    todos,
    publishedName,
    compressing,
    searchingQuery,
    uploadingViaTool,
    onAnswer,
    onAnswerDraftChange,
    onToggleMultiSelect,
    onRetry,
  } = props;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef as React.Ref<HTMLDivElement>}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-8 [scrollbar-gutter:stable] sm:px-7 sm:py-10"
      >
        <div className={cn(CREATOR_COLUMN_CLASS, 'flex flex-col gap-7')}>
          {turns.map((turn, turnIndex) => (
            <TurnBubble
              key={turnIndex}
              turn={turn}
              turnIndex={turnIndex}
              busy={busy}
              answerDrafts={answerDrafts}
              multiSelectDrafts={multiSelectDrafts}
              onAnswer={onAnswer}
              onAnswerDraftChange={onAnswerDraftChange}
              onToggleMultiSelect={onToggleMultiSelect}
              onRetry={onRetry}
            />
          ))}

          {publishedName && (
            <div className="flex items-start gap-3 border-l-2 border-success bg-success/8 px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-4 duration-500">
              <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
              <div>
                <div className="font-medium text-foreground">草稿“{publishedName}”已保存到本地</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                  可在插件中心的草稿页继续运行或发布。
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {todos.length > 0 && <TodoPanel todos={todos} streaming={busy} />}

      {(compressing || searchingQuery != null || uploadingViaTool) && (
        <div className="shrink-0 border-t border-border/70 bg-background/85 px-4 py-2 backdrop-blur-sm sm:px-6">
          <div
            className={cn(
              CREATOR_COLUMN_CLASS,
              'flex items-center gap-2 text-xs text-muted-foreground'
            )}
          >
            <Loader2Icon className="size-3.5 animate-spin text-primary" />
            <span>
              {compressing
                ? '正在压缩对话上下文…'
                : searchingQuery != null
                  ? `正在搜索：${searchingQuery}…`
                  : '正在整理插件草稿…'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
