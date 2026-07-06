// loop.ts —— 自建轻量 agent 循环（取代 @openai/agents 的 run()）。
//
// 设计要点（betav2 重构）：
//  - 直接用 OpenAI Chat Completions 协议调 relay（fetch SSE），不经 aisdk 适配层。
//    消灭 creator-adapter 里 4 个脏 helper（extractTextDelta 等的 ?? 兜底）。
//  - 原生 function calling：assistant 消息带 tool_calls + role:'tool' 消息，模型理解最准。
//    relay 已确认完整透传 tools/tool_calls/role:tool（含 OpenAI↔Anthropic 协议转换）。
//  - 多轮循环（软上限 40 轮防失控，替代 maxTurns:null 无刹车）。
//  - <think> 解析复用 think-tags.ts（relay 把 reasoning_content 注入 content 的标签）。
//    每个 model turn 边界 reset thinkParser（复刻 creator-adapter.ts:246 的修复）。
//  - 重试：连接错误（TypeError）由 withRetryFetch 处理；本层补 429/503 指数退避。
//
// 替代的 SDK 代码：run.ts（buildPluginAgent/runAgentStreamed）+ creator-adapter.ts（runPluginCreatorAgent）
// + model.ts（aisdk 适配层）+ tools.ts 的 tool() 工厂依赖。共减少 ~600 行 SDK 胶水。
import { apiBase, getAuthToken } from '@/lib/api';
import { withRetryFetch } from '@/lib/relay-provider';
import { createThinkTagStreamParser } from './think-tags';
import type {
  ChatMessage,
  ChatTool,
  FunctionToolCall,
  LoopCallbacks,
  LoopResult,
  ToolDefinition,
  ToolResult,
} from './types';

/** 软上限：单个 agent run 最多工具调用轮次（防失控，联网搜索多轮仍够用）。 */
const MAX_TURNS = 40;

/** 429/503 重试次数（指数退避 1s/2s，不含首次）。 */
const HTTP_RETRY = 2;

export interface AgentLoopOptions {
  /** 完整 messages（含 system + 历史还原 + 当前 user 输入）。 */
  messages: ChatMessage[];
  /** 工具集（自建 ToolDefinition）。 */
  tools: ToolDefinition[];
  tier: 'fast' | 'premium';
  signal: AbortSignal;
  /** 流式事件回调（写回 UI）。 */
  callbacks: LoopCallbacks;
}

/**
 * 运行 agent 循环：模型输出 → 工具调用 → 结果回灌 → 再输出，直到无工具调用或达上限。
 *
 * 返回 LoopResult。调用方据 status 判定 UI 终态：
 *  - done：正常完成（模型给了最终文本）
 *  - aborted：用户取消（signal abort）
 *  - failed：不可恢复错误（JWT 过期 / 余额不足 / 上游持续失败）
 *  - max_turns：达软上限（给友好提示，非硬错误）
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<LoopResult> {
  const { messages, tools, tier, signal, callbacks } = opts;

  // 把 ToolDefinition 转成 OpenAI tools 参数格式。
  const chatTools: ChatTool[] = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // 工作 messages 副本：循环中追加 assistant(tool_calls) + tool 结果。
  const working: ChatMessage[] = [...messages];

  // 增量拼接中的 tool_calls（带 _index 用于 OpenAI 分片合并，输出时剥离）。
  type PendingCall = FunctionToolCall & { _index: number };
  let toolCallCount = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal.aborted) return { status: 'aborted', toolCallCount };

    // 每个 model turn 用独立的 thinkParser（避免上轮 think 状态泄漏到下轮正文）。
    const thinkParser = createThinkTagStreamParser({
      onText: (text) => callbacks.onTextDelta(text),
      onReasoning: (text) => callbacks.onReasoningDelta(text),
      onReasoningEnd: () => callbacks.onReasoningEnd(),
    });

    let assistantText = '';
    const pendingToolCalls: PendingCall[] = [];
    let hasUsage = false;

    try {
      const streamed = await streamChatCompletion({
        messages: working,
        tools: chatTools,
        tier,
        signal,
        onDelta: (delta) => {
          assistantText += delta;
          thinkParser.feed(delta);
        },
        onToolCallDelta: (calls) => {
          // 增量合并 tool_calls（OpenAI 格式：按 index 分片拼接 id/name/arguments）。
          for (const incoming of calls) {
            const idx = incoming.index;
            const existing = pendingToolCalls.find((c) => c._index === idx);
            if (existing) {
              if (incoming.id) existing.id = incoming.id;
              if (incoming.function?.name) existing.function.name = incoming.function.name;
              if (incoming.function?.arguments != null) {
                existing.function.arguments += incoming.function.arguments;
              }
            } else {
              pendingToolCalls.push({
                _index: idx,
                id: incoming.id ?? `call_${idx}_${Date.now()}`,
                type: 'function',
                function: { name: incoming.function?.name ?? '', arguments: incoming.function?.arguments ?? '' },
              });
            }
          }
        },
        onUsage: () => { hasUsage = true; },
      });
      // 流正常结束：flush thinkParser 残留（未闭合 <think> 等）。
      thinkParser.flush();
      void streamed; // streamed 是最终 assistant text，但 assistantText 已累积，无需用
      void hasUsage;
    } catch (error) {
      thinkParser.flush();
      const err = error as Error;
      // 用户取消：不算错误。
      if (err.name === 'AbortError' || signal.aborted) return { status: 'aborted', toolCallCount };
      // 其他错误：归类返回（重试已在 streamChatCompletion 内部尽力）。
      return { status: 'failed', error: err.message || String(err), toolCallCount };
    }

    // 无工具调用：模型给了最终答案，循环结束。
    // 剥离内部用的 _index 字段，输出标准 FunctionToolCall。
    const finalToolCalls: FunctionToolCall[] = pendingToolCalls.map(({ _index, ...rest }) => {
      void _index;
      return rest;
    });

    if (finalToolCalls.length === 0) {
      return { status: 'done', toolCallCount };
    }

    // 有工具调用：把 assistant（含 tool_calls）追加进 working，然后执行工具。
    working.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: finalToolCalls,
    });

    // 逐个执行工具，结果作为 role:'tool' 消息追加。
    for (const call of finalToolCalls) {
      if (signal.aborted) return { status: 'aborted', toolCallCount };
      toolCallCount++;

      // 解析工具入参（模型 arguments 是 JSON 字符串增量拼成的）。
      let args: unknown = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        // 模型传了畸形 JSON arguments：仍通知工具开始，用空对象执行（工具内部容错）。
        args = {};
      }

      callbacks.onToolCall({ toolCallId: call.id, name: call.function.name, args });

      const def = toolMap.get(call.function.name);
      let result: ToolResult;
      if (!def) {
        result = { ok: false, error: `工具 ${call.function.name} 不存在` };
      } else {
        try {
          result = await def.execute(args, { toolCallId: call.id, signal });
        } catch (e) {
          // 工具 execute 抛错（不应发生，但兜底）：封装为结构化错误。
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }

      callbacks.onToolOutput({
        toolCallId: call.id,
        name: call.function.name,
        result: result.ok ? result.data : result.error,
        ok: result.ok,
      });

      // 工具结果作为 tool message 回灌（role:'tool' + tool_call_id + content）。
      const resultContent = result.ok
        ? typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '')
        : result.error ?? '工具执行失败';
      working.push({ role: 'tool', tool_call_id: call.id, content: resultContent });
    }
    // 继续下一轮：带着工具结果再调模型，让它决定继续调工具还是给最终答案。
  }

  // 达软上限：给友好提示（联网搜索多轮正常，但 40 轮仍不够说明任务过大或失控）。
  return {
    status: 'max_turns',
    error: '本次对话步骤较多，已达到单轮处理上限。可点「重试」从上次进度继续，或把任务拆小分多轮完成。',
    toolCallCount,
  };
}

// === 流式 Chat Completions 客户端（带 tool_calls 解析 + 重试）===

interface StreamOptions {
  messages: ChatMessage[];
  tools: ChatTool[];
  tier: 'fast' | 'premium';
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onToolCallDelta: (calls: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>) => void;
  onUsage: (usage: { promptTokens?: number; completionTokens?: number }) => void;
}

/**
 * 流式调 relay chat completions，解析 content + tool_calls 增量 + usage。
 * 内部带 429/503 指数退避重试（连接错误由 withRetryFetch 处理）。
 * 返回最终 assistant 完整文本。失败抛错（已尽力重试）。
 */
async function streamChatCompletion(opts: StreamOptions): Promise<string> {
  const body = {
    model: opts.tier,
    messages: opts.messages,
    tools: opts.tools.length ? opts.tools : undefined,
    tool_choice: opts.tools.length ? 'auto' : undefined,
    stream: true,
    temperature: 0.4,
    stream_options: { include_usage: true },
  };

  const fetchFn = withRetryFetch(); // 连接级重试（DNS/断连）
  const url = `${apiBase()}/api/relay/v1/chat/completions`;
  const token = getAuthToken();
  if (!token) throw new Error('请先登录');

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= HTTP_RETRY; attempt++) {
    if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');

    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client': 'desktop',
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (e) {
      // fetch 抛错（连接级，withRetryFetch 已重试过）：不可恢复，直接抛。
      throw e;
    }

    if (!res.ok) {
      // 读取 relay 错误体（{code,message}）。
      let detail = `HTTP ${res.status}`;
      let code = '';
      try {
        const err = await res.json();
        detail = err.message || err.code || detail;
        code = err.code || '';
      } catch { /* 忽略 */ }

      // 429 / 503 / 502(upstream_llm_error)：可重试，指数退避。
      const retryable = res.status === 429 || res.status === 503
        || (res.status === 502 && code === 'upstream_llm_error');
      if (retryable && attempt < HTTP_RETRY) {
        lastErr = new Error(detail);
        await sleep(1000 * Math.pow(2, attempt), opts.signal);
        continue;
      }
      // 401（JWT 过期）：不重试，让上层/调用方处理登出。
      // 402（余额不足）：不重试，提示用户。
      throw new Error(detail);
    }

    // 流式响应：解析 SSE。
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      // 非流式降级（relay 有时会降级）：解析一次性响应。
      const data = await res.json();
      const text = extractContent(data);
      if (text) opts.onDelta(text);
      const tcs = extractToolCalls(data);
      if (tcs.length) opts.onToolCallDelta(tcs);
      return text;
    }

    // 真正的 SSE 流解析。
    return consumeSSEStream(res, opts);
  }

  throw lastErr ?? new Error('模型调用失败，已重试多次仍不可达。');
}

/** 消费 SSE 流，解析 content/tool_calls/usage 增量。 */
async function consumeSSEStream(res: Response, opts: StreamOptions): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('无法读取模型响应流');

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  const consumeEvent = (evt: string) => {
    for (const line of evt.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const jsonStr = t.slice(5).trim();
      if (jsonStr === '[DONE]') continue;
      let obj: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
        message?: string;
      };
      try {
        obj = JSON.parse(jsonStr);
      } catch {
        continue;
      }
      // 流中错误（relay 写一个带 error 的 chunk 后接 [DONE]）。
      if (obj.error?.message || obj.message) {
        throw new Error(obj.error?.message || obj.message);
      }
      const delta = obj.choices?.[0]?.delta;
      if (delta?.content) {
        fullText += delta.content;
        opts.onDelta(delta.content);
      }
      if (delta?.tool_calls?.length) {
        opts.onToolCallDelta(delta.tool_calls);
      }
      if (obj.usage) {
        opts.onUsage({ promptTokens: obj.usage.prompt_tokens, completionTokens: obj.usage.completion_tokens });
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const evt = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        consumeEvent(evt);
      }
    }
    if (buffer.trim()) consumeEvent(buffer);
  } catch (error) {
    // 流读取中抛错：可能是 abort（用户取消）或网络中断。
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  return fullText;
}

/** 非流式响应提取 content。 */
function extractContent(data: unknown): string {
  const obj = data as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = obj.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

/** 非流式响应提取 tool_calls（转成增量回调期望的格式，index 用序号占位）。 */
function extractToolCalls(data: unknown): Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> {
  const obj = data as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
    }>;
  };
  const calls = obj.choices?.[0]?.message?.tool_calls ?? [];
  return calls.map((c, i) => ({ index: i, id: c.id, function: c.function }));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }
  });
}
