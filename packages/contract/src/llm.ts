// LLM 相关契约（LLM 网关目录 + 租户绑定单一真源）。
//
// 历史说明：CONTRACT-06 曾删除旧文件的空壳 schema（无 /llm/proxy 路由、无 LlmGateway 表）。
// 本任务（06-14-settings-cli-runtime-model-gateway）重建为后端真实存在的「模型网关目录 + 租户绑定」契约：
//  - LlmGatewayPublicSchema / TenantBindingPublicSchema：GET 出参（脱敏、零密钥、零明文）。
//  - BindingUpsertInputSchema：租户 PUT /api/llm/binding 入参（apiKey 可选语义见 design.md B5）。
//  - GatewayCreateInputSchema / GatewayUpdateInputSchema：平台 Admin 网关目录增改入参。
//  - LlmErrorCode：6 个网关/绑定/安装专属错误码（与 collab-api common.ts 的 code 字段对齐）。
//  - ChatMessage：plugin-sdk 的本地 ChatMessage 与之同名但未复用契约；此处保留以便未来插件复用。
//  - ErrorCode：业务通用错误码集合（与 collab-api common.ts AppError.code 对齐），plugin.test.mjs 测试覆盖。
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

// LLM 网关/绑定/安装专属错误码（与 collab-api common.ts AppError.code 对齐，前端按 code 分支处理）。
export const LlmErrorCode = z.enum([
  'gateway_disabled',         // 网关已软删除（status=DISABLED），绑定只读
  'binding_not_found',        // 租户尚未绑定该网关（GET decrypt / config-only PUT 无原密可改）
  'llm_key_decrypt_failed',   // 密文被篡改/密钥不匹配，AES-GCM tag 校验失败
  'llm_key_not_configured',   // 服务端 LLM_KEY_ENCRYPTION_KEY 未配置，无法加解密
  'install_unsupported',      // 当前平台不支持自动安装（macOS/Linux 无 winget）
  'install_failed',           // winget/npm 安装失败或超时（已清理半装残留）
]);
export type LlmErrorCode = z.infer<typeof LlmErrorCode>;

// === 平台 Admin 网关目录契约 ===

/** GET /api/llm/gateways（租户侧，仅 ENABLED）单条出参。 */
export const LlmGatewayPublicSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  apiUrl: z.string(),
  models: z.array(z.string()).default([]),
  description: z.string().default(''),
  sortOrder: z.number().default(0),
});
export type LlmGatewayPublic = z.infer<typeof LlmGatewayPublicSchema>;

// === 租户绑定契约 ===

/** GET /api/llm/binding 单条出参（脱敏，零解密；effectiveModels = modelOverride ?? gatewayModels）。 */
export const TenantBindingPublicSchema = z.object({
  id: z.string(),
  gatewayId: z.string(),
  provider: z.string(),
  gatewayName: z.string(),
  apiUrl: z.string(),
  gatewayStatus: z.enum(['ENABLED', 'DISABLED']),
  enabled: z.boolean(),
  apiKeyHint: z.string(),                       // 脱敏串（如 sk-1***wxyz），非密文非明文
  keyFingerprint: z.string(),                   // sha256(明文).slice(0,16)，稳定标识「这是哪个 key」
  gatewayModels: z.array(z.string()),           // 网关目录声明的模型清单
  modelOverride: z.array(z.string()).nullable(),// null=继承 gatewayModels；string[]=子集
  effectiveModels: z.array(z.string()),         // 实际生效模型 = modelOverride ?? gatewayModels
  updatedBy: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  updatedAt: z.string(),
});
export type TenantBindingPublic = z.infer<typeof TenantBindingPublicSchema>;

/** PUT /api/llm/binding 入参。
 *  apiKey 语义（design.md B5）：
 *  - undefined：保留原密，仅改 enabled/modelOverride（kind=config_only）；
 *  - 非空：重新加密 + 轮换 hint/fingerprint（kind=key_rotated 或 create）。 */
export const BindingUpsertInputSchema = z.object({
  gatewayId: z.string(),
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  modelOverride: z.array(z.string()).nullable().optional(),
});
export type BindingUpsertInput = z.infer<typeof BindingUpsertInputSchema>;

// === 平台 Admin 网关目录增改入参 ===

/** POST /api/admin/llm-gateways 入参。apiUrl 服务端规范化去尾斜杠。 */
export const GatewayCreateInputSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  apiUrl: z.string().min(1),
  models: z.array(z.string()).optional(),
  description: z.string().optional(),
  sortOrder: z.number().min(0).optional(),
  status: z.enum(['ENABLED', 'DISABLED']).optional(),
});
export type GatewayCreateInput = z.infer<typeof GatewayCreateInputSchema>;

/** PATCH /api/admin/llm-gateways/:id 入参（全可选）。 */
export const GatewayUpdateInputSchema = GatewayCreateInputSchema.partial();
export type GatewayUpdateInput = z.infer<typeof GatewayUpdateInputSchema>;
