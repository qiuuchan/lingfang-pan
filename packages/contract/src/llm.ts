// LLM 相关契约（见 docs/02 §A、docs/03 §B）。
// CONTRACT-06 修复：原文件声明了 LlmGatewayBindingInput/LlmGatewayBindingPublic/InvocationAudit/
// ChatRequest/InvocationKind 等 6 个 schema，但 collab-api 无 /llm/proxy 路由、无 LlmGateway 表、
// 无 InvocationAudit 写入，桌面端也不调用 /llm/proxy（plugins-runtime.ts 对 llm.chat 主动抛错），
// 即整组契约是空壳——任何按契约调用 ChatRequest/读取 InvocationAudit 的代码都会 404/拿到空。
// 现仅保留：
//  - ErrorCode：被 plugin.test.mjs 测试覆盖，且作为业务通用错误码集合仍有意义（与 collab-api common.ts 的
//    错误码命名保持一致），予以保留；
//  - ChatMessage：plugin-sdk 的本地 ChatMessage 与之同名但未复用契约；此处保留以便未来插件复用。
// 删除无实现的网关绑定/调用审计/ChatRequest schema，避免契约继续描述不存在的后端能力。
import { z } from 'zod';

export const ChatMessage = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

// 统一错误码（显式失败，不伪造结果）。
// 注意：与 collab-api common.ts AppError 的 code 字段对齐——以下 code 名均为后端实际产出的稳定码。
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
