// relay-provider.ts —— Vercel AI SDK 的 OpenAI provider，指向平台 relay。
//
// relay 是 OpenAI 兼容（/api/relay/v1/chat/completions），model 用 fast/premium 哨兵透传；
// 鉴权用当前登录态 JWT（createOpenAI 的 apiKey → Authorization: Bearer <jwt>）。
// 计费/系统提示词规则注入/范围管控全部由 relay 服务端承担，前端 SDK 只管对话与工具调用。
//
// 思考内容（reasoning）：部分上游（阶跃星辰/DeepSeek 系）用非标准 delta.reasoning_content 发思考，
// @ai-sdk/openai 的 chat 解析器不认该字段。relay 服务端已把思考归一化为 <think>…</think> 包进 content，
// 此处用 extractReasoningMiddleware 把 <think> 块抽回 reasoning-delta 事件，供 UI 思考框展示。
import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel, extractReasoningMiddleware } from 'ai';
import { apiBase, getAuthToken } from '@/lib/api';

/** 构造一个指向平台 relay 的 OpenAI provider（每次调用读最新 JWT）。 */
export function relayProvider() {
  const openai = createOpenAI({
    baseURL: `${apiBase()}/api/relay/v1`,
    apiKey: getAuthToken() || 'no-auth', // relay 的 DualAuthGuard 读 Authorization: Bearer
    headers: { 'X-Client': 'desktop' },
  });
  // 包装 chat 模型：抽取 <think> 标签为 reasoning（relay 已把上游 reasoning_content 归一化为 <think>）。
  return {
    chat: (tier: 'fast' | 'premium') =>
      wrapLanguageModel({
        model: openai.chat(tier),
        middleware: extractReasoningMiddleware({ tagName: 'think' }),
      }),
  };
}
