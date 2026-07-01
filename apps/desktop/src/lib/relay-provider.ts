// relay-provider.ts —— Vercel AI SDK 的 OpenAI provider，指向平台 relay。
//
// relay 是 OpenAI 兼容（/api/relay/v1/chat/completions），model 用 fast/premium 哨兵透传；
// 鉴权用当前登录态 JWT（createOpenAI 的 apiKey → Authorization: Bearer <jwt>）。
// 计费/系统提示词规则注入/范围管控全部由 relay 服务端承担，前端 SDK 只管对话与工具调用。
//
// 思考内容（reasoning）：relay 服务端已把上游 reasoning_content 归一化为 <think>…</think> 包进 content。
// 这里避免从 ai 顶层入口导入 middleware；该入口会把 @ai-sdk/gateway 拉入 Vite 生产解析，
// 在桌面端打包时触发未使用的 @vercel/oidc 可选依赖解析失败。
//
// 网络重试：@ai-sdk/openai 的 createOpenAI 在本版本不暴露 maxRetries，Agents SDK / aisdk()
// 适配器也没有重试钩子，故在 fetch 层包一层带退避的重试：仅在 fetch 抛连接级异常
// （DNS 失败 / 连接拒绝 / 连接重置）时重试，拿到响应头后绝不重试（流式 body 不重放）。
// 这样「网络不好」时的瞬时断连由底层自动吸收，多数情况下用户无感。
//
// 错误翻译：relay 用灵坊自有格式 {code, message, details} 返回错误，但 @ai-sdk/openai 用
// OpenAI 标准 {error:{message}} 解析；不匹配时 message 会退化为无意义的 statusText
// （如 "Bad Request"）。withRetryFetch 在拿到非 2xx 响应时把 relay 错误体翻译成 OpenAI 兼容格式，
// 使 AI SDK 能读到真实原因（含上游 Kimi/Moonshot 的根因 details.upstreamDetail）。
import { createOpenAI } from '@ai-sdk/openai';
import { apiBase, getAuthToken } from '@/lib/api';

/** 连接级重试次数（不含首次）。指数退避：0.5s → 1s → 2s。 */
const CONNECT_RETRY = 3;

/**
 * 把 relay 的错误响应体（灵坊自有格式 {code, message, details}）翻译成 OpenAI 兼容格式
 * {error:{message, type, code}}，供 @ai-sdk/openai 的 openaiFailedResponseHandler 正确解析。
 *
 * 背景（修复「调用失败：Bad Request」盲区）：@ai-sdk/openai 用 OpenAI 标准错误 schema
 * {error:{message}} 解析响应体；relay 返回的是 {code, message, requestId}，schema 不匹配 →
 * safeParse 失败 → message 退化为 statusText（如 "Bad Request"），用户看不到真实原因。
 * 本 helper 在 fetch 包装层做格式翻译，使 AI SDK 能拿到 relay/上游的真实错误文案。
 *
 * 导出供单测验证翻译语义（与 normalizeToolFileContent 同样导出）。
 */
export function rewriteRelayErrorBody(status: number, rawBody: string): { body: string; status: number } {
  // relay 错误体：{code, message, requestId?, details?:{upstreamStatus?, upstreamDetail?}}
  let parsed: { code?: string; message?: string; details?: { upstreamStatus?: number | null; upstreamDetail?: string | null } } | null = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // 非 JSON（如反代 502 的 HTML）→ 用原文截断作 message，不让 AI SDK 退化为 statusText。
    const fallbackMsg = rawBody.slice(0, 200).trim() || `HTTP ${status}`;
    return { body: JSON.stringify({ error: { message: fallbackMsg, type: 'relay_error', code: `http_${status}` } }), status };
  }
  const code = parsed?.code ?? `http_${status}`;
  // 优先透传上游真实原因（relay details.upstreamDetail），否则用 relay 自身 message。
  const upstream = parsed?.details?.upstreamDetail;
  const message = upstream
    ? `${parsed?.message ?? '上游模型调用失败'}：${upstream}`
    : (parsed?.message ?? `HTTP ${status}`);
  return {
    body: JSON.stringify({ error: { message, type: parsed?.code ?? 'relay_error', code } }),
    status,
  };
}

/**
 * 带「连接级退避重试」+ relay 错误格式翻译的 fetch 包装。导出供单测验证重试语义。
 * - 仅在 fetch 抛 TypeError（连接失败/网络不可达）时重试；拿到任何 HTTP 响应（含 4xx/5xx）都不重试，
 *   因为流式响应已开始传输，重试会破坏 SSE 流。
 * - 超时类（用户传入的 signal abort）不重试。
 * - 非 2xx 响应：把 relay 的 {code,message} 错误体翻译成 OpenAI 兼容 {error:{message}}，
 *   避免 AI SDK 因 schema 不匹配而退化为 statusText（"Bad Request"）。2xx 原样返回（保护 SSE 流）。
 * 设计参考 OpenAI SDK / Vercel AI SDK 内置的重试语义（连接错误重试、HTTP 错误不重试流式）。
 */
export function withRetryFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= CONNECT_RETRY; attempt++) {
      try {
        const res = await fetch(input, init);
        // 非 2xx：翻译 relay 错误格式为 OpenAI 兼容格式，让 @ai-sdk/openai 能解析真实原因。
        // 仅在此拦截（错误响应是 JSON，非 SSE 流）；2xx 原样返回保护流式 body。
        if (!res.ok) {
          const rawBody = await res.text().catch(() => '');
          const { body, status } = rewriteRelayErrorBody(res.status, rawBody);
          const headers = new Headers(res.headers);
          headers.set('Content-Type', 'application/json');
          return new Response(body, { status, statusText: res.statusText, headers });
        }
        return res;
      } catch (err) {
        lastErr = err;
        // 用户主动取消（signal abort）不重试。
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        // 仅对连接级异常（fetch 抛 TypeError）重试；其余错误向上抛。
        if (!(err instanceof TypeError)) throw err;
        if (attempt === CONNECT_RETRY) break;
        // 指数退避：500ms → 1000ms → 2000ms。
        const delay = 500 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('网络连接失败，已重试多次仍不可达。');
  };
}

/** 构造一个指向平台 relay 的 OpenAI provider（每次调用读最新 JWT）。 */
export function relayProvider() {
  const openai = createOpenAI({
    baseURL: `${apiBase()}/api/relay/v1`,
    apiKey: getAuthToken() || 'no-auth', // relay 的 DualAuthGuard 读 Authorization: Bearer
    headers: { 'X-Client': 'desktop' },
    // 连接级重试：瞬断（DNS 抖动 / 连接重置 / 网络不可达）由 fetch 层指数退避重试，
    // 多数「网络不好」场景在此层吸收，不必每次都让用户手动点重试。
    fetch: withRetryFetch(),
  });
  return {
    chat: (tier: 'fast' | 'premium') => openai.chat(tier),
  };
}
