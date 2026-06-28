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
import { createOpenAI } from '@ai-sdk/openai';
import { apiBase, getAuthToken } from '@/lib/api';

/** 连接级重试次数（不含首次）。指数退避：0.5s → 1s → 2s。 */
const CONNECT_RETRY = 3;

/**
 * 带「连接级退避重试」的 fetch 包装。导出供单测验证重试语义。
 * - 仅在 fetch 抛 TypeError（连接失败/网络不可达）时重试；拿到任何 HTTP 响应（含 4xx/5xx）都不重试，
 *   因为流式响应已开始传输，重试会破坏 SSE 流。
 * - 超时类（用户传入的 signal abort）不重试。
 * 设计参考 OpenAI SDK / Vercel AI SDK 内置的重试语义（连接错误重试、HTTP 错误不重试流式）。
 */
export function withRetryFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= CONNECT_RETRY; attempt++) {
      try {
        // 拿到响应即返回，不再重试（无论状态码）。流式 body 由调用方消费。
        return await fetch(input, init);
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
