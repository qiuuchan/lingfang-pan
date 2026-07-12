// history.ts —— 把 UI 的 Turn[] 还原成 OpenAI Chat Completions 原生 messages。
//
// betav2 重构核心：改用原生 function calling 历史还原，删掉旧的文本化 workaround
// （creator-adapter.ts 的 partsToAssistantText）。
//
// 原生格式（relay 已确认完整透传，含 OpenAI↔Anthropic 协议转换）：
//  - assistant 调了工具 → { role:'assistant', content: textPart|null, tool_calls: [...] }
//  - 每个工具结果 → { role:'tool', tool_call_id, content }
// 这样模型续跑时能精确读到"我上轮调了 X 工具，结果是 Y"，不必重跑（断点续）。
//
// 注意：tool_calls 与 tool result 必须按 id 配对，且 tool result 必须紧跟在
// 带 tool_calls 的 assistant 消息之后（OpenAI 协议要求）。
import type { ChatMessage, FunctionToolCall } from './types';

/** UI Turn 的工具历史项（从 ToolPart 映射而来，与 CreatorWorkspace 的 TurnPart 对齐）。 */
export interface TurnToolPart {
  type: 'tool';
  toolCallId: string;
  name: string;
  args?: unknown;
  result?: unknown;
  /** 'running' 状态的工具不进历史（未完成，无结果可回灌）。 */
  status: 'running' | 'ok' | 'error';
}

/** UI Turn 的文本项。 */
export interface TurnTextPart {
  type: 'text';
  content: string;
}

/** UI Turn 的可序列化 part（history 只关心 text/tool，reasoning/question 不进历史）。 */
export type HistoryPart = TurnTextPart | TurnToolPart;

/** 输入 Turn 结构（与 CreatorWorkspace 的 Turn 兼容，只取 history 需要的字段）。 */
export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  /** assistant 轮的可选 parts（工具历史）。 */
  parts?: HistoryPart[];
  /** 只有 status==='done' 的 assistant 轮才进历史（generating/failed 的不进）。 */
  status?: string;
}

/**
 * 把 UI turns 还原成 Chat Completions messages（原生 function calling）。
 *
 * @param turns 已发生的对话轮（user/assistant 交替）
 * @param currentInput 本次要发的用户输入（追加到末尾）。重试模式传空串则跳过。
 * @param skipAppendCurrent 重试模式：turns 已含对应 user 轮，不重复追加
 * @returns 完整 messages（不含 system，由调用方在最前面拼）
 */
export function turnsToMessages(
  turns: HistoryTurn[],
  currentInput: string,
  skipAppendCurrent = false,
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.content });
      continue;
    }

    // assistant 轮：只有 done 的才进历史（generating/failed 的不完整）。
    if (turn.status && turn.status !== 'done') continue;

    const parts = turn.parts ?? [];
    const toolParts = parts.filter((p): p is TurnToolPart =>
      p.type === 'tool' && p.status !== 'running',
    );
    const textParts = parts.filter((p): p is TurnTextPart => p.type === 'text');
    // 文本优先取 parts（结构化），兜底取 turn.content（旧数据或无 parts 时）。
    const partsText = textParts.map((p) => p.content).join('').trim();
    const assistantText = partsText || turn.content.trim();

    if (toolParts.length === 0) {
      // 纯文本 assistant 轮。
      if (assistantText) {
        messages.push({ role: 'assistant', content: assistantText });
      }
      continue;
    }

    // 有工具调用的 assistant 轮：拆成 assistant(tool_calls) + 多条 tool result。
    // OpenAI 要求：assistant 的 tool_calls 一次性发出，紧接每条 tool result。
    const toolCalls: FunctionToolCall[] = toolParts.map((p) => ({
      id: p.toolCallId,
      type: 'function',
      function: {
        name: p.name,
        arguments: typeof p.args === 'string' ? p.args : JSON.stringify(p.args ?? {}),
      },
    }));

    messages.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: toolCalls,
    });

    // 每个 tool result 作为独立的 role:'tool' 消息（按 tool_call_id 配对）。
    for (const p of toolParts) {
      const resultContent = typeof p.result === 'string'
        ? p.result
        : JSON.stringify(p.result ?? '');
      messages.push({
        role: 'tool',
        tool_call_id: p.toolCallId,
        content: resultContent,
      });
    }
  }

  if (!skipAppendCurrent && currentInput) {
    messages.push({ role: 'user', content: currentInput });
  }

  return messages;
}
