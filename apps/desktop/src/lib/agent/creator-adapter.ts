// creator-adapter.ts — 把 @openai/agents 的 run() 适配为 FloatingCreator 的 UI 回调。
//
// FloatingCreator 保留现有 parts 渲染结构；本文件只负责把 Agents SDK 的 stream event
// 映射为文本增量、工具卡片、reasoning 卡片和 AskQuestion 人在环卡片。
import { run, type AgentInputItem } from '@openai/agents';
import { buildPluginAgent } from './run';
import { createThinkTagStreamParser } from './think-tags';
import type { AskQuestionArgs, AskQuestionResult, TodoItem } from './tools';
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
  /** 返回上一轮的 todo 清单（跨轮延续）。 */
  getTodos: () => TodoItem[];
  /** TodoWrite 变更后同步给 UI 持久化与渲染。 */
  onTodoUpdate: (todos: TodoItem[]) => void;
  /** 顶部状态条兼容：工具开始/结束。 */
  onToolStart?: (toolName: string, args: unknown) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
}

export interface CreatorAgentInput {
  /**
   * 消息历史。role/content 为扁平文本；assistant 轮可附带 parts（工具调用与结果），
   * 由 turnsToAgentItems 还原成 SDK 的 function_call/function_call_output 序列，
   * 让重试/续跑时模型能看到「上轮已搜过 X、结果如下」而不必重跑工具。
   */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; parts?: AgentMessagePart[] }>;
  tier: 'fast' | 'premium';
  extraInstructions?: string;
  callbacks: CreatorAgentCallbacks;
  signal?: AbortSignal;
}

/** assistant 轮的可序列化工具历史项（从 UI 的 ToolPart 映射而来）。 */
export interface AgentMessagePart {
  type: 'text' | 'tool_call' | 'tool_result';
  /** tool_call/tool_result 共用：工具调用 id（function_call 的 call_id）。 */
  toolCallId?: string;
  /** tool_call：工具名；tool_result：同。 */
  name?: string;
  /** tool_call：入参对象（已解析）；tool_result：返回值字符串。 */
  args?: unknown;
  /** tool_result：工具返回（字符串或对象，序列化为 output）。 */
  output?: unknown;
  /** text：文本内容。 */
  text?: string;
}

function toAgentInputItem(message: CreatorAgentInput['messages'][number]): AgentInputItem {
  if (message.role === 'assistant') {
    // 若带 parts，把工具调用+结果序列化进 assistant 文本内容（而非 function_call 项——
    // 本 SDK 的 aisdk 模型包装器用 Chat Completions 协议，不识别 function_call_output 输入项）。
    // 这样模型续跑时能读到「上轮已搜过 X、结果是 Y」的文本，不必重跑工具（断点续）。
    if (Array.isArray(message.parts) && message.parts.length > 0) {
      const textContent = partsToAssistantText(message.parts, message.content);
      return {
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: textContent }],
      } as AgentInputItem;
    }
    return {
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.content }],
    } as AgentInputItem;
  }
  return { role: message.role, content: message.content } as AgentInputItem;
}

/**
 * 把工具历史 parts 序列化成 assistant 文本（供模型续跑时读取上轮已完成的工作）。
 *
 * 格式（让模型明白这是「我之前做过的」）：
 *   [已调用工具 WebSearch] 入参: {"query":"tauri","limit":8}
 *   [工具返回] 1. Tauri 2.0\n   https://tauri.app ...
 *   （如有文本输出也拼上）
 *
 * 这样重试时模型读到「我已搜过且拿到结果」，直接基于结果继续，不重跑。
 */
function partsToAssistantText(parts: AgentMessagePart[], fallbackContent: string): string {
  const chunks: string[] = [];
  // 工具调用与其结果配对输出；文本 part 直接拼。
  for (const p of parts) {
    if (p.type === 'text' && p.text) {
      chunks.push(p.text);
    } else if (p.type === 'tool_call' && p.name) {
      const argsStr = typeof p.args === 'string' ? p.args : JSON.stringify(p.args ?? {});
      chunks.push(`[已调用工具 ${p.name}] 入参: ${argsStr}`);
    } else if (p.type === 'tool_result' && p.name) {
      const outStr = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      // 截断过长的工具输出，避免撑爆上下文（搜索结果可能很长）。
      const trimmed = outStr.length > 1500 ? outStr.slice(0, 1500) + '…(已截断)' : outStr;
      chunks.push(`[工具 ${p.name} 返回] ${trimmed}`);
    }
  }
  const joined = chunks.join('\n').trim();
  return joined || fallbackContent;
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
  const isError = raw?.status === 'incomplete'
    || (typeof result === 'string'
      // 中文工具错误（「错误：...」）+ SDK 吞成的英文工具错误（defaultToolErrorFunction 输出）。
      // 后者来自 InvalidToolInputError 等 non-fatal 错误，原本会被误判成 ok（绿色卡片静默失败），
      // 这里补匹配，让这类失败也标红可见。
      && (/^错误[:：]/.test(result)
        || /Invalid JSON input for tool/i.test(result)
        || /An error occurred while running the tool/i.test(result)
        || /InvalidToolInputError/i.test(result)));
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
    getTodos: callbacks.getTodos,
    onTodoUpdate: callbacks.onTodoUpdate,
  });
  resetReadTracking();
  const agentMessages = messages.map(toAgentInputItem);

  try {
    const result = await run(agent, agentMessages, {
      stream: true,
      signal,
      // maxTurns: null —— 不限制工具调用轮次。
      // 联网搜索（WebSearch/WebFetch）等探索性任务经常需要多轮（换关键词、抓多个网页、对比），
      // 硬上限会把正常搜索当错误拦截。改为不限轮次，由用户「停止」按钮（AbortController）兜底防失控。
      // SDK 源码：if (state._maxTurns !== null && currentTurn > maxTurns) 才抛 MaxTurnsExceededError，
      // 故传 null 即完全关闭该检查。
      maxTurns: null,
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
          // 多步循环关键修复：tool_called 标志当前 turn 的模型输出已结束，
          // 下一个 turn 会重新输出 <think>...</think>。重置 thinkParser 状态，
          // 避免上一 turn 的 lastClosedReasoning/pendingAfterThinkText 残留
          // 污染下一 turn 的文本分发（这是"思考泄漏到正文"的根因）。
          thinkParser.reset();
          sawRawTextDelta = false;
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
    // 达到工具调用轮次上限：不当作硬错误（联网搜索多轮是正常的），
    // 给出可操作的中文提示。调高了 maxTurns 后这很少触发，仅作失控兜底。
    // SDK 抛 MaxTurnsExceededError（name 于此判定，不依赖未导出的内部类）。
    const isMaxTurns = (e as Error).name === 'MaxTurnsExceededError' || /Max turns \(\d+\) exceeded/i.test((e as Error).message || '');
    if (isMaxTurns) {
      return {
        interrupted: false,
        error: '本次对话步骤较多，已达到单轮处理上限。可点「重试」从上次进度继续，或把任务拆小分多轮完成。',
      };
    }
    return { interrupted: false, error: (e as Error).message || String(e) };
  }
}
