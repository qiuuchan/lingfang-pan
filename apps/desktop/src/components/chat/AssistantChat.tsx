import { useMemo, type ReactNode } from 'react';
import {
  AlertCircleIcon,
  BrainIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  HelpCircleIcon,
  Loader2Icon,
  MessageSquareTextIcon,
  CircleIcon,
  WrenchIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/markdown';
import { formatToolInput, type AskUserQuestion } from '@/lib/plugin-draft';
import { cn } from '@/lib/utils';
import {
  buildChatOutputItems,
  type ChatOutputItem,
  type ChatSegment,
  type ChatTurn,
} from './chat-output-model';

interface AssistantChatProps {
  turns: ChatTurn[];
  segments: ChatSegment[];
  streaming: boolean;
  stage?: string;
  onAskUserAnswer?: (question: AskUserQuestion, optionLabel: string) => void;
  askAnswering?: boolean;
}

export function AssistantChat({
  turns,
  segments,
  streaming,
  stage,
  onAskUserAnswer,
  askAnswering = false,
}: AssistantChatProps) {
  const items = useMemo(() => buildChatOutputItems(turns, segments, streaming), [turns, segments, streaming]);

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <ChatOutputItemView
          key={item.id}
          item={item}
          askAnswering={askAnswering}
          onAskUserAnswer={onAskUserAnswer}
        />
      ))}
      {items.length === 0 && <span className="px-1 text-xs text-muted-foreground">等待模型输出…</span>}
      {streaming && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" />
          {stage || '生成中…'}
        </div>
      )}
    </div>
  );
}

function ChatOutputItemView({
  item,
  askAnswering,
  onAskUserAnswer,
}: {
  item: ChatOutputItem;
  askAnswering: boolean;
  onAskUserAnswer?: (question: AskUserQuestion, optionLabel: string) => void;
}) {
  switch (item.type) {
    case 'user':
      return <UserBubble text={item.text} />;
    case 'reasoning':
      return <ReasoningBlock item={item} />;
    case 'assistant-text':
      return <AssistantTextBlock text={item.text} live={item.live} />;
    case 'diagnostic':
      return <DiagnosticBlock text={item.text} />;
    case 'tool':
      return <ToolBlock item={item} askAnswering={askAnswering} onAskUserAnswer={onAskUserAnswer} />;
    case 'progress':
      return <ProgressBlock item={item} />;
    default:
      return null;
  }
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[82%] self-end rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground whitespace-pre-wrap break-words">
      {text}
    </div>
  );
}

function AssistantTextBlock({ text, live }: { text: string; live: boolean }) {
  return (
    <div className="max-w-[86%] self-start border-l border-border/80 pl-3 text-foreground">
      <OutputLabel icon={<MessageSquareTextIcon className="size-3.5" />} text={live ? 'AI 正在回复' : 'AI 回复'} />
      <div className="mt-1.5 text-sm leading-7">
        <Markdown>{text}</Markdown>
      </div>
    </div>
  );
}

function ReasoningBlock({ item }: { item: Extract<ChatOutputItem, { type: 'reasoning' }> }) {
  return (
    <details
      className="group max-w-[86%] self-start border-l border-primary/30 pl-3"
    >
      <summary className="flex cursor-pointer items-center gap-2 py-1.5 text-xs font-medium text-primary/80 select-none">
        <BrainIcon className="size-3.5 shrink-0" />
        <span>{item.live ? 'AI 正在思考' : 'AI 思考'}</span>
        <span className="min-w-0 flex-1 truncate font-normal text-primary/55">{compactPreview(item.text)}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="py-2">
        <p className="whitespace-pre-wrap break-words font-mono text-xs italic text-muted-foreground">{item.text}</p>
      </div>
    </details>
  );
}

function DiagnosticBlock({ text }: { text: string }) {
  return (
    <div className="max-w-[86%] self-start border-l border-amber-500/40 pl-3 text-xs">
      <OutputLabel icon={<AlertCircleIcon className="size-3.5" />} text="检查结果" tone="warning" />
      <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-muted-foreground">{text}</pre>
    </div>
  );
}

function ProgressBlock({ item }: { item: Extract<ChatOutputItem, { type: 'progress' }> }) {
  const done = item.status === 'done';
  return (
    <div className="flex max-w-[86%] items-start gap-2 self-start pl-0.5 text-xs text-muted-foreground">
      {done ? (
        <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-primary" />
      ) : (
        <CircleIcon className={cn('mt-1 size-2.5 shrink-0', item.live ? 'fill-primary text-primary' : 'text-muted-foreground/60')} />
      )}
      <span className={cn('min-w-0 break-words leading-5', done && 'text-foreground/80')}>{item.title}</span>
    </div>
  );
}

function ToolBlock({
  item,
  askAnswering,
  onAskUserAnswer,
}: {
  item: Extract<ChatOutputItem, { type: 'tool' }>;
  askAnswering: boolean;
  onAskUserAnswer?: (question: AskUserQuestion, optionLabel: string) => void;
}) {
  if (item.questions.length > 0) {
    return <QuestionToolBlock item={item} askAnswering={askAnswering} onAskUserAnswer={onAskUserAnswer} />;
  }
  const inputDisplay = formatToolInput(item.argsText);
  return (
    <details className="group max-w-[86%] self-start border-l border-border/80 pl-3 text-xs">
      <summary className="flex cursor-pointer items-center gap-2 py-1.5 text-muted-foreground select-none">
        <WrenchIcon className="size-3.5 shrink-0" />
        <span className="shrink-0">工具调用</span>
        <span className="min-w-0 truncate font-mono text-foreground/80">{item.name}</span>
        <ChevronDownIcon className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="py-2">
        {inputDisplay ? (
          <pre className="scrollbar-thin max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2 font-mono text-muted-foreground">{inputDisplay}</pre>
        ) : (
          <span className="text-muted-foreground/60">入参待输出</span>
        )}
      </div>
    </details>
  );
}

function QuestionToolBlock({
  item,
  askAnswering,
  onAskUserAnswer,
}: {
  item: Extract<ChatOutputItem, { type: 'tool' }>;
  askAnswering: boolean;
  onAskUserAnswer?: (question: AskUserQuestion, optionLabel: string) => void;
}) {
  return (
    <div className="max-w-[86%] self-start border-l border-primary/40 pl-3">
      <OutputLabel icon={<HelpCircleIcon className="size-3.5" />} text={item.name || '工具调用'} tone="primary" />
      <div className="mt-2 divide-y divide-primary/10">
        {item.questions.map((question, index) => (
          <QuestionBlock
            key={`${question.question}-${index}`}
            question={question}
            askAnswering={askAnswering}
            onAskUserAnswer={onAskUserAnswer}
          />
        ))}
      </div>
    </div>
  );
}

function QuestionBlock({
  question,
  askAnswering,
  onAskUserAnswer,
}: {
  question: AskUserQuestion;
  askAnswering: boolean;
  onAskUserAnswer?: (question: AskUserQuestion, optionLabel: string) => void;
}) {
  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <p className="text-xs font-medium text-primary">{question.header || 'AI 想确认一下'}</p>
      <p className="mt-1 text-sm text-foreground">{question.question}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        {question.options.map((option, index) => (
          <Button
            key={`${option.label}-${index}`}
            variant="outline"
            size="sm"
            disabled={askAnswering}
            className="h-auto justify-start whitespace-normal px-3 py-2 text-left"
            onClick={() => onAskUserAnswer?.(question, option.label)}
          >
            <span className="font-medium">{option.label}</span>
            {option.description && <span className="ml-1 text-xs font-normal text-muted-foreground">{option.description}</span>}
          </Button>
        ))}
      </div>
      {askAnswering && <p className="mt-1.5 text-[11px] text-muted-foreground">提交中…</p>}
    </div>
  );
}

function OutputLabel({
  icon,
  text,
  tone = 'muted',
}: {
  icon: ReactNode;
  text: string;
  tone?: 'muted' | 'primary' | 'warning';
}) {
  return (
    <div className={cn('flex items-center gap-1.5 text-xs font-medium', labelToneClass(tone))}>
      {icon}
      <span>{text}</span>
    </div>
  );
}

function compactPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function labelToneClass(tone: 'muted' | 'primary' | 'warning'): string {
  if (tone === 'primary') return 'text-primary';
  if (tone === 'warning') return 'text-amber-500';
  return 'text-muted-foreground';
}
