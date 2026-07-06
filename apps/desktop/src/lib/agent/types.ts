// types.ts —— Agent 系统共享类型（自建循环用，取代 @openai/agents 的类型）。
//
// 这是 betav2 重构的核心类型层：
// - ChatMessage：OpenAI Chat Completions 原生消息格式（含 tool_calls / role:'tool'），
//   直接发给 relay，不再文本化。
// - ToolDefinition / ToolResult：自建轻量工具格式，execute 体内逻辑与 SDK 无关。
// - LoopCallbacks：循环事件回调，由 store 实现，写回 UI。

/** 工具调用项（assistant 消息的 tool_calls 数组元素，OpenAI 标准）。 */
export interface FunctionToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI Chat Completions 原生消息格式。
 *  - system/user/assistant：content 为字符串
 *  - assistant + tool_calls：content 可为 null（纯工具调用无文本）或字符串（文本 + 工具）
 *  - tool：必须有 tool_call_id + content（工具返回）
 * relay 完整透传给上游，原生 function calling，不再文本化（删 partsToAssistantText）。 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: FunctionToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** OpenAI tools 参数格式（传给 relay 的 tools 数组）。 */
export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

/** 工具执行上下文（自建循环注入，替代 SDK 的 runContext）。 */
export interface ToolContext {
  /** 本次工具调用的 id（assistant tool_calls[].id），用于 HITL 关联与结果回灌。 */
  toolCallId: string;
  /** 当前 agent 循环的中止信号，工具内部可据此取消长操作。 */
  signal: AbortSignal;
}

/** 工具执行结果（结构化，替代字符串嗅探）。
 *  - ok:true → data 序列化为 tool message content 回灌模型
 *  - ok:false → error 作为 tool message content（模型可读到失败原因并修复） */
export interface ToolResult {
  ok: boolean;
  /** ok 时的返回值（字符串或可序列化对象；对象会被 JSON.stringify）。 */
  data?: unknown;
  /** !ok 时的错误说明（中文，给模型+用户看）。 */
  error?: string;
}

/** 自建轻量工具定义（取代 @openai/agents 的 tool() 工厂）。
 *  execute 体内逻辑与 SDK 无关，只做业务（tauriInvoke/api 等）。 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema（OpenAI function calling parameters）。可直接手写或从 zod 转。 */
  parameters: Record<string, unknown>;
  /** 执行工具。返回结构化结果，不抛错（错误封装进 ToolResult.error 让模型可见）。 */
  execute: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

/** Agent 循环事件回调（store 实现这些，把流式事件写回 UI）。 */
export interface LoopCallbacks {
  /** 文本增量（正文，已剥离 <think> 标签）。 */
  onTextDelta: (delta: string) => void;
  /** 思考增量（<think> 标签内的内容）。 */
  onReasoningDelta: (delta: string) => void;
  /** 当前思考段结束（</think> 或 turn 边界）。 */
  onReasoningEnd: () => void;
  /** 工具调用开始（模型决定调某工具，UI 显示 running 卡片）。 */
  onToolCall: (call: { toolCallId: string; name: string; args: unknown }) => void;
  /** 工具执行完成（UI 卡片更新为 ok/error）。 */
  onToolOutput: (output: { toolCallId: string; name: string; result: unknown; ok: boolean }) => void;
}

/** Agent 循环运行结果。 */
export interface LoopResult {
  status: 'done' | 'aborted' | 'failed' | 'max_turns';
  /** status !== 'done' 时的错误说明（中文）。 */
  error?: string;
  /** 本次循环执行的工具调用次数（含失败）。 */
  toolCallCount: number;
}
