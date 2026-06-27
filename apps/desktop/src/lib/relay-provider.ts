// relay-provider.ts —— Vercel AI SDK 的 OpenAI provider，指向平台 relay。
//
// relay 是 OpenAI 兼容（/api/relay/v1/chat/completions），model 用 fast/premium 哨兵透传；
// 鉴权用当前登录态 JWT（createOpenAI 的 apiKey → Authorization: Bearer <jwt>）。
// 计费/系统提示词规则注入/范围管控全部由 relay 服务端承担，前端 SDK 只管对话与工具调用。
//
// 思考内容（reasoning）：relay 服务端已把上游 reasoning_content 归一化为 <think>…</think> 包进 content。
// 这里避免从 ai 顶层入口导入 middleware；该入口会把 @ai-sdk/gateway 拉入 Vite 生产解析，
// 在桌面端打包时触发未使用的 @vercel/oidc 可选依赖解析失败。
import { createOpenAI } from '@ai-sdk/openai';
import { apiBase, getAuthToken } from '@/lib/api';

/** 构造一个指向平台 relay 的 OpenAI provider（每次调用读最新 JWT）。 */
export function relayProvider() {
  const openai = createOpenAI({
    baseURL: `${apiBase()}/api/relay/v1`,
    apiKey: getAuthToken() || 'no-auth', // relay 的 DualAuthGuard 读 Authorization: Bearer
    headers: { 'X-Client': 'desktop' },
  });
  return {
    chat: (tier: 'fast' | 'premium') => openai.chat(tier),
  };
}
