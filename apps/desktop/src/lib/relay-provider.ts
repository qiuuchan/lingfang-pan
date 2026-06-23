// relay-provider.ts —— Vercel AI SDK 的 OpenAI provider，指向平台 relay。
//
// relay 是 OpenAI 兼容（/api/relay/v1/chat/completions），model 用 fast/premium 哨兵透传；
// 鉴权用当前登录态 JWT（createOpenAI 的 apiKey → Authorization: Bearer <jwt>）。
// 计费/系统提示词规则注入/范围管控全部由 relay 服务端承担，前端 SDK 只管对话与工具调用。
import { createOpenAI } from '@ai-sdk/openai';
import { apiBase, getAuthToken } from '@/lib/api';

/** 构造一个指向平台 relay 的 OpenAI provider（每次调用读最新 JWT）。 */
export function relayProvider() {
  return createOpenAI({
    baseURL: `${apiBase()}/api/relay/v1`,
    apiKey: getAuthToken() || 'no-auth', // relay 的 DualAuthGuard 读 Authorization: Bearer
    headers: { 'X-Client': 'desktop' },
  });
}
