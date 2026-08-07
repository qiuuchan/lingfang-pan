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
import { readRelayErrorDetail, withRetryFetch } from '@/lib/relay-provider';
import { createThinkTagStreamParser } from './think-tags';
import { estimateMessagesTokens } from './token-estimate';
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

/**
 * 连续截断早终止阈值：模型 tool_call 的 arguments 因上游 max_tokens 被截断
 * （finish_reason='length'）时，loop.ts 会回灌分块提示让模型改用 Write + Edit 追加。
 * 但模型对大附件常未正确分块，整段重写再次截断，循环到 MAX_TURNS 才报 max_turns。
 * 连续达此阈值即直接 failed 返回，给用户可重试的清晰错误，而非空转到 40 轮。
 */
const MAX_CONSECUTIVE_TRUNCATIONS = 3;

export interface AgentLoopOptions {
  /** 完整 messages（含 system + 历史还原 + 当前 user 输入）。 */
  messages: ChatMessage[];
  /** 工具集（自建 ToolDefinition）。 */
  tools: ToolDefinition[];
  tier: 'fast' | 'premium';
  signal: AbortSignal;
  /** 流式事件回调（写回 UI）。 */
  callbacks: LoopCallbacks;
  /** 输入 token 预算（contextWindow - 输出预留）。每轮调模型前检查 working 是否超预算，
   *  超则就地压缩（丢最早历史，保留首条 system + 末尾含工具配对的近期消息）。
   *  不传则不做运行时护栏（依赖调用方/后端兜底）。 */
  contextBudget?: number;
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
  const { messages, tools, tier, signal, callbacks, contextBudget } = opts;

  // 把 ToolDefinition 转成 OpenAI tools 参数格式。
  const chatTools: ChatTool[] = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // 工作 messages 副本：循环中追加 assistant(tool_calls) + tool 结果。
  const working: ChatMessage[] = [...messages];

  /**
   * 运行时输入护栏：working 超过 contextBudget 时就地压缩。
   * 策略：保留首条 system + 末尾消息（从尾部往前累加到预算内），中间最早的历史被丢弃，
   *      插一条「[运行中历史压缩] 已省略 N 条早期消息」system 消息提示模型。
   * 安全约束（不破坏 function calling 配对）：
   *  - 保留区的第一条不能是 role:'tool'（否则无对应 tool_calls 配对 → 上游 400）。
   *    压缩后若开头是孤立的 tool result，继续向前丢弃直到遇到非 tool 消息。
   *  - 不拆 assistant(tool_calls) + 紧随的 role:tool 组（从尾部累加时天然成组保留）。
   * 这是软护栏：若单条消息就超预算（极端情况），仍照发（让后端 relay 兜底返回友好错误）。
   */
  function enforceContextBudget(): void {
    if (!contextBudget || contextBudget <= 0) return;
    const used = estimateMessagesTokens(working);
    if (used <= contextBudget) return;

    const total = working.length;
    // 从尾部累加消息，直到累加 token 达到预算（留余量给 system 注入）。
    const RESERVE_FOR_NOTICE = 50; // 注入提示消息的预留 token
    const target = contextBudget - RESERVE_FOR_NOTICE;
    let acc = 0;
    let keepFrom = total; // 保留区起点（含）
    for (let i = total - 1; i >= 0; i--) {
      const t = estimateMessagesTokens([working[i]]);
      if (acc + t > target && i < total - 1) {
        keepFrom = i + 1;
        break;
      }
      acc += t;
      keepFrom = i;
    }
    // 保留区起点不能是孤立的 role:'tool'（无前置 assistant(tool_calls)）——向前跳过。
    while (
      keepFrom < total &&
      working[keepFrom].role === 'tool' &&
      // keepFrom 之前没有 assistant(tool_calls) 与之配对（被压缩掉了）
      !(
        keepFrom > 0 &&
        working[keepFrom - 1].role === 'assistant' &&
        'tool_calls' in working[keepFrom - 1]
      )
    ) {
      keepFrom++;
    }

    const droppedHead = keepFrom; // 0..keepFrom-1 被丢弃
    if (droppedHead <= 1) return; // 没东西可压（或只剩首条）—— 照发，交后端兜底

    // 保留首条 system（通常是主 system prompt，不能丢）+ 注入提示 + 保留区。
    const head = working[0];
    const hasHeadSystem = head && head.role === 'system';
    const notice: ChatMessage = {
      role: 'system',
      content: `[运行中历史压缩] 已省略 ${droppedHead - (hasHeadSystem ? 1 : 0)} 条较早的对话/工具消息以适应上下文上限。近期工作完整保留。`,
    };
    const kept = working.slice(keepFrom);
    working.length = 0;
    if (hasHeadSystem) working.push(head, notice, ...kept);
    else working.push(notice, ...kept);

    console.warn(
      `[agent] context budget guardrail triggered: ${used} → ~${estimateMessagesTokens(working)} tokens (dropped ${droppedHead} early messages)`
    );
  }

  // 增量拼接中的 tool_calls（带 _index 用于 OpenAI 分片合并，输出时剥离）。
  type PendingCall = FunctionToolCall & { _index: number };
  let toolCallCount = 0;
  // 连续截断计数：finish_reason='length' +1，非截断轮清零；达阈值直接 failed 返回。
  let consecutiveTruncations = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal.aborted) return { status: 'aborted', toolCallCount };

    // 输入护栏：每轮调模型前检查 working 是否超预算，超则就地压缩（保工具配对完整）。
    enforceContextBudget();

    // 每个 model turn 用独立的 thinkParser（避免上轮 think 状态泄漏到下轮正文）。
    const thinkParser = createThinkTagStreamParser({
      onText: (text) => callbacks.onTextDelta(text),
      onReasoning: (text) => callbacks.onReasoningDelta(text),
      onReasoningEnd: () => callbacks.onReasoningEnd(),
    });

    let assistantText = '';
    const pendingToolCalls: PendingCall[] = [];
    let hasUsage = false;

    let streamed: StreamResult | null = null;
    try {
      streamed = await streamChatCompletion({
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
                function: {
                  name: incoming.function?.name ?? '',
                  arguments: incoming.function?.arguments ?? '',
                },
              });
            }
          }
        },
        onUsage: () => {
          hasUsage = true;
        },
      });
      // 流正常结束：flush thinkParser 残留（未闭合 <think> 等）。
      thinkParser.flush();
    } catch (error) {
      thinkParser.flush();
      const err = error as Error;
      // 用户取消：不算错误。
      if (err.name === 'AbortError' || signal.aborted) return { status: 'aborted', toolCallCount };
      // 其他错误：归类返回（重试已在 streamChatCompletion 内部尽力）。
      return { status: 'failed', error: err.message || String(err), toolCallCount };
    }

    // 检测上游 max_tokens 截断（finish_reason='length'）。
    // 此时 tool_calls 的 arguments 必然不完整（JSON 被切断），不能执行。
    // 回灌明确错误让模型分块重试（如先 Write 部分内容，再 Edit 追加）。
    if (streamed && streamed.finishReason === 'length' && pendingToolCalls.length > 0) {
      consecutiveTruncations++;
      // 连续截断早终止：模型对大附件常未正确分块，整段重写再次截断，会循环到 MAX_TURNS。
      // 达阈值直接 failed 返回，给用户可重试的清晰错误，而非空转到 40 轮。
      if (consecutiveTruncations >= MAX_CONSECUTIVE_TRUNCATIONS) {
        return {
          status: 'failed',
          error: `工具调用连续 ${consecutiveTruncations} 次因长度限制被截断，已停止以避免空转。可点「重试」从上次进度继续，或把附件内容拆小后重试。`,
          toolCallCount,
        };
      }
      const truncatedCall = pendingToolCalls[0];
      callbacks.onToolCall({
        toolCallId: truncatedCall.id,
        name: truncatedCall.function.name,
        args: { _truncated: true, receivedChars: truncatedCall.function.arguments.length },
      });
      const truncErr = `输出因长度限制被截断（已收到 ${truncatedCall.function.arguments.length} 字符的参数，JSON 不完整）。请把文件内容拆成更小的块：先 Write 文件的前半部分，再用 Edit 逐步追加后续内容，每次不超过 6000 字符。`;
      callbacks.onToolOutput({
        toolCallId: truncatedCall.id,
        name: truncatedCall.function.name,
        result: truncErr,
        ok: false,
      });
      // 把截断的工具调用（标记为失败）+ 错误回灌进 working，让模型看到并分块重试。
      working.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: pendingToolCalls.map(({ _index, ...rest }) => {
          void _index;
          return rest;
        }),
      });
      working.push({ role: 'tool', tool_call_id: truncatedCall.id, content: truncErr });
      // 清空 pendingToolCalls，跳过下面的工具执行段，直接进入下一轮循环。
      pendingToolCalls.length = 0;
      continue;
    }

    // 非截断轮：重置连续截断计数（模型本轮按分块指引正常输出了）。
    consecutiveTruncations = 0;

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
      const rawArgs = call.function.arguments;
      let args: Record<string, unknown> = {};
      let parseError: string | null = null;
      if (rawArgs) {
        try {
          args = JSON.parse(rawArgs) as Record<string, unknown>;
        } catch (e) {
          // arguments 拼接后非法 JSON：可能是流式分片没拼全，或模型传了畸形 JSON。
          // 关键修复（betav2）：不能静默 fallback 到 {} 再执行——那会让工具收到空参数
          // （表现为 path=undefined），模型却以为成功了。必须把错误回灌给模型，
          // 让它看到"参数解析失败"并重试传入完整参数。
          parseError = `参数解析失败（收到 ${rawArgs.length} 字符的非法 JSON）：${e instanceof Error ? e.message : String(e)}`;
          console.warn('[agent] tool arguments parse failed', {
            tool: call.function.name,
            argsLength: rawArgs.length,
            argsHead: rawArgs.slice(0, 200),
          });
        }
      }

      callbacks.onToolCall({ toolCallId: call.id, name: call.function.name, args });

      let result: ToolResult;
      if (parseError) {
        // 参数解析失败：不执行工具，把错误回灌让模型重试。
        result = { ok: false, error: parseError };
      } else {
        const def = toolMap.get(call.function.name);
        if (!def) {
          result = { ok: false, error: `工具 ${call.function.name} 不存在` };
        } else {
          try {
            result = await def.execute(args, { toolCallId: call.id, signal });
          } catch (e) {
            result = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
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
        ? typeof result.data === 'string'
          ? result.data
          : JSON.stringify(result.data ?? '')
        : (result.error ?? '工具执行失败');
      working.push({ role: 'tool', tool_call_id: call.id, content: resultContent });
    }
    // 继续下一轮：带着工具结果再调模型，让它决定继续调工具还是给最终答案。
  }

  // 达软上限：给友好提示（联网搜索多轮正常，但 40 轮仍不够说明任务过大或失控）。
  return {
    status: 'max_turns',
    error:
      '本次对话步骤较多，已达到单轮处理上限。可点「重试」从上次进度继续，或把任务拆小分多轮完成。',
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
  onToolCallDelta: (
    calls: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
  ) => void;
  onUsage: (usage: { promptTokens?: number; completionTokens?: number }) => void;
}

/**
 * 流式调 relay chat completions，解析 content + tool_calls 增量 + usage。
 * 内部带 429/503 指数退避重试（连接错误由 withRetryFetch 处理）。
 * 返回最终 assistant 完整文本。失败抛错（已尽力重试）。
 */
async function streamChatCompletion(opts: StreamOptions): Promise<StreamResult> {
  const body = {
    model: opts.tier,
    messages: opts.messages,
    tools: opts.tools.length ? opts.tools : undefined,
    tool_choice: opts.tools.length ? 'auto' : undefined,
    stream: true,
    temperature: 0.4,
    // max_tokens：不传时上游用默认值（Anthropic 默认仅 4096），
    // 大文件工具调用的 arguments JSON 很容易超限被截断（表现为
    // "Unterminated string at position N"）。设 16384 足够覆盖
    // 大段源码的单次工具调用输出，避免 arguments 被上游 token 限制切断。
    max_tokens: 16_384,
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
      // 读取 relay 错误体。fetch 包了 withRetryFetch：它会先把 relay 原生 {code,message}
      // 翻译成 OpenAI {error:{message}} 供 @ai-sdk/openai 解析。此前这里读顶层
      // err.message（OpenAI 格式里不存在）→ detail 回落为 "HTTP 400"，真实根因被吞。
      // readRelayErrorDetail 兼容翻译后（OpenAI）与原始（relay）两种格式，并透传上游根因。
      const rawBody = await res.text().catch(() => '');
      const { detail, code } = readRelayErrorDetail(res.status, rawBody);

      // 429 / 503 / 502(upstream_llm_error)：可重试，指数退避。
      const retryable =
        res.status === 429 ||
        res.status === 503 ||
        (res.status === 502 && code === 'upstream_llm_error');
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
      return { text, finishReason: 'stop' };
    }

    // 真正的 SSE 流解析。
    return consumeSSEStream(res, opts);
  }

  throw lastErr ?? new Error('模型调用失败，已重试多次仍不可达。');
}

/** 流式响应结果：文本 + 上游停止原因（'length'=max_tokens 截断，'tool_calls'/'stop'=正常）。 */
interface StreamResult {
  text: string;
  finishReason: string;
}

/** 消费 SSE 流，解析 content/tool_calls/usage/finish_reason 增量。 */
async function consumeSSEStream(res: Response, opts: StreamOptions): Promise<StreamResult> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('无法读取模型响应流');

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let finishReason = '';

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
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
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
      // 捕获 finish_reason（流结束时上游告知停止原因）。
      // 'length' = 因 max_tokens 截断（arguments 可能不完整）；
      // 'tool_calls'/'stop' = 正常结束。
      const fr = obj.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
      if (obj.usage) {
        opts.onUsage({
          promptTokens: obj.usage.prompt_tokens,
          completionTokens: obj.usage.completion_tokens,
        });
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
  return { text: fullText, finishReason };
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
function extractToolCalls(
  data: unknown
): Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> {
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
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true }
      );
    }
  });
}
