import * as React from 'react';
import {
  Loader2Icon,
  AlertCircleIcon,
  BrainIcon,
  WrenchIcon,
  ChevronDownIcon,
  HelpCircleIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/markdown';
import {
  aggregateToolCards,
  extractAskUserQuestions,
  formatToolInput,
  type AskUserQuestion,
  type ToolCardView,
} from '@/lib/plugin-draft';

// R3/R5 流式分类渲染：替代旧 LiveProcess 的裸 pre 输出。
// 把流式输出按 stream 类型分为三类，分别用独立区域展示，像 AionUi 那样分类美化：
//   - 思考区（thought）：可折叠，浅色斜体，标题「思考中」，流式增量显示。
//   - 文本区（stdout）：走 Markdown 增量渲染（持续输出），像对话气泡。
//   - 工具区（tool）：每项一张卡片，name + input 摘要；AskUserQuestion 渲染为问题卡片（R4）。
// stderr（诊断）保留为原样行内展示（与思考/工具同级，但归「诊断」标签）。
// 关键约束：thought/tool 的内容绝不进 stdout（阶段1 已在 Rust 侧分流，前端按 stream 字段分发）。

interface StreamingSegment {
  stream: 'stdout' | 'stderr' | 'thought' | 'tool';
  text: string;
}

export interface StreamingMessageProps {
  stage: string;
  segments: StreamingSegment[];
  // 当前是否有 thought 增量到达（驱动 stage 文案 R5：思考阶段 vs 生成阶段）。
  hasThought: boolean;
  // 当前是否有 stdout 增量到达（驱动 stage 文案 R5）。
  hasStdout: boolean;
  // R4 AskUserQuestion：用户选择某个 option 后回调，answer 文本作为下一轮 send_input 传入。
  // 本轮按 --resume 续接（答案当普通文本），tool_use_id 精确关联留后续 stream-json input 升级。
  onAskUserAnswer?: (question: AskUserQuestion, optionLabel: string) => void;
}

export function StreamingMessage({ stage, segments, hasThought, hasStdout, onAskUserAnswer }: StreamingMessageProps) {
  // 思考区：累积所有 thought 增量为一段（流式追加，增量显示）。
  const thoughtText = segments
    .filter((s) => s.stream === 'thought')
    .map((s) => s.text)
    .join('');
  // 文本区：累积所有 stdout 增量（正文，走 Markdown）。
  const stdoutText = segments
    .filter((s) => s.stream === 'stdout')
    .map((s) => s.text)
    .join('');
  // 诊断区：stderr 逐条（保留行内展示，与旧 LiveProcess 一致）。
  const stderrLines = segments.filter((s) => s.stream === 'stderr');
  // 工具区：累积所有 tool 片段聚合为卡片（含 AskUserQuestion）。
  const toolSegments = segments.filter((s) => s.stream === 'tool').map((s) => s.text);
  const toolCards = aggregateToolCards(toolSegments);
  const askQuestions = extractAskUserQuestions(toolCards);

  // R5 stage 文案动态：优先用上层传入的 stage（含启停/降级等场景文案）；
  // 上层未给精确文案时，按当前流类型切换「正在思考中…」/「正在生成…」。
  const dynamicStage = stage || (hasThought && !hasStdout ? '正在思考中…' : hasStdout ? '正在生成…' : '生成中…');

  const hasAnyContent = Boolean(thoughtText || stdoutText || stderrLines.length || toolCards.length);

  return (
    <div className="max-w-[82%] self-start rounded-xl border bg-muted/60 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground/80">
        <Loader2Icon className="size-3.5 animate-spin text-primary" />
        {dynamicStage}
      </div>
      <div className="flex flex-col gap-2">
        {!hasAnyContent && <span className="text-xs text-muted-foreground">等待模型输出…</span>}
        {thoughtText && <ThinkingBlock text={thoughtText} streaming={hasThought && !hasStdout} />}
        {stdoutText && (
          <div className="rounded-lg bg-background/70 px-3 py-2 text-foreground">
            <Markdown>{stdoutText.replace(/\n$/, '')}</Markdown>
          </div>
        )}
        {stderrLines.map((seg, i) => (
          <div key={`err-${i}`} className="flex items-start gap-2 text-xs">
            <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            <span className="shrink-0 rounded bg-amber-500/15 px-1 font-mono text-amber-500">诊断</span>
            <pre className="whitespace-pre-wrap break-words font-mono text-muted-foreground">{seg.text.replace(/\n$/, '')}</pre>
          </div>
        ))}
        {toolCards.map((card, i) => (
          <ToolCard
            key={`tool-${i}`}
            card={card}
            question={askQuestions[i]}
            onAskUserAnswer={onAskUserAnswer}
          />
        ))}
      </div>
    </div>
  );
}

// 思考折叠区（R3）：默认折叠（思考完展开回看），流式中可自动展开。
// 浅色 + 斜体，标题「思考中」配脑图标，点击 header 切换展开/收起。
function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = React.useState(true);
  // 流式中自动展开（持续显示增量），结束后默认收起（减少视觉噪音）。
  React.useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);
  const display = text.replace(/\n$/, '');
  return (
    <div className="rounded-lg border border-primary/15 bg-primary/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary/80"
      >
        <BrainIcon className="size-3.5 shrink-0" />
        <span>思考中</span>
        <ChevronDownIcon className={cn('ml-auto size-3.5 shrink-0 transition-transform', open ? 'rotate-180' : 'rotate-0')} />
      </button>
      {open && (
        <div className="border-t border-primary/10 px-3 py-2">
          <p className="whitespace-pre-wrap break-words font-mono text-xs italic text-muted-foreground">{display}</p>
        </div>
      )}
    </div>
  );
}

// 工具卡片（R3/R4）：普通工具显示 name + input 摘要；AskUserQuestion 渲染问题卡片（每问 header + question + options）。
// 复用 ErrorBubble 的卡片观感（border + 圆角 + 浅底）。
function ToolCard({
  card,
  question,
  onAskUserAnswer,
}: {
  card: ToolCardView;
  question?: AskUserQuestion;
  onAskUserAnswer?: (question: AskUserQuestion, optionLabel: string) => void;
}) {
  // AskUserQuestion：渲染问题卡片（R4），用户点 option 后回传答案。
  if (card.name === 'AskUserQuestion' && question) {
    return (
      <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-primary">
          <HelpCircleIcon className="size-3.5 shrink-0" />
          <span>{question.header || 'AI 想确认一下'}</span>
        </div>
        <p className="mb-2 text-sm text-foreground">{question.question}</p>
        <div className="flex flex-col gap-1.5">
          {question.options.map((opt, idx) => (
            <Button
              key={`${opt.label}-${idx}`}
              variant="outline"
              size="sm"
              className="h-auto justify-start whitespace-normal px-3 py-2 text-left"
              onClick={() => onAskUserAnswer?.(question, opt.label)}
            >
              <span className="font-medium">{opt.label}</span>
              {opt.description && <span className="ml-1 text-xs font-normal text-muted-foreground">— {opt.description}</span>}
            </Button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">本轮答案作为追问文本传入（--resume 续接）。</p>
      </div>
    );
  }
  // 普通工具卡片：name 标签 + input 摘要（JSON pretty 或原文）。
  const inputDisplay = formatToolInput(card.inputText);
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-background/60 px-3 py-2 text-xs">
      <WrenchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 rounded bg-muted px-1 font-mono text-muted-foreground">{card.name || '工具'}</span>
      {inputDisplay ? (
        <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-muted-foreground">{inputDisplay}</pre>
      ) : (
        <span className="text-muted-foreground/60">（入参待输出）</span>
      )}
    </div>
  );
}
