// model.ts —— 把灵坊 relay 模型适配成 OpenAI Agents SDK 的 Model。
//
// OpenAI Agents SDK 默认走 OpenAI 的 Responses/Chat Completions API，但灵坊用的是
// 自建 relay（OpenAI 兼容的 /api/relay/v1/chat/completions，model 用 fast/premium 哨兵透传）。
// 这里用 @openai/agents-extensions 的 aisdk() 适配器，把现有的 Vercel AI SDK relay 模型
// （relay-provider.ts）包成 Agents SDK 的 Model。relay 会把 reasoning_content 归一化到 content
// 里的 <think>...</think>，由 creator-adapter 的流式解析器拆成 UI reasoning parts。
//
// 版本匹配：package.json 的 ai@^5.0.204 对应 LanguageModelV2，与 aisdk() 适配器期望一致。
import { aisdk } from '@openai/agents-extensions/ai-sdk';
import type { Model } from '@openai/agents';
import { relayProvider } from '@/lib/relay-provider';

/**
 * 构造 Agents SDK 用的 Model（按 tier 选 fast/premium）。
 * 每次调用读最新 relay 模型（内部读最新 JWT），避免登录态过期。
 */
export function agentModel(tier: 'fast' | 'premium'): Model {
  const relayModel = relayProvider().chat(tier);
  return aisdk(relayModel);
}
