// LLM 网关绑定与调用审计契约（见 docs/02 §A、docs/03 §B）。
import { z } from 'zod';

// 写入用（含明文 key，仅创建/更新时传入，服务端立即加密落库）
export const LlmGatewayBindingInput = z.object({
  name: z.string().min(1),
  protocol: z.literal('openai-compatible'),
  base_url: z.string().url(),
  api_key: z.string().min(1),
  models: z.array(z.string().min(1)).min(1),
});
export type LlmGatewayBindingInput = z.infer<typeof LlmGatewayBindingInput>;

// 读取用（脱敏，永不含明文 key）
export const LlmGatewayBindingPublic = z.object({
  id: z.string().min(1),
  tenant_id: z.string().min(1),
  name: z.string().min(1),
  protocol: z.literal('openai-compatible'),
  base_url: z.string().url(),
  api_key_masked: z.string(), // 形如 sk-****
  models: z.array(z.string()),
  status: z.enum(['active', 'disabled']).default('active'),
  created_by: z.string().min(1),
  created_at: z.string().datetime(),
});
export type LlmGatewayBindingPublic = z.infer<typeof LlmGatewayBindingPublic>;

export const InvocationKind = z.enum(['generate', 'runtime']);
export type InvocationKind = z.infer<typeof InvocationKind>;

export const InvocationAudit = z.object({
  id: z.string().min(1),
  tenant_id: z.string().min(1),
  kind: InvocationKind,
  plugin_id: z.string().min(1).optional(),
  draft_id: z.string().min(1).optional(),
  user_id: z.string().min(1),
  capability: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(['ok', 'denied', 'error']),
  error_code: z.string().optional(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime(),
});
export type InvocationAudit = z.infer<typeof InvocationAudit>;

// —— LLM 运行时调用（插件经 /llm/proxy）——
export const ChatMessage = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatRequest = z.object({
  plugin_id: z.string().min(1),
  messages: z.array(ChatMessage).min(1),
  model: z.string().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

// 统一错误码（显式失败，不伪造结果）
export const ErrorCode = z.enum([
  'llm_binding_missing',
  'generation_invalid',
  'capability_denied',
  'unauthorized',
  'not_found',
  'bad_request',
  'forbidden',
  'insufficient_balance',
  'payment_required',
  'upstream_llm_error',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
