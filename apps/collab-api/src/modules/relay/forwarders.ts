// relay/forwarders.ts —— OpenAI / Anthropic 协议转发器（fetch 直连上游，SSE 流式透传）。
//
// 设计（见 docs/billing-and-relay-design.md §4）：
//  - 用原生 fetch 而非 vendor SDK：relay/proxy 的标准做法（one-api/openai-forward 同款），
//    利于 SSE 流式透传（response.body 直接 pipe，不经 SDK 抽象层），且零新依赖。
//  - 非流式：解析 JSON 取 usage；流式：透传 SSE chunk + 解析末尾 usage（OpenAI 的
//    stream_options.include_usage / Anthropic message_delta.usage）。
//  - 上游 key 仅作请求头临时使用，绝不记日志（pino redact 已覆盖 authorization 头）。
//  - 失败：抛 UpstreamError携带 httpStatus/errorCode，RelayService 据此故障转移/退款/记日志。
import type { Response as ExpressResponse } from 'express';
import { openAiToAnthropicRequest, anthropicToOpenAiResponse, AnthropicStreamToOpenAi } from './protocol-convert';

/** 上游错误（relay 据此故障转移到下一候选 + 记日志）。 */
export class UpstreamError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
    public readonly body?: string,
  ) {
    super(message);
  }
}

/** 一次转发的结果（统一 shape：chat 返回 tokens，image 返回 images）。 */
export interface ForwardResult {
  inputTokens: number;
  outputTokens: number;
  images: number;
}

const UPSTREAM_TIMEOUT_MS = 60_000; // 上游超时 60s（含 chat 流式）：超时即 abort，防日志卡 pending。

/** 通用上游 fetch（带超时）。 */
async function upstreamFetch(url: string, init: RequestInit): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 抛 UpstreamError（4xx/5xx），附 body 摘要供日志诊断。 */
async function ensureOk(res: globalThis.Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  const summary = text.slice(0, 500);
  throw new UpstreamError(res.status, `上游返回 ${res.status}`, summary);
}

// === OpenAI 协议（/v1/chat/completions） ===

interface OpenAiChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [k: string]: unknown;
}

/** 转发 OpenAI chat completions。流式时把上游 SSE 透传给 express res，并解析末尾 usage。 */
export async function forwardOpenAiChat(args: {
  baseUrl: string;
  upstreamKey: string;
  body: OpenAiChatRequest;
  res: ExpressResponse;
}): Promise<ForwardResult> {
  // 流式请求强制要求末尾 usage chunk（计费必需）。
  const payload: OpenAiChatRequest = { ...args.body };
  if (payload.stream) {
    (payload as Record<string, unknown>).stream_options = { include_usage: true };
  }
  const url = `${args.baseUrl}/chat/completions`;
  const res = args.res;
  const upstream = await upstreamFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.upstreamKey}`,
      ...(payload.stream ? { Accept: 'text/event-stream' } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    // 流式与非流式错误统一抛：relay 据此故障转移。
    const text = await upstream.text().catch(() => '');
    throw new UpstreamError(upstream.status, `上游返回 ${upstream.status}`, text.slice(0, 500));
  }

  if (payload.stream) {
    // 归一化 reasoning：部分上游（阶跃星辰/DeepSeek 系）用非标准 delta.reasoning_content 发思考内容，
    // @ai-sdk/openai 的 chat 解析器不认该字段会丢弃 → 前端思考框收不到内容。
    // 故在透传时把 reasoning 增量改写成 <think>…</think> 包裹的 content，前端用 extractReasoningMiddleware 提取。
    return pipeOpenAiSseNormalizingReasoning(upstream, res);
  }
  // 非流式：转发 JSON，解析 usage。同时把 message.reasoning_content 归一化进 content（<think> 包裹）。
  const data = (await upstream.json()) as {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    choices?: { message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }[];
  };
  normalizeNonStreamReasoning(data);
  res.status(200).json(data);
  return {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    images: 0,
  };
}

/** 非流式：把 choices[].message.reasoning_content 前置为 <think>…</think> 合入 content（与流式归一化对称）。 */
function normalizeNonStreamReasoning(data: {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }[];
}): void {
  for (const choice of data.choices ?? []) {
    const msg = choice.message;
    if (!msg) continue;
    const reasoning = msg.reasoning_content ?? msg.reasoning;
    if (reasoning && reasoning.trim()) {
      msg.content = `<think>${reasoning}</think>${msg.content ?? ''}`;
    }
    // 删除非标准字段，避免下游困惑（content 已携带思考）。
    delete msg.reasoning_content;
    delete msg.reasoning;
  }
}

// === OpenAI 协议（/v1/images/generations） ===

interface OpenAiImageRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  [k: string]: unknown;
}

/** 转发生图。按张计费（n 张），透传 JSON 响应。 */
export async function forwardOpenAiImage(args: {
  baseUrl: string;
  upstreamKey: string;
  body: OpenAiImageRequest;
  res: ExpressResponse;
}): Promise<ForwardResult> {
  const url = `${args.baseUrl}/images/generations`;
  const upstream = await upstreamFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.upstreamKey}` },
    body: JSON.stringify(args.body),
  });
  await ensureOk(upstream);
  const data = (await upstream.json()) as { data?: unknown[] };
  args.res.status(200).json(data);
  return { inputTokens: 0, outputTokens: 0, images: Math.max(1, args.body.n ?? 1) };
}

/**
 * 透传 multipart/raw 请求体到上游（如 OpenAI /v1/images/edits：图片编辑需 multipart 上传）。
 * 不解析 body，原样转发 Content-Type + 原始字节；按响应 data 数量计费（图片张数）。
 * relay 计费按张：count = max(1, 响应 data 长度)。
 */
export async function forwardRawPassthrough(args: {
  baseUrl: string;
  upstreamKey: string;
  path: string; // 上游路径后缀（如 images/edits）
  method: string;
  contentType: string;
  rawBody: Buffer;
  res: ExpressResponse;
}): Promise<ForwardResult> {
  const url = `${args.baseUrl}/${args.path.replace(/^\//, '')}`;
  const upstream = await upstreamFetch(url, {
    method: args.method,
    headers: { 'Content-Type': args.contentType, Authorization: `Bearer ${args.upstreamKey}` },
    body: new Uint8Array(args.rawBody),
  });
  await ensureOk(upstream);
  // 尝试解析 JSON 取图片数；非 JSON（少见）默认按 1 张。
  let images = 1;
  const text = await upstream.text();
  try {
    const data = JSON.parse(text) as { data?: unknown[] };
    images = Math.max(1, data.data?.length ?? 1);
    args.res.status(200).json(data);
  } catch {
    args.res.status(200).send(text);
  }
  return { inputTokens: 0, outputTokens: 0, images };
}

// === Anthropic 协议（/v1/messages） ===

interface AnthropicMessagesRequest {
  model: string;
  messages: { role: string; content: string }[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  [k: string]: unknown;
}

/** 转发 Anthropic messages。流式透传 + 末尾解析 usage（message_delta.usage）。 */
export async function forwardAnthropicMessages(args: {
  baseUrl: string;
  upstreamKey: string;
  body: AnthropicMessagesRequest;
  res: ExpressResponse;
}): Promise<ForwardResult> {
  const url = `${args.baseUrl}/v1/messages`;
  const upstream = await upstreamFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': args.upstreamKey,
      'anthropic-version': '2023-06-01',
      ...(args.body.stream ? { Accept: 'text/event-stream' } : {}),
    },
    body: JSON.stringify(args.body),
  });
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    throw new UpstreamError(upstream.status, `上游返回 ${upstream.status}`, text.slice(0, 500));
  }
  if (args.body.stream) {
    return pipeSseAndExtractUsage(upstream, args.res, parseAnthropicUsage);
  }
  const data = (await upstream.json()) as { usage?: { input_tokens?: number; output_tokens?: number } };
  args.res.status(200).json(data);
  return {
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    images: 0,
  };
}

// === OpenAI 客户端 → Anthropic 渠道（协议转换） ===

/**
 * OpenAI chat 请求 → Anthropic 上游 → OpenAI 响应。
 * 用于「桌面 @ai-sdk/openai 客户端」命中「ANTHROPIC 协议渠道」的场景：
 * 请求体 OpenAI→Anthropic，响应（流式 SSE / 非流式 JSON）Anthropic→OpenAI，
 * 使客户端的 OpenAI 解析器能正确读到 text/tool_calls（修复空响应 + 工具不可用）。
 */
export async function forwardOpenAiChatViaAnthropic(args: {
  baseUrl: string;
  upstreamKey: string;
  body: OpenAiChatRequest;
  res: ExpressResponse;
}): Promise<ForwardResult> {
  const stream = Boolean(args.body.stream);
  const anthropicBody = openAiToAnthropicRequest(args.body as Record<string, unknown>);
  const url = `${args.baseUrl}/v1/messages`;
  const upstream = await upstreamFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': args.upstreamKey,
      'anthropic-version': '2023-06-01',
      ...(stream ? { Accept: 'text/event-stream' } : {}),
    },
    body: JSON.stringify(anthropicBody),
  });
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    throw new UpstreamError(upstream.status, `上游返回 ${upstream.status}`, text.slice(0, 500));
  }

  const createdSec = Math.floor(Date.now() / 1000);
  if (stream) {
    return pipeAnthropicSseAsOpenAi(upstream, args.res, createdSec);
  }
  // 非流式：Anthropic JSON → OpenAI chat.completion JSON。
  const data = (await upstream.json()) as { usage?: { input_tokens?: number; output_tokens?: number } };
  const openai = anthropicToOpenAiResponse(data as never, createdSec);
  args.res.status(200).json(openai);
  return {
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    images: 0,
  };
}

/**
 * 读取 Anthropic 上游 SSE，逐事件转成 OpenAI chat.completion.chunk 下发，末尾补 [DONE]。
 * 同时解析 usage（message_start.input_tokens + message_delta.output_tokens）供计费。
 */
async function pipeAnthropicSseAsOpenAi(
  upstream: globalThis.Response,
  res: ExpressResponse,
  createdSec: number,
): Promise<ForwardResult> {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const usage: ForwardResult = { inputTokens: 0, outputTokens: 0, images: 0 };
  const converter = new AnthropicStreamToOpenAi(createdSec);
  const reader = upstream.body?.getReader();
  if (!reader) { res.write('data: [DONE]\n\n'); res.end(); return usage; }
  const decoder = new TextDecoder();
  let buffer = '';
  const handleEvent = (evt: string) => {
    // usage 解析（与 parseAnthropicUsage 同源逻辑，避免重复扫描这里内联）。
    const u = parseAnthropicUsage(evt);
    if (u) {
      if (u.inputTokens) usage.inputTokens = u.inputTokens;
      if (u.outputTokens) usage.outputTokens = u.outputTokens;
    }
    for (const chunk of converter.consume(evt)) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
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
        if (evt.trim()) handleEvent(evt);
      }
    }
    if (buffer.trim()) handleEvent(buffer);
    res.write('data: [DONE]\n\n');
  } catch (error) {
    // 流式传输过程中出错：在 SSE 流中写入 OpenAI 格式的错误事件，而非直接中断。
    // 这样前端 Vercel AI SDK 能正确解析到错误消息，避免空响应兜底掩盖真实原因。
    const errMsg = error instanceof Error ? error.message : String(error);
    const errorChunk = {
      id: 'chatcmpl-error',
      object: 'chat.completion.chunk',
      created: createdSec,
      model: 'unknown',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      error: { message: errMsg, type: 'upstream_error', code: 'stream_error' },
    };
    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
  } finally {
    reader.releaseLock?.();
    res.end();
  }
  return usage;
}

// === SSE 透传 + reasoning 归一化 + usage 解析 ===

/**
 * OpenAI 协议流式归一化：把上游 SSE 的 delta.reasoning_content (非标准,DeepSeek/StepFun) 改写为
 * `<think>...</think>` 包裹的 content 增量，供前端 extractReasoningMiddleware 提取。同时解析 usage。
 * 用于修复：上游用 reasoning_content 发送思考内容 → @ai-sdk/openai 不认 → 前端思考框空白。
 *
 * 关键：思考须是**单个连续块**（<think>全部思考</think>正文），故用状态机——
 * 首个 reasoning 增量前置 <think>，后续直接拼文本，首个正文增量前补 </think> 闭合。
 */
async function pipeOpenAiSseNormalizingReasoning(
  upstream: globalThis.Response,
  res: ExpressResponse,
): Promise<ForwardResult> {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let usage: ForwardResult = { inputTokens: 0, outputTokens: 0, images: 0 };
  let inThinking = false; // 已发 <think> 未闭合
  const reader = upstream.body?.getReader();
  if (!reader) { res.end(); return usage; }
  const decoder = new TextDecoder();
  let buffer = '';
  const handleEvent = (evt: string) => {
    const { out, nextInThinking } = normalizeEventReasoning(evt, inThinking);
    inThinking = nextInThinking;
    res.write(out);
    const parsed = parseOpenAiUsage(evt);
    if (parsed) usage = { ...usage, ...parsed };
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
        if (evt.trim()) handleEvent(evt);
      }
    }
    if (buffer.trim()) handleEvent(buffer);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errorChunk = {
      id: 'chatcmpl-error', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'unknown',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      error: { message: errMsg, type: 'upstream_error', code: 'stream_error' },
    };
    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
  } finally {
    reader.releaseLock?.();
    res.end();
  }
  return usage;
}

/**
 * 归一化单个 SSE 事件（状态机）：
 * - reasoning 增量：首段前置 `<think>`（inThinking=true），后续直接拼文本，写入 delta.content。
 * - 正文增量：若 inThinking，先补 `</think>` 闭合再拼正文（inThinking=false）。
 * - finish/结束事件：若仍 inThinking，把 </think> 补在 delta.content 前闭合。
 * 返回改写后的 SSE 文本 + 新的 inThinking 状态。
 */
export function normalizeEventReasoning(rawEvent: string, inThinking: boolean): { out: string; nextInThinking: boolean } {
  let dataLine: string | null = null;
  for (const line of rawEvent.split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) { dataLine = t.slice(5).trim(); break; }
  }
  // 结束标记：若思考未闭合，补一个 </think> 的 content chunk 再 [DONE]。
  if (dataLine === '[DONE]') {
    if (inThinking) {
      const closeChunk = { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '</think>' }, finish_reason: null }] };
      return { out: `data: ${JSON.stringify(closeChunk)}\n\ndata: [DONE]\n\n`, nextInThinking: false };
    }
    return { out: `${rawEvent}\n\n`, nextInThinking: inThinking };
  }
  if (!dataLine) return { out: `${rawEvent}\n\n`, nextInThinking: inThinking };

  let obj: {
    choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }; finish_reason?: string | null }[];
  };
  try { obj = JSON.parse(dataLine); } catch { return { out: `${rawEvent}\n\n`, nextInThinking: inThinking }; }

  const choice = obj.choices?.[0];
  const delta = choice?.delta;
  // 收尾 chunk（带 finish_reason，delta 缺失或为空）：若思考未闭合，先补 </think> content chunk。
  const deltaEmpty = !delta || (delta.content == null && delta.reasoning_content == null && delta.reasoning == null);
  if (inThinking && choice?.finish_reason && deltaEmpty) {
    const closeChunk = { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '</think>' }, finish_reason: null }] };
    return { out: `data: ${JSON.stringify(closeChunk)}\n\n${rawEvent}\n\n`, nextInThinking: false };
  }
  if (!delta) {
    return { out: `${rawEvent}\n\n`, nextInThinking: inThinking };
  }

  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (reasoning && reasoning.trim()) {
    // reasoning 增量 → content，首段前置 <think>。
    delta.content = (inThinking ? '' : '<think>') + reasoning;
    delete delta.reasoning_content;
    delete delta.reasoning;
    return { out: `data: ${JSON.stringify(obj)}\n\n`, nextInThinking: true };
  }

  // 正文增量：若思考未闭合，先补 </think>。
  if (inThinking && delta.content != null && delta.content !== '') {
    delta.content = `</think>${delta.content}`;
    // 顺带清理可能并存的空 reasoning 字段。
    delete delta.reasoning_content;
    delete delta.reasoning;
    return { out: `data: ${JSON.stringify(obj)}\n\n`, nextInThinking: false };
  }

  // 其它（role chunk、空 delta 等）：清理非标准字段后原样下发。
  if (delta.reasoning_content != null || delta.reasoning != null) {
    delete delta.reasoning_content;
    delete delta.reasoning;
    return { out: `data: ${JSON.stringify(obj)}\n\n`, nextInThinking: inThinking };
  }
  return { out: `${rawEvent}\n\n`, nextInThinking: inThinking };
}

// === SSE 透传 + usage 解析 ===

/**
 * 把上游 SSE body 逐 chunk 透传给 express res，同时扫描 chunk 提取 usage（最后一个带 usage 的事件）。
 * 调用方需已设置 SSE 响应头。流式传输过程中如遇错误，在 SSE 流中写入错误事件，而非直接中断。
 */
async function pipeSseAndExtractUsage(
  upstream: globalThis.Response,
  res: ExpressResponse,
  usageParser: (rawEvent: string) => { inputTokens: number; outputTokens: number } | null,
): Promise<ForwardResult> {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 透传 OpenAI/Anthropic 末尾标记，客户端据此知道流结束。
  res.flushHeaders?.();

  let usage: ForwardResult = { inputTokens: 0, outputTokens: 0, images: 0 };
  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return usage;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      // 透传原始字节给客户端（保持协议完整性）。
      res.write(chunk);
      // 扫描完整事件（双换行分隔），提取 usage。
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const evt = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = usageParser(evt);
        if (parsed) usage = { ...usage, ...parsed };
      }
    }
    // flush 余量
    if (buffer) res.write(buffer);
  } catch (error) {
    // 流式传输过程中出错：在 SSE 流中写入 OpenAI 格式的错误事件。
    const errMsg = error instanceof Error ? error.message : String(error);
    const errorChunk = {
      id: 'chatcmpl-error',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'unknown',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      error: { message: errMsg, type: 'upstream_error', code: 'stream_error' },
    };
    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
  } finally {
    reader.releaseLock?.();
    res.end();
  }
  return usage;
}

/** 解析 OpenAI SSE 事件的 usage（data: {...usage...}）。 */
function parseOpenAiUsage(rawEvent: string): { inputTokens: number; outputTokens: number } | null {
  for (const line of rawEvent.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const jsonStr = t.slice(5).trim();
    if (jsonStr === '[DONE]') continue;
    try {
      const obj = JSON.parse(jsonStr) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (obj.usage) {
        return {
          inputTokens: obj.usage.prompt_tokens ?? 0,
          outputTokens: obj.usage.completion_tokens ?? 0,
        };
      }
    } catch {
      // 忽略非 JSON 行
    }
  }
  return null;
}

/** 解析 Anthropic SSE 的 message_delta / message_start usage。 */
function parseAnthropicUsage(rawEvent: string): { inputTokens: number; outputTokens: number } | null {
  for (const line of rawEvent.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try {
      const obj = JSON.parse(t.slice(5).trim()) as {
        type?: string;
        message?: { usage?: { input_tokens?: number } };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      // message_start 携带 input_tokens；message_delta 携带累计 output_tokens。
      if (obj.message?.usage?.input_tokens != null) {
        return { inputTokens: obj.message.usage.input_tokens, outputTokens: 0 };
      }
      if (obj.usage) {
        return {
          inputTokens: obj.usage.input_tokens ?? 0,
          outputTokens: obj.usage.output_tokens ?? 0,
        };
      }
    } catch {
      // 忽略
    }
  }
  return null;
}

/** 提取响应 IP（relay 日志 clientIp 用，取 X-Forwarded-For 首段兜底 socket）。 */
export function extractClientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? '';
}
