// AssistantChat.tsx — 基于 assistant-ui 的对话显示组件（替换自写 StreamingMessage/Bubble）。
//
// 用 useExternalStoreRuntime 把 LingFang 的 Tauri 事件流数据（turns + liveSegments）
// 适配成 assistant-ui 的 ThreadMessageLike，复用 assistant-ui 的运行时 + 消息状态管理。
// 消息渲染用 useMessage hook 直接读 content parts，按类型分行：
//   reasoning → 思考折叠区，tool-call → 工具卡片，text → Markdown 正文。
//
// 仅替换显示层：onNew 回调复用 PluginCreatorHome 的 send()，会话/draft/预览逻辑不变。

import { useMemo, type ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  useMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { BrainIcon, WrenchIcon, ChevronDownIcon, Loader2Icon } from 'lucide-react';
import { Markdown } from '@/components/markdown';
import { aggregateToolCards } from '@/lib/plugin-draft';

export interface ChatSegment {
  stream: 'stdout' | 'stderr' | 'thought' | 'tool';
  text: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface AssistantChatProps {
  turns: ChatTurn[];
  segments: ChatSegment[];
  streaming: boolean;
  stage?: string;
}

// 把流式 segments 聚合成 assistant-ui content parts。
function segmentsToParts(segments: ChatSegment[]): ThreadMessageLike[] {
  const result: ThreadMessageLike[] = [];
  const thoughtText = segments.filter((s) => s.stream === 'thought').map((s) => s.text).join('');
  if (thoughtText) {
    result.push({
      id: 'live',
      role: 'assistant',
      content: [{ type: 'reasoning', text: thoughtText }],
      status: { type: 'running' },
    } as ThreadMessageLike);
  }
  return result;
}

// 把 LingFang turns + 流式 segments 转成 ThreadMessageLike[]。
function buildMessages(turns: ChatTurn[], segments: ChatSegment[], streaming: boolean): ThreadMessageLike[] {
  const msgs: ThreadMessageLike[] = turns.map((t, i) => {
    const base: ThreadMessageLike = {
      id: `turn-${i}`,
      role: t.role,
      content: [{ type: 'text' as const, text: t.content }],
    };
    // status 仅 assistant 消息支持（user 消息带 status 会触发「status is only supported for assistant messages」）。
    if (t.role === 'assistant') {
      (base as { status?: { type: 'complete'; reason: 'stop' } }).status = { type: 'complete', reason: 'stop' };
    }
    return base;
  });

  // 流式 segments 有内容时：追加一个 assistant message（含 reasoning/tool/text 多 part）。
  // streaming=true 时 status=running（思考自动展开）；streaming=false（本轮结束）时 status=complete
  // （思考折叠保留，不消失）。结束后 turns 里虽有同条 text，但 turns 是 DraftTurn 只存纯文本无 reasoning/tool，
  // 故 segments 必须保留以维持思考/工具的渲染——为避免 text 重复，结束后 segments 的 text part 不再追加
  // （turns 已含），只追加 reasoning/tool。
  if (segments.length > 0) {
    const parts: ThreadMessageLike['content'] extends infer C ? (C extends readonly (infer P)[] ? P[] : never) : never = [];
    const thoughtText = segments.filter((s) => s.stream === 'thought').map((s) => s.text).join('');
    if (thoughtText) parts.push({ type: 'reasoning', text: thoughtText } as never);

    const toolSegments = segments.filter((s) => s.stream === 'tool').map((s) => s.text);
    const toolCards = aggregateToolCards(toolSegments);
    for (const card of toolCards) {
      parts.push({
        type: 'tool-call',
        toolCallId: `${card.name}-${parts.length}`,
        toolName: card.name || '工具',
        argsText: card.inputText || '',
        args: {},
      } as never);
    }

    // text part：流式中追加（live message 是唯一展示处）；结束后不追加（turns 已含 text，避免重复）。
    if (streaming) {
      const stdoutText = segments.filter((s) => s.stream === 'stdout').map((s) => s.text).join('');
      const stderrText = segments.filter((s) => s.stream === 'stderr').map((s) => s.text).join('\n');
      const textText = [stdoutText, stderrText].filter(Boolean).join('\n');
      if (textText) parts.push({ type: 'text', text: textText } as never);
    }

    msgs.push({
      id: 'live',
      role: 'assistant',
      content: parts,
      status: { type: streaming ? 'running' : 'complete', ...(streaming ? {} : { reason: 'stop' }) },
    } as ThreadMessageLike);
  }
  return msgs;
}

export function AssistantChat({ turns, segments, streaming, stage }: AssistantChatProps) {
  const messages = useMemo(() => buildMessages(turns, segments, streaming), [turns, segments, streaming]);

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: streaming,
    onNew: async () => {
      /* 输入框保留现有 Composer，onNew 不处理 */
    },
    convertMessage: (msg) => msg,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full flex-col">
        <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-4 overflow-y-auto px-1 pb-4">
          <ThreadPrimitive.Messages
            components={{
              UserMessage,
              AssistantMessage,
            }}
          />
          {streaming && (
            <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" />
              {stage || '生成中…'}
            </div>
          )}
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

// 用户消息气泡
function UserMessage() {
  const message = useMessage();
  const text = message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
  return (
    <div className="max-w-[82%] self-end rounded-xl bg-primary px-4 py-3 text-sm text-primary-foreground whitespace-pre-wrap break-words">
      {text}
    </div>
  );
}

// assistant 消息：按 content part 类型分行渲染
function AssistantMessage() {
  const message = useMessage();
  const isRunning = message.status?.type === 'running';
  return (
    <div className="max-w-[82%] self-start rounded-xl bg-muted px-4 py-3">
      <span className="mb-1 block text-[11px] opacity-70">AI</span>
      <div className="flex flex-col gap-2">
        {message.content.map((part, i) => {
          if (part.type === 'reasoning') {
            return <ReasoningBlock key={i} text={(part as { text: string }).text} streaming={isRunning} />;
          }
          if (part.type === 'tool-call') {
            const tc = part as { toolName?: string; argsText?: string };
            return <ToolCallBlock key={i} name={tc.toolName || '工具'} argsText={tc.argsText || ''} />;
          }
          if (part.type === 'text') {
            return (
              <div key={i} className="text-sm text-foreground">
                <Markdown>{(part as { text: string }).text.replace(/\n$/, '')}</Markdown>
              </div>
            );
          }
          return null;
        })}
        {message.content.length === 0 && <span className="text-xs text-muted-foreground">等待模型输出…</span>}
      </div>
    </div>
  );
}

// 思考折叠区
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <details open={streaming} className="rounded-lg border border-primary/15 bg-primary/5">
      <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary/80 select-none">
        <BrainIcon className="size-3.5 shrink-0" />
        <span>思考中</span>
        <ChevronDownIcon className="ml-auto size-3.5 shrink-0" />
      </summary>
      <div className="border-t border-primary/10 px-3 py-2">
        <p className="whitespace-pre-wrap break-words font-mono text-xs italic text-muted-foreground">{text.replace(/\n$/, '')}</p>
      </div>
    </details>
  );
}

// 工具调用卡片
function ToolCallBlock({ name, argsText }: { name: string; argsText: string }) {
  return (
    <details className="rounded-lg border bg-background/60 text-xs">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-muted-foreground select-none">
        <WrenchIcon className="size-3.5 shrink-0" />
        <span className="shrink-0 rounded bg-muted px-1 font-mono">{name}</span>
        <ChevronDownIcon className="ml-auto size-3.5 shrink-0" />
      </summary>
      <div className="border-t px-3 py-2">
        {argsText ? (
          <pre className="scrollbar-thin max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-muted-foreground">{argsText}</pre>
        ) : (
          <span className="text-muted-foreground/60">（入参待输出）</span>
        )}
      </div>
    </details>
  );
}
