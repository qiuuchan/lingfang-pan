// relay/protocol-convert.ts —— OpenAI ⟷ Anthropic 协议转换。
//
// 背景：桌面创建器用 @ai-sdk/openai（OpenAI 协议）发 /api/relay/v1/chat/completions，
// 按 OpenAI SSE（choices[].delta）解析。但渠道可能是 ANTHROPIC 协议（如公司Claude），
// 上游返回 Anthropic 原生 SSE（content_block_delta/text_delta/tool_use）。若 relay 原样透传，
// OpenAI 解析器读不懂 → 空响应（且工具格式不匹配导致 upstream_error）。
// 本模块在「OpenAI 客户端 → Anthropic 渠道」时做双向转换：请求 OpenAI→Anthropic，响应 Anthropic→OpenAI。

// === 请求：OpenAI chat → Anthropic messages ===

interface OpenAiTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}
interface OpenAiMessage {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
interface AnthropicContentBlock {
  type: string;
  [k: string]: unknown;
}
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

const DEFAULT_MAX_TOKENS = 4096;

/** OpenAI content（string 或多模态数组）→ 提取纯文本（创建器只用文本）。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text ?? '')
          : ''
      )
      .join('');
  }
  return content == null ? '' : String(content);
}

/** 把 OpenAI chat 请求体转为 Anthropic messages 请求体。 */
export function openAiToAnthropicRequest(body: Record<string, unknown>): Record<string, unknown> {
  const srcMessages = (body.messages as OpenAiMessage[] | undefined) ?? [];
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const m of srcMessages) {
    if (m.role === 'system') {
      const t = contentToText(m.content);
      if (t.trim()) systemParts.push(t);
      continue;
    }
    if (m.role === 'tool') {
      // OpenAI 工具结果（role:tool）→ Anthropic 的 user 回合内 tool_result 块。
      // 连续多条 tool 结果合并进同一 user 回合（Anthropic 要求 tool_result 紧跟 assistant 的 tool_use）。
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: contentToText(m.content),
      };
      const last = messages[messages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        messages.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant') {
      // assistant 可能带 tool_calls（OpenAI）→ Anthropic 的 tool_use 块。
      if (m.tool_calls && m.tool_calls.length > 0) {
        const blocks: AnthropicContentBlock[] = [];
        const text = contentToText(m.content);
        if (text.trim()) blocks.push({ type: 'text', text });
        for (const tc of m.tool_calls) {
          let input: unknown = {};
          try {
            input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            input = {};
          }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
        messages.push({ role: 'assistant', content: blocks });
      } else {
        messages.push({ role: 'assistant', content: contentToText(m.content) });
      }
      continue;
    }
    // user（及其它）→ 文本 user 回合。
    messages.push({ role: 'user', content: contentToText(m.content) });
  }

  const out: Record<string, unknown> = {
    model: body.model,
    messages,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : DEFAULT_MAX_TOKENS,
    stream: Boolean(body.stream),
  };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;

  // 工具：OpenAI [{type:function,function:{name,description,parameters}}] → Anthropic [{name,description,input_schema}]。
  const tools = body.tools as OpenAiTool[] | undefined;
  if (tools && tools.length) {
    out.tools = tools
      .filter((t) => t.type === 'function' && t.function?.name)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description ?? '',
        input_schema: t.function.parameters ?? { type: 'object', properties: {} },
      }));
    // tool_choice 映射。
    const tc = body.tool_choice;
    if (tc === 'auto') out.tool_choice = { type: 'auto' };
    else if (tc === 'required') out.tool_choice = { type: 'any' };
    else if (tc && typeof tc === 'object' && 'function' in tc) {
      const name = (tc as { function?: { name?: string } }).function?.name;
      if (name) out.tool_choice = { type: 'tool', name };
    }
    // 'none' → 不设 tool_choice（保留 tools 但不强制；Anthropic 默认 auto）。
  }
  return out;
}

// === 响应：Anthropic → OpenAI ===

/** stop_reason 映射 OpenAI finish_reason。 */
function mapFinishReason(stop: string | null | undefined): string {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anthropic 非流式响应 → OpenAI chat.completion JSON。 */
export function anthropicToOpenAiResponse(
  data: AnthropicResponse,
  createdSec: number
): Record<string, unknown> {
  const blocks = data.content ?? [];
  const textParts: string[] = [];
  const toolCalls: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) textParts.push(b.text);
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id ?? '',
        type: 'function',
        function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
      });
    }
  }
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textParts.join('') || null,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const inTok = data.usage?.input_tokens ?? 0;
  const outTok = data.usage?.output_tokens ?? 0;
  return {
    id: `chatcmpl-${data.id ?? 'anthropic'}`,
    object: 'chat.completion',
    created: createdSec,
    model: data.model ?? 'unknown',
    choices: [{ index: 0, message, finish_reason: mapFinishReason(data.stop_reason) }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

// === 流式：Anthropic SSE 事件 → OpenAI chunk ===

/** 流式转换状态机：把逐个 Anthropic SSE 事件转为零或多个 OpenAI chunk 对象。 */
export class AnthropicStreamToOpenAi {
  private id = 'chatcmpl-stream';
  private model = 'unknown';
  private readonly created: number;
  private roleEmitted = false;
  // Anthropic content block index → OpenAI tool_calls index（仅 tool_use 块占位）。
  private toolIndexByBlock = new Map<number, number>();
  private nextToolIndex = 0;
  private finishReason = 'stop';

  constructor(createdSec: number) {
    this.created = createdSec;
  }

  /** 解析一个完整 SSE 事件块（含 event:/data: 行），返回要下发的 OpenAI chunk 数组。 */
  consume(rawEvent: string): Record<string, unknown>[] {
    let dataLine = '';
    for (const line of rawEvent.split('\n')) {
      const t = line.trim();
      if (t.startsWith('data:')) dataLine = t.slice(5).trim();
    }
    if (!dataLine || dataLine === '[DONE]') return [];
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(dataLine) as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = obj.type as string | undefined;
    const out: Record<string, unknown>[] = [];

    if (type === 'message_start') {
      const msg = obj.message as { id?: string; model?: string } | undefined;
      if (msg?.id) this.id = `chatcmpl-${msg.id}`;
      if (msg?.model) this.model = msg.model;
      if (!this.roleEmitted) {
        this.roleEmitted = true;
        out.push(this.chunk({ role: 'assistant', content: '' }, null));
      }
      return out;
    }

    if (type === 'content_block_start') {
      const idx = obj.index as number;
      const cb = obj.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (cb?.type === 'tool_use') {
        const toolIdx = this.nextToolIndex++;
        this.toolIndexByBlock.set(idx, toolIdx);
        out.push(
          this.chunk(
            {
              tool_calls: [
                {
                  index: toolIdx,
                  id: cb.id ?? '',
                  type: 'function',
                  function: { name: cb.name ?? '', arguments: '' },
                },
              ],
            },
            null
          )
        );
      }
      return out;
    }

    if (type === 'content_block_delta') {
      const idx = obj.index as number;
      const delta = obj.delta as
        { type?: string; text?: string; partial_json?: string } | undefined;
      if (delta?.type === 'text_delta' && delta.text) {
        out.push(this.chunk({ content: delta.text }, null));
      } else if (delta?.type === 'input_json_delta' && delta.partial_json != null) {
        const toolIdx = this.toolIndexByBlock.get(idx) ?? 0;
        out.push(
          this.chunk(
            {
              tool_calls: [{ index: toolIdx, function: { arguments: delta.partial_json } }],
            },
            null
          )
        );
      }
      return out;
    }

    if (type === 'message_delta') {
      const delta = obj.delta as { stop_reason?: string } | undefined;
      if (delta?.stop_reason) this.finishReason = mapFinishReason(delta.stop_reason);
      return out;
    }

    if (type === 'message_stop') {
      out.push(this.chunk({}, this.finishReason));
      return out;
    }
    // content_block_stop / ping 等：无需下发。
    return out;
  }

  /** 构造一个 OpenAI chat.completion.chunk。 */
  private chunk(
    delta: Record<string, unknown>,
    finishReason: string | null
  ): Record<string, unknown> {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }
}
