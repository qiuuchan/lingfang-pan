// creator-adapter.ts — 把 @openai/agents 的 run() 适配为 FloatingCreator 的 UI 回调。
//
// FloatingCreator 保留现有 parts 渲染结构；本文件只负责把 Agents SDK 的 stream event
// 映射为文本增量、工具卡片、reasoning 卡片和 AskQuestion 人在环卡片。
import { run, type AgentInputItem } from '@openai/agents';
import { buildPluginAgent } from './run';
import { createThinkTagStreamParser } from './think-tags';
import type { AskQuestionArgs, AskQuestionResult } from './tools';
import type { StagedPlugin } from '../plugin-creator/creator-tools';

export interface CreatorAgentCallbacks {
  /** 追加文本增量到指定 turn */
  appendTextDelta: (turnIdx: number, delta: string) => void;
  /** 追加思考增量到指定 turn */
  appendReasoningDelta: (turnIdx: number, delta: string) => void;
  /** 标记当前思考段结束。 */
  endReasoning?: (turnIdx: number) => void;
  /** 更新工具调用卡片（call/result） */
  upsertToolPart: (
    turnIdx: number,
    patch: { toolCallId: string; name: string; args?: unknown; result?: unknown; status: 'running' | 'ok' | 'error' },
  ) => void;
  /** 当前正在开发的插件 id（plugins_root/{id}）。 */
  getPluginId: () => string | null;
  /** CreatePlugin 后刷新右侧草稿面板。 */
  onPluginCreated: (pluginId: string, draft: StagedPlugin) => void;
  /** Write/Edit 后刷新右侧草稿面板。 */
  onFilesChanged: () => void;
  /** AskQuestion 人在环提问。 */
  onAskQuestion: (args: AskQuestionArgs, toolCallId: string) => Promise<AskQuestionResult>;
  /** 顶部状态条兼容：工具开始/结束。 */
  onToolStart?: (toolName: string, args: unknown) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
}

export interface CreatorAgentInput {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tier: 'fast' | 'premium';
  extraInstructions?: string;
  callbacks: CreatorAgentCallbacks;
  signal?: AbortSignal;
}

function toAgentInputItem(message: CreatorAgentInput['messages'][number]): AgentInputItem {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.content }],
    } as AgentInputItem;
  }
  return { role: message.role, content: message.content } as AgentInputItem;
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function extractTextDelta(data: unknown): string {
  const d = data as Record<string, any> | null;
  if (!d) return '';
  if (typeof d.textDelta === 'string') return d.textDelta;
  if (typeof d.delta === 'string') return d.delta;
  if (typeof d.text === 'string' && String(d.type ?? '').includes('delta')) return d.text;
  if (d.delta?.type === 'text' && typeof d.delta.text === 'string') return d.delta.text;
  if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') return d.delta;
  return '';
}

function extractMessageText(item: unknown): string {
  const raw = (item as any)?.rawItem ?? item;
  const content = raw?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'output_text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function extractReasoningText(item: unknown): string {
  const raw = (item as any)?.rawItem ?? item;
  const rawContent = Array.isArray(raw?.rawContent) ? raw.rawContent : [];
  const content = Array.isArray(raw?.content) ? raw.content : [];
  return [...rawContent, ...content]
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
}

function toolCallFromItem(item: unknown) {
  const raw = (item as any)?.rawItem ?? item;
  const toolCallId = String(raw?.callId ?? raw?.call_id ?? raw?.id ?? `tool-${Date.now()}`);
  const name = String(raw?.name ?? raw?.function?.name ?? 'Tool');
  const args = parseJsonMaybe(raw?.arguments ?? raw?.function?.arguments ?? {});
  return { toolCallId, name, args };
}

function toolOutputFromItem(item: unknown) {
  const raw = (item as any)?.rawItem ?? item;
  const toolCallId = String(raw?.callId ?? raw?.call_id ?? raw?.id ?? `tool-${Date.now()}`);
  const name = String(raw?.name ?? raw?.function?.name ?? 'Tool');
  const result = parseJsonMaybe(raw?.output ?? (item as any)?.output ?? '');
  const isError = raw?.status === 'incomplete' || (typeof result === 'string' && /^错误[:：]/.test(result));
  return { toolCallId, name, result, status: isError ? 'error' as const : 'ok' as const };
}

/**
 * 运行插件创建 Agent（@openai/agents 框架），流式映射事件到 FloatingCreator 回调。
 * 返回最终状态：{ interrupted: boolean; error?: string }。
 */
export async function runPluginCreatorAgent(input: CreatorAgentInput, turnIdx: number): Promise<{ interrupted: boolean; error?: string }> {
  const { messages, tier, extraInstructions, callbacks, signal } = input;
  const { agent, resetReadTracking } = buildPluginAgent({
    tier,
    extraInstructions,
    getPluginId: callbacks.getPluginId,
    onPluginCreated: callbacks.onPluginCreated,
    onFilesChanged: callbacks.onFilesChanged,
    onAskQuestion: callbacks.onAskQuestion,
  });
  resetReadTracking();
  const agentMessages = messages.map(toAgentInputItem);

  try {
    const result = await run(agent, agentMessages, {
      stream: true,
      signal,
      maxTurns: 8,
    });
    let sawRawTextDelta = false;
    const thinkParser = createThinkTagStreamParser({
      onText: (text) => callbacks.appendTextDelta(turnIdx, text),
      onReasoning: (text) => callbacks.appendReasoningDelta(turnIdx, text),
      onReasoningEnd: () => callbacks.endReasoning?.(turnIdx),
    });

    // 消费流式事件并映射到 FloatingCreator 回调
    for await (const event of result) {
      if (event.type === 'raw_model_stream_event') {
        const delta = extractTextDelta(event.data);
        if (delta) {
          sawRawTextDelta = true;
          thinkParser.feed(delta);
        }
      } else if (event.type === 'run_item_stream_event') {
        const { name, item } = event;
        if (name === 'reasoning_item_created' && item.type === 'reasoning_item') {
          const reasoning = extractReasoningText(item);
          if (reasoning) callbacks.appendReasoningDelta(turnIdx, reasoning);
          callbacks.endReasoning?.(turnIdx);
        } else if (name === 'message_output_created' && item.type === 'message_output_item' && !sawRawTextDelta) {
          const text = extractMessageText(item);
          if (text) thinkParser.feed(text);
        } else if (name === 'tool_called' && item.type === 'tool_call_item') {
          const tool = toolCallFromItem(item);
          callbacks.upsertToolPart(turnIdx, { ...tool, status: 'running' });
          callbacks.onToolStart?.(tool.name, tool.args);
        } else if (name === 'tool_output' && item.type === 'tool_call_output_item') {
          const output = toolOutputFromItem(item);
          callbacks.upsertToolPart(turnIdx, output);
          callbacks.onToolResult?.(output.name, output.result);
        }
      }
    }
    thinkParser.flush();

    // 检查是否有未处理的 interruptions（兜底：用户未作答导致挂起）
    const interruptions = result.interruptions || [];
    if (interruptions.length > 0) {
      return { interrupted: true, error: 'Agent paused for approval, but user did not respond' };
    }

    return { interrupted: false };
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    if (aborted) return { interrupted: false }; // 用户取消不算错误
    return { interrupted: false, error: (e as Error).message || String(e) };
  }
}
