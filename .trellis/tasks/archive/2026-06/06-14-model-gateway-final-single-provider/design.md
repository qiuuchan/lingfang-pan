# 技术设计：模型网关定稿（单 provider 云分发 + 无 provider UI）

> 配套 `prd.md`。这是模型网关第三版（定稿）。v1/v2 的加密/审计/fetch_models Rust 命令复用，主要改 schema + 端点 + UI。

## 1. 数据流（定稿）

```
Admin 后台（collab-admin providers 页）
  ├─ 维护 provider 列表（GET/POST/PATCH /api/admin/llm-providers）
  └─ 设当前启用（PATCH /api/admin/llm-providers/:id/activate → 事务唯一 active）

应用设置页（桌面 ModelGatewayTab）
  ├─ 挂载: GET /api/llm/active-provider（拿当前启用 provider 的 apiUrl）
  │       + GET /api/llm/binding（当前团队绑定，脱敏 hint）
  ├─ 用户填 apiKey
  ├─ 点「拉取模型」→ tauriInvoke('fetch_models', { apiUrl, apiKey })  // apiUrl 来自 active-provider
  ├─ 选模型
  └─ 保存 → PUT /api/llm/binding { apiKey, modelOverride }  // 无 gatewayId
```

**核心**：应用只感知「一个 provider 的 url」（当前启用），用户界面零 provider 概念。

## 2. 数据模型变更（schema 迁移）

### 2.1 LlmGateway 加 isActive

```prisma
model LlmGateway {
  // ... 现有字段 ...
  isActive Boolean @default(false)   // 新增：当前启用 provider（全表最多一条 true）
  @@index([status, sortOrder])
  @@index([isActive])               // 新增索引（active 查询用）
}
```

### 2.2 TenantLlmBinding 去 gatewayId（破坏式）

```prisma
model TenantLlmBinding {
  id              String     @id @default(uuid())
  teamId          String     @unique          // 改：去 gatewayId，teamId 唯一（一个团队一条 key）
  // gatewayId 删除
  // provider 删除（不再绑特定 provider）
  encryptedApiKey String
  apiKeyHint      String     @default("")
  keyFingerprint  String     @default("")
  enabled         Boolean    @default(true)
  modelOverride   Json?
  createdById     String?
  updatedById     String?
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt
  team            Team       @relation(fields: [teamId], references: [id], onDelete: Cascade)
  // gateway 关系删除
  createdBy       User?      @relation("BindingCreator", fields: [createdById], references: [id], onDelete: SetNull)
  updatedBy       User?      @relation("BindingUpdater", fields: [updatedById], references: [id], onDelete: SetNull)
  // @@unique([teamId, gatewayId]) 删除 → teamId @unique
}
```

### 2.3 迁移 SQL（`prisma migrate dev --name llm_single_provider`）

- `ALTER TABLE "LlmGateway" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT false;`
- `CREATE INDEX "LlmGateway_isActive_idx" ON "LlmGateway"("isActive");`
- `DELETE FROM "TenantLlmBinding"` 或迁移旧数据（首版无生产数据，直接删旧 binding 重建最简；若有数据保留：保留每 teamId 最新一条，去重）。
- `ALTER TABLE "TenantLlmBinding" DROP CONSTRAINT "teamId_gatewayId"` （删旧唯一约束）。
- `ALTER TABLE "TenantLlmBinding" DROP COLUMN "gatewayId"` + `DROP COLUMN "provider"`。
- `ALTER TABLE "TenantLlmBinding" ADD CONSTRAINT "teamId_unique" UNIQUE ("teamId");`
- `ALTER TABLE "TenantLlmBinding" DROP CONSTRAINT "gateway FK"`（删 gateway 外键）。

Team model 的 `bindings` 反向关系保留。User 的 createdLlmBindings/updatedLlmBindings 保留。

## 3. 后端端点（collab-api）

### 3.1 租户端点（改 + 新增）

| 方法   | 路径                       | 入参                                                       | 出参                                                                                             |
| ------ | -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET    | `/api/llm/active-provider` | —                                                          | `{ apiUrl, name?, defaultModels: string[] }`（当前启用 provider；无则 404 `no_active_provider`） |
| GET    | `/api/llm/binding`         | —                                                          | `{ binding: TenantBindingPublic \| null }`（单条，无 gatewayId）                                 |
| PUT    | `/api/llm/binding`         | `{ apiKey, enabled?, modelOverride? }`（**无 gatewayId**） | `{ binding }`（teamId upsert）                                                                   |
| DELETE | `/api/llm/binding`         | —                                                          | `{ ok: true }`（删 teamId 唯一绑定）                                                             |
| POST   | `/api/llm/binding/decrypt` | —                                                          | `{ apiKey: string }`（按 teamId 取唯一绑定解密）                                                 |

> `GET /api/llm/gateways` 废弃（租户不用，Admin 用 `/api/admin/llm-providers`）。

### 3.2 Admin 端点（新）

| 方法   | 路径                                    | 鉴权                | 用途                                             |
| ------ | --------------------------------------- | ------------------- | ------------------------------------------------ |
| GET    | `/api/admin/llm-providers`              | ensurePlatformAdmin | provider 列表（含 isActive 标记）                |
| POST   | `/api/admin/llm-providers`              | ensurePlatformAdmin | 新增 provider                                    |
| PATCH  | `/api/admin/llm-providers/:id`          | ensurePlatformAdmin | 编辑 provider                                    |
| DELETE | `/api/admin/llm-providers/:id`          | ensurePlatformAdmin | 删除（active 的不允许删，或删时自动取消 active） |
| PATCH  | `/api/admin/llm-providers/:id/activate` | ensurePlatformAdmin | **设为当前启用**（$transaction 唯一 active）     |

旧的 `/api/admin/llm-gateways` 路由替换为 `/api/admin/llm-providers`（或保留别名，首版直接改名）。

### 3.3 service 改造（llm.service.ts）

- `getActiveProvider()`：`prisma.llmGateway.findFirst({ where: { isActive: true, status: 'ENABLED' } })`，无则抛 `AppError(404, 'no_active_provider', '平台尚未配置模型服务')`。
- `listBindings(actorId)`：ensureCurrentTeam，查 `tenantLlmBinding.findUnique({ where: { teamId } })`（单条）。
- `upsertBinding(actorId, dto)`：ensureTeamAdmin，按 teamId upsert（`where: { teamId }`）。apiKey 可选语义保留。
- `deleteBinding(actorId)`：ensureTeamAdmin，按 teamId 删。
- `decryptBindingKey(actorId)`：ensureTeamAdmin，按 teamId 取唯一绑定解密。
- `adminActivateProvider(actorId, id)`：ensurePlatformAdmin + `$transaction`：
  ```ts
  await prisma.$transaction(async (tx) => {
    await tx.llmGateway.updateMany({ where: { isActive: true }, data: { isActive: false } });
    await tx.llmGateway.update({ where: { id }, data: { isActive: true } });
  });
  ```
- 去掉所有 gatewayId 相关逻辑（upsert 的 gateway 存在性校验、gateway_disabled 错误等）。

### 3.4 DTO（llm.dto.ts）

- `BindingUpsertDto`：去 `gatewayId`，只 `{ apiKey?, enabled?, modelOverride? }`。
- 新 `ProviderCreateDto` / `ProviderUpdateDto`：`{ name, apiUrl, models?, description?, sortOrder? }` + `isActive`（创建时不设，通过 activate 端点）。
- 契约 `packages/contract/src/llm.ts` 同步：`TenantBindingPublic` 去 gatewayId/provider/gatewayModels/effectiveModels（改成 `defaultModels` from active provider）；新增 `ActiveProviderSchema`；`BindingUpsertInput` 去 gatewayId。

## 4. 桌面 Rust

**fetch_models 不变**（已经只接收 apiUrl + apiKey）。前端从 active-provider 拿 apiUrl 传给它。

## 5. 前端 ModelGatewayTab（再次重写）

去 provider 选择，只留：

```
┌─ 模型网关 ─────────────────────────┐
│ apiKey:  [____________]  [拉取模型] │  ← 已绑定显示 sk-***xxxx
│                                     │
│ 可用模型（勾选要用的）:              │
│   ☑ gpt-4o                          │
│   ☐ gpt-4o-mini                     │  ← 拉取后显示
│   ☑ gpt-4-turbo                     │
│                                     │
│              [保存]                  │
└─────────────────────────────────────┘
```

- 挂载：`GET /api/llm/active-provider`（拿 apiUrl，存内存）+ `GET /api/llm/binding`（显示 hint + modelOverride）。
- active-provider 404 (`no_active_provider`) → 整个 Card 显示「平台尚未配置模型服务，请联系管理员」，禁用输入。
- 拉取模型：`fetchModels(activeProvider.apiUrl, apiKey)`。
- 保存：`PUT /api/llm/binding { apiKey: apiKey||undefined, modelOverride }`。
- 错误：friendlyFetchError（api_key_invalid/provider_response_unsupported/网络）+ friendlyLlmError（no_active_provider/binding_not_found/...）。

## 6. Admin UI（collab-admin providers-view）

新建 `apps/collab-admin/src/components/providers-view.tsx`（参考 plugins-view 模式）：

- 表格列：name / apiUrl / models 数量 / isActive Badge / 操作（编辑/删除/设为启用）。
- 新增/编辑 Dialog：name + apiUrl + models（逗号分隔）+ description。
- 「设为启用」按钮（调 activate 端点，当前 active 的显示「当前启用」Badge）。
- App.tsx navItems 加 `{ view: 'llmProviders', label: '模型服务', icon: ... }` + VIEW_LABEL + 路由渲染 `<ProvidersView />`。
- `lib/types.ts` 的 `View` 类型加 `'llmProviders'`。

## 7. 验证

- 后端单测（llm.service.spec.ts 改）：
  - `active_provider_returns_enabled`（有 active 返 url，无返 404）。
  - `activate_provider_transactional_uniqueness`（设新的，旧的自动 false）。
  - `binding_is_team_unique`（upsert 按 teamId，重复 PUT 覆盖）。
  - 审计无 key（保留 AC）。
- Rust fetch_models 单测不变。
- 前端：typecheck + build + 146 测不回归。
- collab-admin：typecheck + build。
- 手动：seed 一个 active provider → 应用填 key → 拉模型 → 保存。

## 8. 实施顺序

1. 后端 schema 迁移 + service/controller 改造 + active-provider 端点 + Admin provider CRUD + 契约 + 单测。
2. 前端 ModelGatewayTab 重写（去 provider）。
3. collab-admin providers-view + 路由。
4. seed active provider + 手动验证。

## 9. 回滚

- schema 迁移可回退（prisma migrate rollback 或手写 down SQL），但首版无生产数据，直接重建。
- 端点改造：旧 `/api/llm/gateways` + binding(gatewayId) 已废弃，不保留兼容（破坏式）。
