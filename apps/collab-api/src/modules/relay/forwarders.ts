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

const UPSTREAM_TIMEOUT_MS = 120_000;

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
    return pipeSseAndExtractUsage(upstream, res, parseOpenAiUsage);
  }
  // 非流式：直接转发 JSON，解析 usage。
  const data = (await upstream.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  res.status(200).json(data);
  return {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    images: 0,
  };
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

// === SSE 透传 + usage 解析 ===

/**
 * 把上游 SSE body 逐 chunk 透传给 express res，同时扫描 chunk 提取 usage（最后一个带 usage 的事件）。
 * 调用方需已设置 SSE 响应头。
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
