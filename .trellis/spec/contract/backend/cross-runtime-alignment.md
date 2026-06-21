# Cross Runtime Alignment

## Contract First

The project rule is contract first: behavior changes that cross runtime boundaries start in `packages/contract`, then server and desktop follow.

Reference docs:
- `docs/02-domain-and-plugins.md`
- `docs/04-engineering.md`

## Server Alignment

> ⚠️ **已迁移（2026-06-13）**：原 Rust 后端 apps/server 已删除，以下对齐职责全部迁移到 NestJS apps/collab-api。改契约时改为核对对应 collab-api 模块：身份与角色 `apps/collab-api/src/modules/auth.*`，草稿与发布 `apps/collab-api/src/modules/plugin.service.ts`/`plugins.controller.ts`，LLM 绑定与审计 `apps/collab-api/src/modules/plugins.controller.ts`，市场与钱包 `apps/collab-api/src/modules/marketplace.*`/`wallet.controller.ts`。下方保留原 server 路径仅作历史参考。

Rust does not import the TS package, so alignment is manual. When changing a contract, inspect matching server code:

- identity and roles: `apps/server/src/auth.rs`, `apps/server/src/routes/auth.rs`
- drafts and publishing: `apps/server/src/routes/drafts.rs`
- LLM binding and audit: `apps/server/src/routes/llm.rs`, `apps/server/src/audit.rs`
- marketplace and wallet: `apps/server/src/routes/marketplace.rs`, `apps/server/src/routes/wallet.rs`

Do not add a server field that is meant for frontend use without adding the contract field.

## Frontend Alignment

`apps/desktop/src/lib/types.ts` currently keeps a small frontend-local view of backend payloads. If a payload becomes shared or reused across pages, prefer adding/updating the contract instead of scattering local `[k: string]: unknown` reads.

Role drift is high-risk: `TenantRole` includes `developer`, while current UI labels and admin checks focus on `owner`, `admin`, and `member`. Any role change must update both sides.

**RBAC 收敛（2026-06-21）**：实际角色系统已迁移到 `Role` 模型（PLATFORM/TEAM 两层 scope + 预定义权限码，见 `packages/contract/src/rbac.ts`）。
`identity.ts` 的 `TenantRole`（owner|admin|developer|member）降级为 dead schema，仅供 `PluginGrant.resolveGrant()` 的 role 字符串参数兼容，新代码请勿引用做业务判断。
改角色时核对：`packages/contract/src/rbac.ts`（契约）、`apps/collab-api/prisma/schema.prisma`（Role/PermissionEntry/PluginGrant 模型）、`apps/collab-api/src/modules/permissions/permission-codes.ts`（权限码注册表）、`apps/collab-api/src/permissions.guard.ts`（授权守卫）、`apps/desktop/src/lib/types.ts` + `apps/collab-admin/src/lib/types.ts`（前端 Role 类型）。

## Error Codes

`packages/contract/src/llm.ts` defines stable error codes used by cross-runtime behavior. The server also has operational codes like `forbidden`, `bad_request`, `insufficient_balance`, and `payment_required`.

When frontend behavior branches on a new error code, add it to the shared contract or document why it remains route-local.

