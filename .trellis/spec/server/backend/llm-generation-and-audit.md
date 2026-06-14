# LLM 网关目录与租户绑定

## 概述

平台维护「网关目录」（`LlmGateway`：provider + apiUrl + 模型清单），租户在目录里选网关、填自己的 apiKey（AES-256-GCM 加密存库）、选模型。apiKey 跨电脑可用——桌面端 CLI 启动前通过 decrypt 端点按需取明文注入子进程 env。

> 历史：ADR-0002 描述的旧 Rust `/llm/proxy` + `llm_gateway_bindings` 已在 Rust→NestJS 迁移时丢弃（CONTRACT-06 删除空壳 schema）。本节描述的是 2026-06-14 重建的 NestJS 实现，不是旧 Rust server。

## 数据模型（Prisma）

`apps/collab-api/prisma/schema.prisma`：
- `LlmGateway`（平台级）：`provider`（String 非 enum，平台维护白名单）/ `name`（@unique）/ `apiUrl`（去尾斜杠）/ `models`（Json string[]）/ `status`（ENABLED|DISABLED）/ `sortOrder`。
- `TenantLlmBinding`（租户级）：`teamId` / `gatewayId` / `encryptedApiKey` / `apiKeyHint`（脱敏明文存）/ `keyFingerprint`（sha256 前16位）/ `enabled` / `modelOverride`（Json?）/ `createdById` / `updatedById`。
  - `@@unique([teamId, gatewayId])`
  - **gateway 关系 `onDelete: Restrict`**（禁用网关不级联删绑定，防误删清空租户 key）。

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
- `GET/POST /api/admin/llm-gateways`、`PATCH /api/admin/llm-gateways/:id`、`PATCH /api/admin/llm-gateways/:id/status`。
- **无物理 DELETE**（软删除 status=DISABLED）。

### 租户（`@Controller('llm')`）
- `GET /api/llm/gateways`（仅 ENABLED，无任何 key）
- `GET /api/llm/binding`（ensureCurrentTeam，apiKey 脱敏，**零解密**）
- `PUT /api/llm/binding`（ensureTeamAdmin，apiKey 写入即加密 + `$transaction` + 审计）
- `DELETE /api/llm/binding/:gatewayId`（ensureTeamAdmin）
- `POST /api/llm/binding/:gatewayId/decrypt`（ensureTeamAdmin + 强审计，返回明文供桌面 CLI 用）

## 安全契约（用户凭据保护）

- **GET 永不返回明文 apiKey**：列表只读 `apiKeyHint`/`keyFingerprint`，不调 decrypt。
- **解密仅 ensureTeamAdmin**：decrypt 端点写 `llm_binding.key_decrypted` 审计，明文经 HTTPS 返回。
- **审计 metadata 永不记 key**：固定 shape `{teamId, gatewayId, provider, kind, enabled}`，绝不记 apiKey 明文/密文/hint/fingerprint。单测断言（AC12）。
- **禁用网关只读**：DISABLED 网关上的绑定，upsert/decrypt 返回 `gateway_disabled` 错误码。
- **camelCase**：所有 `/api/llm/*` 字段统一 camelCase。

## 错误码（packages/contract/src/llm.ts LlmErrorCode）

`gateway_disabled` / `binding_not_found` / `llm_key_decrypt_failed` / `llm_key_not_configured` / `install_unsupported` / `install_failed`。

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

## Scenario: 租户绑定 upsert（$transaction 原子性）

- ensureTeamAdmin → 校验 gateway.status==='ENABLED'（否则 gateway_disabled）→ apiKey 可选（undefined=保留原密 kind=config_only；非空=轮换 kind=key_rotated/create）→ `prisma.$transaction`：binding upsert + auditLog.create 同事务。
- metadata `{teamId, gatewayId, provider, kind, enabled}` 永不含 key。

### Wrong vs Correct
- Wrong：service 单独写 binding 和 audit（非原子，可能成功写 binding 但 audit 失败丢失）；普通 MEMBER 可改绑定。
- Correct：$transaction 原子；ensureTeamAdmin 守卫；审计 metadata 固定无 key shape。
