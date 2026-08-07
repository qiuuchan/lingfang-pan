# 模型网关定稿（单 provider 云分发 + 无 provider UI）

## Goal（目标）

模型网关定稿：**应用界面完全没有 provider 概念**，用户只看到「一个 apiKey 输入 + 拉取模型 + 模型选择」。平台 Admin 后台维护多个 provider 配置，但同一时间只有一个「当前启用」的 provider——应用拉取这个 provider 的 url，用户填 key 用它。Admin 切 provider，用户无感知（只需重新填 key + 拉模型）。

## 背景（为什么改，第三版定稿）

模型网关已经做了两版，都不对：

- **v1**（settings-cli-runtime-model-gateway）：网关目录让租户选 + 静态模型勾选。错在让用户感知「网关目录」+ 模型是静态的。
- **v2**（model-gateway-redo-fetch-models）：选 provider + 填 key + Rust 拉取模型。对了一半（动态拉取），但仍让用户**选 provider**。
- **v3（本任务，定稿）**：用户**完全不感知 provider**。平台 Admin 管多 provider + 设一个「当前启用」，应用只拿当前启用的 url。用户界面只有 key + 模型。

## Scope（范围）

### 后端 collab-api

#### 数据模型变更（schema 迁移）

- **`LlmGateway` 表**：加 `isActive Boolean @default(false)` 字段。同一时间最多一条 `isActive=true`（service 层事务维护唯一性：设新的 active 时先把同表其他置 false）。保留多 provider 记录（Admin 维护列表）。
- **`TenantLlmBinding` 表**：**去掉 `gatewayId`**，改成 `teamId @unique`（一个团队一条 apiKey 绑定）。去掉 `provider` 冗余字段（不再绑特定 provider）。保留 `encryptedApiKey`/`apiKeyHint`/`keyFingerprint`/`enabled`/`modelOverride`/`createdById`/`updatedById`。`gateway` 关系删除。
- 迁移：删 `teamId_gatewayId` 唯一约束 + 加 `teamId @unique`；加 `LlmGateway.isActive`；binding 的 gateway FK 删除（`onDelete: Restrict` 不再需要）。

#### 端点变更

- **新增 `GET /api/llm/active-provider`**（`@Public` 或 ensureCurrentTeam）：返回**当前启用 provider** 的 `{ apiUrl, defaultModels }`（不返回其他 provider，不暴露「有多个」）。无启用 provider → 404 `no_active_provider`。
- **改 `GET /api/llm/gateways`** → 废弃或保留给 Admin。租户侧不再用（用 active-provider 替代）。
- **`PUT /api/llm/binding`**：入参去掉 `gatewayId`（只 `{ apiKey, enabled?, modelOverride? }`）。upsert 改为按 `teamId` 唯一。
- **`GET /api/llm/binding`**：返回当前团队的单条绑定（无 gatewayId 字段）。
- **`POST /api/llm/binding/decrypt`**：去掉 `:gatewayId` 路径参数（按 teamId 取唯一绑定）。
- **Admin 端点**：`GET/POST/PATCH /api/admin/llm-providers`（CRUD provider 列表）+ `PATCH /api/admin/llm-providers/:id/activate`（设当前启用，事务维护唯一 active）。

#### service 改造

- `upsertBinding`：按 teamId upsert（不再 teamId+gatewayId）。去掉 gateway 存在性/ENABLED 校验（无 gatewayId 了）。
- `decryptBindingKey`：按 teamId 取唯一绑定。
- 新 `getActiveProvider()`：查 `LlmGateway.findFirst({ where: { isActive: true, status: ENABLED } })`。
- 新 `adminActivateProvider(id)`：`$transaction` 先把所有 isActive 置 false，再把目标置 true。

### 桌面端 Rust

- `fetch_models` 命令：**不变**（已经只接收 apiUrl + apiKey，不含 provider 概念）。前端从 `active-provider` 端点拿 apiUrl 传给它。

### 前端 ModelGatewayTab（再次重写）

- 去掉 provider 下拉/选择。
- UI：**一个 apiKey 输入框 + 「拉取模型」按钮 + 模型 checkbox 组 + 保存**。
- 挂载：`GET /api/llm/active-provider` 拿当前 provider 的 apiUrl + `GET /api/llm/binding` 拿当前绑定（脱敏 hint + modelOverride）。
- 拉取模型：`tauriInvoke('fetch_models', { apiUrl: activeProvider.apiUrl, apiKey })`。
- 保存：`PUT /api/llm/binding { apiKey, modelOverride }`（无 gatewayId）。
- 错误：`no_active_provider` → 提示「平台尚未配置模型服务，请联系管理员」。

### Admin 后台 collab-admin（新页面）

- 新增 provider 管理页：
  - provider 列表（name + apiUrl + isActive 标记）。
  - 新增/编辑/删除 provider（name + apiUrl + 默认模型）。
  - 「设为当前启用」按钮（调 activate 端点）。
- 接入 collab-admin 现有路由/布局（参考 release 管理页模式）。

## Constraints（约束）

- 简体中文。UTF-8 无 BOM。专用工具操作文件。
- **用户界面零 provider 概念**（AC 核心）：apiKey 输入 + 拉取模型 + 模型选择，不出现 provider/网关/源 等词。
- 复用：加密（credential-cipher）、审计、ensureTeamAdmin、fetch_models Rust 命令全保留。
- apiKey 后端加密存 + 跨电脑（不变）。
- 破坏式：TenantLlmBinding 去 gatewayId（不向后兼容，迁移处理旧数据）。

## Acceptance Criteria

- [ ] AC1 应用设置页模型网关：**只有 apiKey 输入 + 拉取模型 + 模型选择**，无 provider/网关字样。
- [ ] AC2 填 apiKey → 拉取模型 → 显示当前启用 provider 的真实可用模型。
- [ ] AC3 Admin 后台能维护多 provider 列表 + 设一个「当前启用」。
- [ ] AC4 Admin 切换「当前启用」provider 后，应用下次拉取用新 provider 的 url（用户无感知切换，只需重填 key）。
- [ ] AC5 同一时间只有一个 provider 是 active（事务维护唯一）。
- [ ] AC6 TenantLlmBinding 去 gatewayId，teamId 唯一（一个团队一条 key 绑定）。
- [ ] AC7 平台未配 active provider → 应用提示「平台尚未配置模型服务」。
- [ ] AC8 key 无效/网络错/provider 不兼容 → 友好提示（复用 v2 的错误码前缀）。
- [ ] AC9 跨电脑：apiKey 加密存后端，B 电脑登录同团队能看到绑定（脱敏）+ decrypt 拿明文。
- [ ] AC10 全量验证绿：collab-api test + cargo test + desktop typecheck/test/build + collab-admin typecheck/build。

## 分阶段（渐进式）

- 阶段1 后端：schema 迁移（去 gatewayId + 加 isActive）+ service/controller 改造 + active-provider 端点 + Admin provider CRUD + 单测。
- 阶段2 桌面：fetch_models 不变（验证）；前端 ModelGatewayTab 重写（去 provider）。
- 阶段3 Admin UI：collab-admin provider 管理页。
- 阶段4 验证：seed 一个 active provider + 手动填 key 拉模型。

## Notes

- 这是模型网关第三版（定稿）。v1/v2 的 fetch_models Rust 命令 + 加密 + 审计复用，主要改 schema + 端点 + UI。
- design.md 写技术设计（schema 迁移 SQL/端点契约/UI 布局/唯一 active 事务）。
- 用户决策已固化：① 用户界面零 provider ② 平台多 provider 应用拿当前启用 ③ TenantLlmBinding 去 gatewayId teamId 唯一 ④ Admin UI 本次一起做。
