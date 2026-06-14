# LLM 单 provider 云分发与租户绑定（v3 定稿）

## 概述

平台维护「provider 目录」（`LlmGateway`：provider + apiUrl + 模型清单），但同一时间只有一个「当前启用」（`isActive=true`，全表最多一条，事务维护唯一）。**应用界面完全没有 provider 概念**：用户只看到「一个 apiKey 输入 + 拉取模型 + 模型选择」。应用拉取当前启用 provider 的 apiUrl，用户填自己的 apiKey（AES-256-GCM 加密存库）、选模型。Admin 切 provider 后用户无感知（只需重新填 key + 拉模型）。

> 历史：v1（settings-cli-runtime-model-gateway）让用户选网关目录 + 静态模型；v2（model-gateway-redo-fetch-models）让用户选 provider + 动态拉取；v3（本节，model-gateway-final-single-provider）定稿——用户界面零 provider，平台多 provider 应用拿当前启用。`TenantLlmBinding` 去 gatewayId（破坏式不向后兼容，迁移处理旧数据）。

## 数据模型（Prisma）

`apps/collab-api/prisma/schema.prisma`：
- `LlmGateway`（平台级）：`provider`（String 非 enum，平台维护白名单）/ `name`（@unique）/ `apiUrl`（去尾斜杠）/ `models`（Json string[]）/ `status`（ENABLED|DISABLED）/ `sortOrder` / `isActive`（当前启用 provider，全表最多一条 true，事务维护唯一）。
- `TenantLlmBinding`（租户级，v3 定稿）：`teamId`（@unique，一个团队一条 apiKey 绑定）/ `encryptedApiKey` / `apiKeyHint`（脱敏明文存）/ `keyFingerprint`（sha256 前16位）/ `enabled` / `modelOverride`（Json?，用户从拉取结果选的子集）/ `createdById` / `updatedById`。
  - **去 gatewayId + provider**（破坏式，用户界面零 provider 概念）。
  - team 上 `onDelete: Cascade`（删团队级联删绑定）。

## 加密（AES-256-GCM）

`apps/collab-api/src/crypto/credential-cipher.ts`：
- 密钥从 env `LLM_KEY_ENCRYPTION_KEY`（64 位 hex → 32 字节）。`requireKeyEncryptionKey()` 返回 Buffer 或 null。
- 密文打包 `base64(iv(12B) || tag(16B) || ciphertext)`，**每次新 IV**（语义安全）。
- `decryptApiKey` 校验 tag，失败抛 `AppError(500, 'llm_key_decrypt_failed')`。**无 legacy/XOR/明文 fallback**。
- `maskApiKey(plain)`：len>=12 → `前3***后4`；6-11 → `***后2`；否则 `***`。永不暴露连续 ≥6 明文。
- `fingerprintApiKey(plain)` = sha256(plain).slice(0,16)。

### 密钥管理（fail-fast）

`apps/collab-api/src/main.ts` 复刻 JWT_SECRET 的启动断言：生产缺 `LLM_KEY_ENCRYPTION_KEY` → throw；dev warn 但**不生成兜底密钥**（首次加解密抛 `llm_key_not_configured`）。密钥不入库不入 git。

## 端点（前缀 /api，全局 JwtAuthGuard）

### 平台 Admin（ensurePlatformAdmin）
- `GET /api/admin/llm-providers`（provider 列表，含 isActive）。
- `POST /api/admin/llm-providers`（新增 provider，isActive 不在此设）。
- `PATCH /api/admin/llm-providers/:id`（编辑 provider，isActive 不在此改）。
- `DELETE /api/admin/llm-providers/:id`（删除 provider；active 的拒绝删 `provider_active_not_deletable`）。
- `PATCH /api/admin/llm-providers/:id/activate`（**设为当前启用**，`$transaction` 维护唯一 active：先 updateMany 所有 isActive=true → false，再 update 目标 → true）。

### 租户（`@Controller('llm')`）
- `GET /api/llm/active-provider`（ensureCurrentTeam，返回当前启用 provider 的 `{ apiUrl, defaultModels }`；无 → 404 `no_active_provider`）。
- `GET /api/llm/binding`（ensureCurrentTeam，单条绑定，apiKey 脱敏，**零解密**）。
- `PUT /api/llm/binding`（ensureTeamAdmin，入参无 gatewayId，按 teamId 唯一 upsert，apiKey 写入即加密 + `$transaction` + 审计）。
- `DELETE /api/llm/binding`（ensureTeamAdmin，按 teamId 删唯一绑定）。
- `POST /api/llm/binding/decrypt`（ensureTeamAdmin + 强审计，按 teamId 取唯一绑定解密，返回明文供桌面 CLI 用）。

## 安全契约（用户凭据保护）

- **GET 永不返回明文 apiKey**：列表只读 `apiKeyHint`/`keyFingerprint`，不调 decrypt。
- **解密仅 ensureTeamAdmin**：decrypt 端点写 `llm_binding.key_decrypted` 审计，明文经 HTTPS 返回。
- **审计 metadata 永不记 key**：固定 shape `{teamId, kind?, enabled?}`（v3 去 gatewayId/provider 后简化），绝不记 apiKey 明文/密文/hint/fingerprint。单测断言。
- **camelCase**：所有 `/api/llm/*` 字段统一 camelCase。

## 错误码（packages/contract/src/llm.ts LlmErrorCode）

`no_active_provider` / `provider_not_found` / `provider_active_not_deletable` / `binding_not_found` / `llm_key_decrypt_failed` / `llm_key_not_configured` / `install_unsupported` / `install_failed`。

前端按 `(err as ApiError).code` + `LlmErrorCode` switch 分支，**不用 message.includes**。

## Scenario: apiKey 加解密与脱敏

### 签名
- `encryptApiKey(plain, key) -> string`
- `decryptApiKey(packed, key) -> string`（失败抛 AppError）
- `maskApiKey(plain) -> string`

### 契约
- 同明文两次加密密文不同（IV 随机）。
- 篡改 tag/iv → decrypt 抛 `llm_key_decrypt_failed`。
- maskApiKey 输出移除 `***` 后连续明文 < 6 字符。

### 测试
`apps/collab-api/src/crypto/credential-cipher.spec.ts`：往返 / 篡改 tag / 篡改 iv / IV 随机性 / mask 边界 / fingerprint 稳定 / 密钥解析（7 测）。

### Wrong vs Correct
- Wrong：明文存库；GET 返回明文；审计记 hint；XOR/明文 fallback。
- Correct：AES-256-GCM 密文；GET 零解密只读脱敏；解密仅 TEAM_ADMIN + 强审计；fail-fast 无兜底密钥。

## Scenario: 租户绑定 upsert（$transaction 原子性 + teamId 唯一）

- ensureTeamAdmin → 按 teamId 查已有绑定 → apiKey 可选（undefined=保留原密 kind=config_only；非空=轮换 kind=key_rotated/create）→ `prisma.$transaction`：binding upsert（where=teamId）+ auditLog.create 同事务。
- metadata `{teamId, kind, enabled}` 永不含 key（v3 去 gatewayId/provider 后简化）。

### Wrong vs Correct
- Wrong：service 单独写 binding 和 audit（非原子，可能成功写 binding 但 audit 失败丢失）；普通 MEMBER 可改绑定；保留 gatewayId 让用户感知 provider。
- Correct：$transaction 原子；ensureTeamAdmin 守卫；teamId 唯一（一个团队一条 key 绑定）；审计 metadata 固定无 key shape。

## Scenario: 当前启用 provider（唯一 active 事务）

- `getActiveProvider`：`findFirst({ where: { isActive: true, status: 'ENABLED' } })`，无 → 404 `no_active_provider`。
- `adminActivateProvider(id)`：`$transaction`：`updateMany({ where: { isActive: true }, data: { isActive: false } })` + `update({ where: { id }, data: { isActive: true } })`。

### Wrong vs Correct
- Wrong：先设新的 true 再清旧的（中间窗口有两个 active）；应用层 select 默认值让多个 provider 同时生效。
- Correct：$transaction 原子，先清后设，全表最多一条 active；应用 findFirst 始终拿到唯一启用 provider。
