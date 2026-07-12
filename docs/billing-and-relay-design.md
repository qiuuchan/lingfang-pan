# 灵坊平台 · 计费系统与模型中转（Relay + 灵石）技术设计（历史方案与迁移记录）

> **状态：历史参考。** 本文保留计费与 relay 的设计演进，其中部分接口、页面和迁移步骤已完成或被替代，不应作为当前 API 清单。当前系统边界见 [当前架构](./01-vision-and-architecture.md)，实际接口见 [协作 API](./collab-api.md)，当前领域模型见 [领域与插件](./02-domain-and-plugins.md)。

> 交付物：一份覆盖"模型中转 + 灵石计费 + 渠道管控 + 前台版本收敛 + 调用日志"的技术设计文档。
> 范围确认（已与用户对齐）：灵石=**独立新货币**；计费主体=**按团队**；**完全替换** 现有 BYOK；本次为 **设计 + 立即实现**。
> 落地后本文件复制到 `docs/billing-and-relay-design.md` 作为长期权威文档。

---

## 1. Context（为什么做）

**现状（BYOK 架构，与目标相悖）**
- 后端 `apps/collab-api`（NestJS + Prisma + Postgres）只存"用户自带 key"（`TenantLlmBinding`，AES-256-GCM 加密落库），桌面 `apps/desktop` 的 Rust 运行时（`src-tauri/src/llm_credentials.rs` + `code_assistant.rs`）从 `/api/llm/active-provider` + `/api/llm/binding/decrypt` 拿明文 key + apiUrl，**用 reqwest 直连上游**——**实际模型流量完全绕过 collab-api**。
- 平台**不做任何 token 计量 / 扣费**（`docs/03-backend-and-llm.md` 明文："平台不做 token 计量、扣费或分成"）。
- `LlmGateway` 是"全表最多一条 isActive=true"的**单活跃 provider 目录**，非多渠道路由。
- 现有经济系统 `Wallet / Purchase / Team.balanceCents` 是**插件市场的人民币分**（注册赠 ¥10），与 AI 用量计费是两套语义。
- **违规实证**：内置插件 `builtin-plugins/ai-wardrobe/api.py` **硬编码第三方 key** `sk-sQXtwg…` 直连 `47.112.8.9:19081/v1/images/edits` 生图，绕过平台、无法计费、key 泄漏——正是需求 #3 要杜绝的典型。

**目标**
把"用户自带 key + 直连上游"翻转为"**平台托管渠道 + 统一中转 + 灵石按量计费 + 全链路日志**"：
1. 参考 one-api / openai-forward，在 collab-api 内建 **OpenAI 兼容 + Anthropic 兼容** 的中转层，用 **OpenAI SDK + Anthropic SDK** 双协议转发。
2. 引入虚拟货币 **灵石（Credit）**，按团队账户计费，**每模型单价后台全可配**（按 token / 按次 / 按张）。
3. 所有系统提示词强制注入"AI 能力调用必须且仅能使用灵坊平台服务"规则。
4. **平台发放团队共享 API Key**，仅团队管理员轮换/吊销；插件与 Agent 不读取、不展示、不保存 Key。
5. 前台**移除 API Key/API URL/provider/自定义端点配置**；插件仍可传平台模型标识（如 `fast` / `premium`）。
6. 详尽**调用日志**，多维度查询。

---

## 2. 总体架构

```
┌─────────────────────────── apps/desktop（前台） ────────────────────────────┐
│  创建器/聊天/生图：保留平台 model 标识（如 fast/premium），不暴露上游配置     │
│  设置页：只读模型版本说明；团队共享 API Key 仅在团队管理页由管理员轮换        │
│  运行时：插件/Agent 通过宿主桥或登录态调用 {backend}/api/relay               │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                     │  OpenAI/Anthropic 协议（含 SSE 流）
┌──────────────────────────── ▼ apps/collab-api ──────────────────────────────┐
│  /api/relay/v1/*   ← @Public + DualAuthGuard（JWT 或 平台 API Key）          │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │ RelayService：① 鉴权/解析团队+版本 ② 预留灵石额度                   │    │
│   │   ③ 选渠道（范围+模型+优先级+权重+故障转移）                        │    │
│   │   ④ 注入系统提示词规则 ⑤ OpenAI/Anthropic SDK 转发（流式透传）      │    │
│   │   ⑥ 计费（按 token/次/张）+ 写 LlmCallLog + CreditLedger（事务）   │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│  /api/admin/{channels,pricing,tiers,credits,call-logs,api-keys,relay-docs}   │
│  /api/me/{credits,api-keys}     /api/teams/current/credits                    │
│  Prisma：Channel / ChannelBinding / TeamCredit / CreditLedger /              │
│          ModelPricing / ModelTierConfig / PlatformApiKey / LlmCallLog        │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                     │  上游真实 key（AES-256-GCM 密文落库）
                                     ▼
                      OpenAI / Anthropic / Azure / DeepSeek / …
```

**关键翻转点**：模型流量从"桌面直连上游"改为"桌面→relay→上游"。relay 是**唯一计费与日志咽喉**，桌面协议不变（仍是 `/v1/chat/completions`、`/v1/messages`），只改目标 URL 与 key 来源——迁移成本最小。

---

## 3. 数据模型（Prisma schema 增量）

新增于 `apps/collab-api/prisma/schema.prisma`。全部**加表不破坏**既有；同时在 `Team` / `User` 补反向关系。新增枚举：`ChannelStatus`、`ChannelProtocol`、`ChannelScopeKind`、`PricingUnit`、`ModelTierId`、`ApiKeyStatus`。

| 表 | 角色 | 关键字段 |
|---|---|---|
| **Channel** | 上游渠道（取代单活跃 `LlmGateway`） | `name`, `protocol`(OPENAI/ANTHROPIC), `provider`(白名单), `baseUrl`, `encryptedUpstreamKey`(密文), `supportedModels`[], `status`, `priority`(小优先), `weight`(同优先级加权), `lastHealthOk` |
| **ChannelBinding** | 渠道↔主体多对多（满足"单主体可配单/多渠道"） | `channelId`, `scopeKind`(GLOBAL/TEAM/ROLE), `scopeId`(teamId/roleId) |
| **TeamCredit** | 团队灵石账户（每团队一行，独立于 `Team.balanceCents`） | `teamId`(@id), `balance`(Int 灵石) |
| **CreditLedger** | 灵石流水（每次变动） | `teamId`, `amount`, `direction`(复用 CREDIT/DEBIT), `source`(signup_bonus/admin_adjust/llm_consume/image_consume/refund), `actorUserId`, `callLogId` |
| **ModelPricing** | 单价表（每模型/能力一行，后台可配） | `capability`(chat/image/action), `model`, `unit`(PER_TOKEN_INPUT/OUTPUT/PER_CALL/PER_IMAGE), `pricePerUnit`(灵石), `tier?` |
| **ModelTierConfig** | 版本配置（快速/高级 → 底层模型+参数） | `tier`(@id FAST/PREMIUM), `label`, `chatModel`, `imageModel?`, `temperature?`, `maxTokens?`, `extraParams` |
| **PlatformApiKey** | 平台发放的 API Key | `teamId`, `name`, `keyPrefix`(展示), `keyHash`(sha256 明文，@unique), `scopes`[](`chat`/`image`/`tier:fast`…), `status`, `lastUsedAt`, `expiresAt` |
| **LlmCallLog** | 调用日志（多维度查询） | `teamId`, `userId?`, `apiKeyId?`, `channelId?`, `capability`, `tier?`, `model`, `inputTokens`, `outputTokens`, `images`, `durationMs`, `credits`, `status`, `httpStatus?`, `errorCode?`, `requestSummary`(Json 脱敏), `clientIp?` |

**索引**：`LlmCallLog` 按 `(teamId,createdAt)`、`(userId,createdAt)`、`(apiKeyId,createdAt)`、`(capability,createdAt)`、`(status,createdAt)`、`(model,createdAt)` 各建索引，覆盖需求 #6 的所有查询维度；`CreditLedger` 按 `(teamId,createdAt)`、`(source,createdAt)`；`Channel` 按 `(status,priority)`、`(scopeKind,scopeId,status)`。

**弃用**：`TenantLlmBinding` + `LlmGateway` 在迁移完成后保表一个版本再 drop（见 §10）。

**可复用基础设施**：`credential-cipher.ts`（加密 `Channel.encryptedUpstreamKey`）、`PlatformSetting` 键值表（存全局标量：`creditSignupBonus`、`creditReserveCapFast/Premium`、`aiUsageGuardRule`）、`AuditLog`（治理追溯）、`EconomyService` 的事务条件扣款模式（`updateMany where balance>=price` 防竞态）。

---

## 4. 中转层 RelayService（核心）

### 4.1 端点（挂 `/api/relay`，`@Public()` + 自定义 `DualAuthGuard`）

| 方法 | 路径 | 协议 | 说明 |
|---|---|---|---|
| POST | `/api/relay/v1/chat/completions` | OpenAI | 聊天，支持 SSE `stream:true` |
| POST | `/api/relay/v1/messages` | Anthropic | 聊天，支持 SSE `stream:true` |
| POST | `/api/relay/v1/images/generations` | OpenAI | 生图，按张计费 |
| GET  | `/api/relay/v1/models` | OpenAI | 仅返回 `[{id:'fast'},{id:'premium'}]`——协议层强制两版本 |

### 4.2 DualAuthGuard（`security.ts` 同目录新增）

- 顺序：在全局 `JwtAuthGuard` 之前对 `/api/relay/**` 放行（`@Public()` 跳过 JWT），改由本守卫接管。
- 解析 `Authorization: Bearer <token>`：若 `token` 形如 `lf_…` → sha256 → 查 `PlatformApiKey.keyHash`（校验 status/scopes/expiresAt）→ 附 `{ teamId, apiKeyId, scopes, userId:null }`；否则走原 JWT 解析路径 → 附 `{ userId, teamId(由 membership 解析), scopes:['*'] }`。
- 双鉴权让迁移顺滑：**桌面继续用 JWT 调 relay（零 key 改动）**；**外部插件/应用用平台 API Key**。

### 4.3 一次 chat 调用流程

1. **鉴权** → 解析 `teamId`、`tier`（来自请求体 `model` 字段 = `'fast'`/`'premium'` 哨兵；非哨兵且非管理后台白名单则 `bad_request`）。
2. **预扣额度**：按 `ModelTierConfig.tier` 查 `creditReserveCap<tier>`（PlatformSetting），原子条件扣款（复用 `updateMany where balance>=cap`）；扣款记 `CreditLedger{source:'reserve',direction:DEBIT}`，`callLogId` 先占位。余额不足 → `402 insufficient_balance`（错误体按目标协议 shape，客户端可识别）。
3. **选渠道**（`ChannelRouterService`）：候选 = `status=ENABLED` 且（`ChannelBinding` 命中团队/角色/GLOBAL）且（`supportedModels` 含本 tier 的 `chatModel` 或 `supportedTiers` 含本 tier）；按 `priority` 升序，同 priority 内按 `weight` 加权随机取一；上游失败（超时/5xx/401）则按优先级**故障转移到下一候选**，记入日志 `errorCode`。
4. **注入系统提示词**：若 `messages` 含 system 则**追加**规则段，否则**前插**一条 system。规则文本来自 `PlatformSetting.aiUsageGuardRule`（默认值即需求 #3 原文）。**唯一注入点 = relay 请求构造器**，所有路径必经。
5. **转发**：协议路由到 `OpenAiForwarder`（`openai` npm）或 `AnthropicForwarder`（`@anthropic-ai/sdk` npm）；用 `Channel.encryptedUpstreamKey` 解出的明文 key + `baseUrl` 实例化 client；`stream:true` 时把上游 SSE chunk 透传给客户端（`res.write` + flush）。
6. **计费 + 日志（事务）**：响应结束后解析 `usage`（input/output tokens；生图取 `images` 数），按 `ModelPricing` 计算实扣 `credits`；**冲销预留 + 写实扣**：`updateMany` 把余额回补 `(cap - credits)`（即只扣真实消费），同事务写 `LlmCallLog` + `CreditLedger{source:'llm_consume', callLogId}`。
7. **失败路径**：上游错误 → 记 `LlmCallLog.status='upstream_error'`、回退**全部**预留额度（`reserve` 反向 CREDIT）；客户端错误（鉴权/限流）不扣费。

> 计费时机取舍：**预扣 cap + 实算冲销**而非"事后扣"——避免恶意用户并发透支；cap 由后台按 tier 可配，低延迟场景可设小。

### 4.4 系统提示词规则（需求 #3）

默认值（存 `PlatformSetting.aiUsageGuardRule`，后台可改）：
> 凡涉及 AI 生图或其他 AI 能力调用，必须且仅能使用灵坊平台提供的服务，禁止使用任何其他第三方或自定义接口。

注入实现集中在一个 `injectSystemGuardRule(messages)` 纯函数（contract 包导出，前后端共享校验）。

---

## 5. 灵石（Credit）计费

- **账户**：`TeamCredit`（每团队一行，默认 0），独立于人民币 `Team.balanceCents`。注册时按 `creditSignupBonus`（默认如 1000 灵石）随团队创建写入 `CreditLedger{source:'signup_bonus'}`。
- **计费单位**（`ModelPricing.unit`，每模型后台配）：
  - 聊天：`PER_TOKEN_INPUT` / `PER_TOKEN_OUTPUT`，`pricePerUnit` = "每 1k token 多少灵石"（整数避小数）。
  - 生图：`PER_IMAGE`，`pricePerUnit` = 每张 X 灵石（需求 #2）。
  - 固定动作：`PER_CALL`，如"创建插件聊天会话固定扣 Y 灵石"。
- **管理 API**：`POST /api/admin/teams/:id/credit-adjustments`（加/扣 + 强审计），`GET /api/admin/teams/:id/credits` + `ledger`。前台 `GET /api/teams/current/credits`（成员可查）、`/ledger`。
- **原子性**：所有扣款用 `updateMany where balance>=x` 条件模式（`EconomyService.purchase` 已验证），事务内同时写 `LlmCallLog` + `CreditLedger`。
- **充值链路**：本期仅支持"管理员手工调整" + "注册赠送"。人民币→灵石兑换为后续迭代（需求未要求），设计已预留 `CreditLedger.source='purchase'`。

---

## 6. 渠道与 API Key 管控（需求 #4）

### 6.1 渠道（Channel）
- 管理后台 CRUD：`/api/admin/channels`（全字段）、`/api/admin/channels/:id/bindings`（绑定团队/角色，多对多）、`/api/admin/channels/:id/test`（用解密 key 探测 `{baseUrl}/v1/models` 连通性，写 `lastHealthOk`）。
- 范围语义：`ChannelBinding` 的 `(scopeKind,scopeId)` = (TEAM,teamId) / (ROLE,roleId) / (GLOBAL,null)。**同一主体可绑多渠道、一渠道可绑多主体**。
- 路由见 §4.3 步骤 3：范围命中 + 模型/版本命中 + 优先级 + 权重 + 故障转移（one-api 范式）。

### 6.2 平台 API Key
- **不支持用户自定义接口**：桌面和插件不得提供 API Key、API URL、baseUrl、provider 或自定义模型接口配置。插件调用大模型/生图只能使用平台 SDK 能力，允许传 `model`，但它只能是平台模型标识。
- 团队共享 Key 由团队管理员管理：`/api/teams/current/api-keys`（GET 列表 / POST 轮换 / DELETE 吊销，需 `team.api_key.manage`）。轮换时先禁用本团队 active Key，再生成新的无过期 `lf_<random>`，明文仅返回一次，库存只存 `sha256`（`keyHash`）。
- Key 归属团队（`teamId`），用于外部 relay 兼容接入；插件和 Agent 不读取该 Key，运行时使用宿主桥、本地桥 token 或登录态进入 relay。管理端 `/api/admin/api-keys` 提供全局总览/吊销（不做代创建）。

### 6.3 接入文档（需求 #4 末点）
- 后台内置"接入指引"页（`/api/admin/relay-docs` 返回 markdown，前端 `relay-docs-view.tsx` 用既有 `<Markdown>` 渲染）：覆盖 base url、鉴权头、chat/生图请求体示例、快速版/高级版 model 取值、错误码、灵石计费说明——**AI 插件开发者直接照抄**。文档源放 `apps/collab-api/src/modules/relay-docs.content.ts`，随版本一起维护。

---

## 7. 前台版本收敛（需求 #5）

- **移除自定义模型**：`apps/desktop/src/lib/plugin-draft/providers.ts` 删 `CUSTOM_MODEL_SENTINEL` + 自由模型输入；`resolveSendModel` 改为只接受 `'fast'`/`'premium'`。
- **仅两个版本**：创建器/聊天模型选择器替换为二选一开关，`ModelTierConfig` 后台决定底层模型/参数/策略；前台**零 provider/模型知识**。
- **协议级强制**：`/api/relay/v1/models` 只回 `fast`/`premium`；relay 收到其他 `model` 值一律拒（管理后台白名单除外）。

---

## 8. 日志与监控（需求 #6）

- `LlmCallLog` 字段全覆盖：时间、用户、团队、应用/插件（`capability` + 请求摘要）、模型、版本、渠道、灵石消耗、输入/输出 token、生图张数、耗时、HTTP 状态、错误码、requestId、clientIp。
- 管理端"调用日志"页（`call-logs-view.tsx`）：多维度筛选（团队/用户/模型/版本/能力/状态/时间区间）+ 分页（复用 `usePagination`）。导出 CSV 留接口位。
- 看板指标（扩展现有 `admin.service` 的 `adminDashboard`）：近 7 日灵石消耗、调用次数、Top 模型、失败率——走 `LlmCallLog` 聚合索引（§3 已建）。

---

## 9. 关键接口契约（contract 包 `packages/contract/src/` 增量）

新增 `billing.ts` 导出 Zod schema（前后端共享，模式同 `llm.ts`）：
- `ChatRelayInputSchema`（OpenAI shape，`model` 限 `'fast'|'premium'`）
- `MessagesRelayInputSchema`（Anthropic shape）
- `ImageRelayInputSchema`（`prompt`/`size?`/`n?`/`model='fast'|'premium'`）
- `TierSchema` = `z.enum(['fast','premium'])`
- `ChannelSchema` / `ModelPricingSchema` / `ModelTierConfigSchema` / `PlatformApiKeyPublicSchema`（出参，**永不回 `keyHash`/明文 key**，只回 `keyPrefix`）
- `LlmCallLogSchema`
- 错误码扩展现有 `ErrorCode`：`insufficient_balance`(402) / `unsupported_model` / `no_channel_available` / `upstream_llm_error` / `api_key_invalid` / `api_key_disabled` / `capability_denied`。

---

## 10. 迁移与弃用

1. **加表迁移**（`prisma/migrations/`，加性不破坏）。
2. **Seed**：默认 `ModelTierConfig`（FAST→经济模型，PREMIUM→旗舰模型）、默认 `ModelPricing`、把现存"活跃 `LlmGateway`"迁移为一条 `Channel`（`scopeKind=GLOBAL`）、`creditSignupBonus` 配置项。
3. **桌面重指向**：`llm_credentials.rs` + `code_assistant.rs` 把 `apiUrl` 改为 `{backend}/api/relay`，移除 decrypt-上游-key 路径（relay 用平台 key 转发，桌面只持 JWT）。
4. **ai-wardrobe 重写**：`api.py` 删除硬编码 key，改调 `sdk.image.generate()`（见 §11）。
5. **保表过渡**：`TenantLlmBinding` / `LlmGateway` 保留一个版本（旧桌面客户端兼容），随后 drop。

---

## 11. 分阶段实施路线（设计 + 立即实现）

每阶段独立可发，含 `*.spec.ts` 单测（既有模式）+ 冒烟验证。

| 阶段 | 交付 | 关键文件 |
|---|---|---|
| **P0 基础设施** | Prisma schema 增量 + migration + seed；`DualAuthGuard`；`contract/billing.ts` | `prisma/schema.prisma`、`src/security.ts`、`packages/contract/src/billing.ts`、`seed-credits-channels.ts` |
| **P1 Relay 核心** | `RelayController/Service` + `OpenAi/AnthropicForwarder` + 流式透传 + 版本路由 + 系统提示词注入 + 事务计费/日志 | `modules/relay.controller.ts`、`relay.service.ts`、`forwarders/*.ts` |
| **P2 灵石账户** | `CreditService`（余额/流水/注册赠送/调整）+ 团队/个人余额接口 + `402` 错误链路 | `modules/credit.service.ts`、`credits.controller.ts` |
| **P3 渠道与定价** | `ChannelService` + `ChannelRouterService` + `ModelPricing/Tier` CRUD + 渠道健康测试 | `modules/channel.service.ts`、`channel.controller.ts` |
| **P4 API Key** | `PlatformApiKeyService` + `/api/teams/current/api-keys` + `/api/admin/api-keys` | `modules/api-key.service.ts` |
| **P5 管理后台页** | collab-admin 新增视图：渠道、计费、版本、灵石、调用日志、接入文档；`NAV_GROUPS` 扩"计费与模型"分组 | `apps/collab-admin/src/components/{channels,billing,tiers,credits,call-logs,relay-docs}-view.tsx`、`lib/navigation.ts` |
| **P6 桌面前台** | 删 `ModelGatewayTab` → 设置页只读模型版本；团队共享 Key 进入团队管理页；插件/Agent 通过平台 SDK/relay 调用模型 | `pages/settings/*`、`pages/team-admin/*`、`lib/agent/*`、`packages/plugin-sdk/src/index.ts` |
| **P7 生图与插件 SDK** | relay 生图端点 + `sdk.image.generate()` + ai-wardrobe 重写 + 接入文档 | `relay.service.ts`(image)、`packages/plugin-sdk/src/index.ts`、`builtin-plugins/ai-wardrobe/api.py` |
| **P8 清理** | 弃用 `TenantLlmBinding`/`LlmGateway` drop；更新 `docs/03`、`collab-api.md`、`collab-desktop-client.md`、`02-domain` | 文档 |

**建议从 P0 起按序实现**；P1+P2 是"能看到端到端计费"的最小闭环。

---

---

## 11.5 客户端与管理端页面设计（UI/UX 细节）

> 设计基线：管理端复用 `Section / Table / Dialog / ActionBar / StatusBadge / InfoGrid / usePagination / useLoad / run / api`（见 `audit-view.tsx`、`providers-view.tsx`）；客户端复用 `Card / Shimmer / StaggerContainer/StaggerItem / motion`（见 `Wallet.tsx`）。下面给每页的**位置、布局、交互、线框**，落地时按既有 className 风格（`text-muted-foreground`、`tabular-nums`、`sm:max-w-lg` 等）实现。

### 11.5.1 管理端（apps/collab-admin）

**导航变更**（`lib/navigation.ts` `NAV_GROUPS`）：新增"**计费与模型**"分组，置于"内容"与"系统"之间：

```
核心管理 : 仪表盘 / 用户管理 / 团队管理
内容     : 插件管理 / 审批管理 / 模型服务(旧,过渡期保留)
计费与模型: 渠道管理 / 计费配置 / 模型版本 / 灵石账户 / 调用日志 / 接入文档   ← 新增组
系统     : 角色管理 / 平台管理员 / 审计日志 / API Key 总览 / 版本发布 / 平台设置
```

`View` 类型（`lib/types.ts`）扩展 7 个新值：`channels | billing | modelTiers | credits | callLogs | relayDocs | apiKeys`。`App.tsx` 按 `providers-view.tsx` 同款 `lazy(() => import(...))` 注册。

#### ① 渠道管理 `ChannelsView`（仿 `providers-view.tsx`）

布局：`Section` + 工具栏（计数 + "新增渠道"）+ `Table` + 分页 + 创建/编辑 `Dialog` + 绑定管理子 `Dialog` + 健康测试按钮。

```
┌─ 模型服务 / 渠道管理 ────────────────────────────────────────────────┐
│ 维护上游渠道、范围绑定与故障转移策略。                               │
│   [3 个渠道]                                        [+ 新增渠道]    │
│ ┌──────────┬────────┬────────────┬─────────┬──────┬──────┬────────┐ │
│ │名称      │协议    │上游基址     │适用范围  │优先级│健康  │操作    │ │
│ │OpenAI 官 │OpenAI  │api.openai..│全局      │100   │● 通 │编辑/删 │ │
│ │Anthropic │Anthropic│api.anthropic│团队×2  │100   │○ 未测│/测试/绑│ │
│ │DeepSeek  │OpenAI  │api.deepseek│角色:高级│200   │● 通 │/定启用 │ │
│ └──────────┴────────┴────────────┴─────────┴──────┴──────┴────────┘ │
│                                              < 1 2 3 > 20/页        │
└────────────────────────────────────────────────────────────────────┘
```
- **创建/编辑 Dialog**（`ProviderFormFields` 同款网格）：名称、协议(Select: OpenAI/Anthropic)、provider(白名单 Select)、上游基址(Input)、**上游 API Key**(Input type=password，编辑态显示"已配置"占位，复用 providers-view 的 hasKey 模式)、支持模型(Textarea 一行一个)、支持版本(Checkbox: 快速版/高级版)、优先级(number)、权重(number)、状态(Select ENABLED/DISABLED)。
- **绑定管理 Dialog**：`ChannelBinding` 多对多列表——已绑定主体(团队/角色)表格 + "添加绑定"(Select 主体类型 + 搜索选择)。满足"单主体单/多渠道"。
- **健康测试**：`ActionBar` 按钮 → `POST /api/admin/channels/:id/test` → toast 连通结果 + 刷新 `lastHealthOk` 列(●/○)。
- **范围列**渲染：GLOBAL→"全局"；TEAM→"团队×N"；ROLE→"角色:高级版"。

#### ② 计费配置 `BillingView`（定价 + 全局参数，`settings-view.tsx` 同款分区）

布局：`Section` 上下两块——上为"**全局参数**"(PlatformSetting 键值表单)，下为"**模型定价**"CRUD 表。

```
┌─ 计费配置 ──────────────────────────────────────────────────────────┐
│ ▸ 全局参数                                                          │
│   注册赠送灵石 [1000]   快速版预扣上限 [200]   高级版预扣上限 [2000] │
│   系统提示词规则 [凡涉及 AI 生图或…必须且仅能使用灵坊平台…(Textarea)]│
│                                              [保存参数]             │
│                                                                     │
│ ▸ 模型定价                                  [+ 新增定价]            │
│ ┌──────────┬──────┬────────────┬──────────┬────────┬──────┬──────┐ │
│ │能力      │版本  │模型/动作    │计费单位  │单价(灵石)│启用  │操作  │ │
│ │chat      │高级版│claude-sonnet│每1k输入tok│  2    │●    │编/删 │ │
│ │chat      │快速版│gpt-4o-mini  │每1k输出tok│  1    │●    │编/删 │ │
│ │image     │—    │dall-e-3     │每张      │ 50    │●    │编/删 │ │
│ │action    │—    │create_plugin_session│每次│ 10  │●    │编/删 │ │
│ └──────────┴──────┴────────────┴──────────┴────────┴──────┴──────┘ │
└────────────────────────────────────────────────────────────────────┘
```
- **全局参数**：复用 `KEY_VALIDATORS` 模式新增 `creditSignupBonus`/`creditReserveCapFast`/`creditReserveCapPremium`/`aiUsageGuardRule` 校验器；`PATCH /api/admin/settings` 批量保存(已存在)，`aiUsageGuardRule` 是 Textarea(多行)。
- **定价 CRUD**：`ModelPricing` 表，Dialog 字段 = 能力(Select chat/image/action) + 版本(Select,action 时禁用) + 模型/动作(Input) + 计费单位(Select) + 单价(number) + 启用(Switch)。`(capability,model,tier)` 唯一。

#### ③ 模型版本 `ModelTiersView`（快速版/高级版底层映射，2 行固定表）

布局：`Section` + 2 张并排 `Card`（快速版 / 高级版），每张 Card 内是可编辑表单。

```
┌─ 模型版本 ──────────────────────────────────────────────────────────┐
│ 前台仅显示这两个版本，底层模型与参数在此配置。                      │
│ ┌── 快速版 ────────────┐  ┌── 高级版 ────────────┐                  │
│ │聊天模型 [gpt-4o-mini]│  │聊天模型 [claude-sonnet]│                 │
│ │生图模型 [dall-e-2  ] │  │生图模型 [dall-e-3    ] │                 │
│ │temperature [0.7]     │  │temperature [0.5]      │                 │
│ │maxTokens   [4096]    │  │maxTokens   [8192]     │                 │
│ │              [保存]  │  │              [保存]   │                 │
│ └──────────────────────┘  └───────────────────────┘                 │
└────────────────────────────────────────────────────────────────────┘
```
- 保存 = `PUT /api/admin/model-tiers/:tier`（upsert）。前台拉 `/api/relay/v1/models` 拿到这两个 label。

#### ④ 灵石账户 `CreditsView`（团队余额总览 + 调整 + 流水）

布局：`Section` + 团队筛选(Select) + 余额摘要 + `Table`(团队余额) + 行内"调整"/"流水"操作。

```
┌─ 灵石账户 ──────────────────────────────────────────────────────────┐
│ 团队 [▼ 全部团队]      平台总流通: 1,250,000 灵石                   │
│ ┌──────────┬──────────┬────────────┬──────────────────────────────┐ │
│ │团队      │余额(灵石)│成员         │操作                          │ │
│ │灵坊工作室│ 8,200    │12           │[调整余额] [查看流水]         │ │
│ │某企业A   │  120     │3            │[调整余额] [查看流水]         │ │
│ └──────────┴──────────┴────────────┴──────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```
- **调整余额 Dialog**：金额(Input,正数) + 方向(Select 加款/扣款) + 原因(Input) → `POST /api/admin/teams/:id/credit-adjustments`，强审计。复用 `teams-view` 已有的 `balance-adjustments` 交互范式（人民币余额已有同款端点，灵石并行）。
- **流水 Dialog**：`CreditLedger` 列表（时间/来源/方向/金额/触发者/关联调用），仿 `audit-view` 的详情 Dialog 表格。

#### ⑤ 调用日志 `CallLogsView`（仿 `audit-view.tsx`，多维筛选）

布局：`Section` + 工具栏(关键词 + 多 Select 筛选 + 刷新) + `Table` + 详情 Dialog + 分页。

```
┌─ 调用日志 ──────────────────────────────────────────────────────────┐
│ [🔍 用户/模型/requestId] 团队[▼] 能力[▼] 版本[▼] 状态[▼] 时间[▼] [刷新]│
│ ┌──────────┬────────┬──────┬──────┬──────┬──────┬──────┬──────┬────┐ │
│ │时间      │团队/用户│能力  │版本  │模型  │灵石  │耗时  │状态  │详情│ │
│ │06-22 14:3│灵坊/张三│chat  │高级  │sonnet│ 12  │2.1s │●成功 │👁  │ │
│ │06-22 14:2│某企业A  │image │—     │dall-e│ 50  │8.4s │●成功 │👁  │ │
│ │06-22 14:1│灵坊/李四│chat  │快速  │4o-mini│ 0  │0.3s │○余额 │👁  │ │
│ └──────────┴────────┴──────┴──────┴──────┴──────┴──────┴──────┴────┘ │
│                                          < 1 2 … 50 > 20/页          │
└────────────────────────────────────────────────────────────────────┘
```
- **筛选**：后端 `GET /api/admin/call-logs?teamId&userId&capability&tier&status&model&q&from&to&page`（`audit-view` 的 debounce+URLSearchParams 模式直接套）。
- **详情 Dialog**（仿 `AuditDetailDialog`）：InfoGrid 展示 inputTokens/outputTokens/images/channel/credits/httpStatus/errorCode/clientIp + `requestSummary` JSON（折叠 `<pre>`）。
- **状态列**：`StatusBadge` 扩展（success/upstream_error/client_error/insufficient_balance/rate_limited）。

#### ⑥ API Key 总览 `ApiKeysView`（平台管理员视角）

布局：`Section` + `Table`(所有 key) + 吊销操作。**不做代创建**（key 由用户/团队自己在客户端创建）。

```
┌─ API Key 总览 ──────────────────────────────────────────────────────┐
│ ┌──────────┬────────┬──────────┬────────┬──────────┬──────┬──────┐  │
│ │Key 前缀  │名称    │团队      │scopes  │最近使用  │状态  │操作  │  │
│ │lf_3f9a…  │测试key │灵坊工作室│chat,fast│06-22     │●启用│[吊销]│  │
│ └──────────┴────────┴──────────┴────────┴──────────┴──────┴──────┘  │
└────────────────────────────────────────────────────────────────────┘
```
- `DELETE /api/admin/api-keys/:id`（吊销），强审计。

#### ⑦ 接入文档 `RelayDocsView`（需求 #4 末点）

布局：`Section` + 全宽 `<Markdown>`（复用 `apps/collab-admin/src/lib/markdown.tsx`）。文档源由后端 `GET /api/admin/relay-docs` 返回（`relay-docs.content.ts` 维护），含：base url、鉴权头、快速版/高级版 model 取值、chat/生图 curl 示例、错误码表、计费说明。

### 11.5.2 客户端（apps/desktop）

#### ① 设置页 Tab 重构（`pages/Settings.tsx`）

当前三 Tab：`cli / gateway / backend`。**移除 `gateway`(ModelGatewayTab，BYOK)**，改为：
```
设置: [脚本环境] [模型与计费] [后端地址]
```
新 Tab `ModelGatewayTab`→重命名 **`BillingTab`**（`pages/settings/BillingTab.tsx`），内含两块 Card：

```
┌─ 模型与计费 ────────────────────────────────────────────────────────┐
│ ┌ 🔮 团队灵石余额 ──────────────────────────────────────────────┐  │
│ │  当前余额        8,200 灵石                                    │  │
│ │  [查看流水 ▾]（展开最近 20 条：+注册赠送/-chat/sonnet/-image） │  │
│ └────────────────────────────────────────────────────────────────┘  │
│ ┌ 🔑 团队共享 API Key（团队管理页，仅管理员）──────────────────────┐  │
│ │ 外部 relay 兼容接入使用；插件和 Agent 不读取、不展示此 Key。     │  │
│ │ lf_3f9a****   团队共享 Key   [全部能力]   06-22   [轮换][吊销]  │  │
│ └────────────────────────────────────────────────────────────────┘  │
│ ┌ ℹ️ 模型版本 ──────────────────────────────────────────────────┐  │
│ │ 当前可用：● 快速版（gpt-4o-mini）  ● 高级版（claude-sonnet）  │  │
│ │ 底层模型由平台统一配置。                                       │  │
│ └────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```
- **余额 Card**：`GET /api/teams/current/credits` → `Shimmer` 骨包余额 + `StaggerContainer` 流水（直接套 `Wallet.tsx` 的视觉范式，把 `centsToYuan` 换成"灵石整数"）。**不再有"填 apiKey"输入框**。
- **团队共享 API Key Card**：在团队管理页展示，需 `team.api_key.manage`。`GET /api/teams/current/api-keys` 列表（`keyPrefix`+`name`+scopes Badge）；`POST /api/teams/current/api-keys` 轮换并只在本次返回明文；`DELETE /api/teams/current/api-keys/:id` 吊销。
- **模型版本 Card**：`GET /api/relay/v1/models` 回显 label，只读。

#### ② 创建器/聊天模型选择器（`components/creator/*`、`plugin-draft/providers.ts`）

移除 `CUSTOM_MODEL_SENTINEL` + 自由模型 Input + provider 选择。替换为**分段开关**：

```
┌──────────────────────────────┐
│ 模型版本                      │
│ ┌─────────┬─────────┐        │
│ │ ⚡ 快速版 │ ✦ 高级版 │        │   ← Segmented（shadcn/ui ToggleGroup）
│ └─────────┴─────────┘        │
│ 当前：gpt-4o-mini（平台配置） │
└──────────────────────────────┘
```
- 发送时 `model` 固定为 `'fast'` 或 `'premium'`（`resolveSendModel` 简化为二选一）。Rust 端 `code_assistant.rs` 把 `--model fast/premium` 透传给 relay，relay 解析为 `ModelTierConfig.chatModel`。

#### ③ 钱包页（`pages/Wallet.tsx`）

现有"我的钱包(人民币)"页。**新增并列"团队灵石"Card**（或顶部 Tab 切换"人民币/灵石"）。灵石 Card 复用 `Wallet.tsx` 的 motion 流水范式，`reason` 映射：`signup_bonus→注册赠送`、`llm_consume→AI 对话消费`、`image_consume→AI 生图消费`、`admin_adjust→管理员调整`、`refund→退款`。

#### ④ 团队管理员页（`pages/TeamAdmin/*`）

团队管理员当前能看人民币余额。新增"**团队灵石余额**"卡片 + 流水入口（`team.balance.view` 权限已有，扩展一个 `team.credits.view`）。团队管理员**不能**改灵石余额（仅平台 Admin 可调整，与人民币 `balance-adjustments` 仅平台 Admin 一致）。

#### ⑤ 移除项清单（确保"前台零自定义"）

- 删 `components/creator/*` 中模型 Input / provider Select / `CUSTOM_MODEL_SENTINEL` UI。
- 删 `Settings.tsx` 旧 `ModelGatewayTab`（apiKey 输入 / 拉取模型 checkbox 组）。
- 删 `lib/llm-fetch.ts` 的 `fetchModels`(用户 key 拉模型) —— 改为 relay 的 `/v1/models`。
- Rust `llm_credentials.rs` 的 `decrypt` 路径删除；`code_assistant.rs` 指向 relay。

### 11.5.3 设计原则与复用映射

| 关注点 | 既有可复用资产 |
|---|---|
| 管理端 CRUD 页骨架 | `providers-view.tsx`（Dialog+Form+Table）、`audit-view.tsx`（筛选+搜索+分页+详情 Dialog） |
| 管理端表单/展示件 | `Section`、`InfoGrid`、`ActionBar`、`StatusBadge`、`ui/{table,dialog,input,select,checkbox,switch,pagination,label,badge}` |
| 客户端卡片/动效 | `Card`、`Shimmer`、`StaggerContainer/StaggerItem`（`Wallet.tsx`）、`motion.tsx` |
| 数据拉取 | 管理端 `api()`+`useLoad`+`run`+`usePagination`；客户端 `api()`+`useEffect` |
| 导航 | `NAV_GROUPS`（管理端）、`Sidebar`（客户端） |
| Markdown 渲染 | 两端均有 `lib/markdown.tsx`（接入文档页） |

**交互一致性约束**：① 危险操作（吊销 key / 删渠道 / 扣灵石）一律 `window.confirm`（同 `providers-view.remove`）；② 创建类 Dialog 仅成功才关闭并清空表单（同 `CreateProviderDialog`）；③ 列表加载用骨架而非空白（同 `Wallet`）；④ 金额类用 `tabular-nums` 对齐。

---

## 12. 验证（端到端）

```bash
# 后端
pnpm -C apps/collab-api prisma:generate
pnpm collab:api:migrate           # 应用新 migration
pnpm collab:api:seed              # seed 渠道/版本/定价 + 管理员
pnpm collab:api:dev               # 起 NestJS（含 /api/docs Swagger）

# P1/P2 闭环冒烟（curl）
# 1) 团队管理员轮换团队共享 API Key（JWT 登录后）
curl -X POST http://127.0.0.1:3000/api/teams/current/api-keys -H 'Authorization: Bearer <jwt>' \
  -d '{"name":"团队共享 Key","scopes":["*"]}'
# 2) 经 relay 调快速版聊天（流式）
curl -N http://127.0.0.1:3000/api/relay/v1/chat/completions \
  -H 'Authorization: Bearer lf_xxx' -H 'Content-Type: application/json' \
  -d '{"model":"fast","messages":[{"role":"user","content":"hi"}],"stream":true}'
# 3) 断言：SSE 流回 + 团队灵石扣减 + LlmCallLog 有一条 success

# 管理端
pnpm collab:admin:dev             # 渠道/定价/灵石/日志 各页 CRUD + 查询

# 桌面
pnpm dev:desktop                  # 创建器保留平台 model；设置页只读模型版本；团队管理页轮换共享 Key
```

**单测要点**（沿用现有 `*.spec.ts`）：
- `channel-router.spec`：范围命中/优先级/权重/故障转移。
- `credit.service.spec`：并发扣款竞态（条件 `updateMany`）、预留冲销、余额不足 402。
- `relay.service.spec`：版本路由、系统提示词注入位置、token 计费、流式 usage 解析、上游错误回退额度。
- `api-key.spec`：sha256 比对、scopes 强制、吊销生效。

**完成判据**：① relay 两协议端到端通且灵石扣减正确；② 后台可动态改单价/版本/渠道且即时生效；③ 调用日志各维度可查；④ 前台无任何"自定义模型/key"入口；⑤ ai-wardrobe 生图走平台且按张扣费；⑥ 系统提示词每条调用都含规则段。

---

## 13. 实现注意事项（风险与对策）

- **流式计费准确性**：OpenAI/Anthropic 流式响应在最后一个 chunk 带 `usage`（需 `stream_options:{include_usage:true}` / Anthropic `message_delta` 的 `usage`）；务必解析末尾 usage，缺失时回退"按 cap 全扣"。
- **密钥安全**：`Channel.encryptedUpstreamKey` 复用 `credential-cipher`（AES-256-GCM），审计永不记明文/密文（同 `llm.service` 范式）；`PlatformApiKey` 只存 sha256。
- **日志脱敏**：`LlmCallLog.requestSummary` 只存元数据（model/temperature/size/n），**不存 prompt 全文**（PII + 体积）；pino redact 已覆盖 `apiKey`/`authorization`。
- **限流**：relay 端点用 `@Throttle` 单独收紧（防刷灵石）；全局 `ThrottlerGuard` 已在。
- **事务边界**：预留→转发→冲销三段，预留与冲销各为一个事务；转发（HTTP）不在事务内。失败必须回退预留（finally）。
- **与既有 RBAC 共存**：管理端用 `@RequirePermission`（新增权限码 `billing.*`/`channel.*` 到 `permission-codes.ts` + seed）；relay 用 `DualAuthGuard`（在 `JwtAuthGuard` 前 `@Public` 放行）。
- **向后兼容窗口**：旧桌面客户端仍在调 `/api/llm/active-provider` + `/binding/decrypt`——P0–P7 期间这两个端点保留（内部改读 Channel 并返回 relay 地址作 `apiUrl`），P8 再删，避免强制升级。
