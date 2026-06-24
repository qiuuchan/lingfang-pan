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

**RBAC 收敛（2026-06-21，2026-06-22 增强）**：实际角色系统已迁移到 `Role` 模型（PLATFORM/TEAM 两层 scope + 预定义权限码，见 `packages/contract/src/rbac.ts`）。
`identity.ts` 的 `TenantRole`（owner|admin|developer|member）降级为 dead schema，仅供 `PluginGrant.resolveGrant()` 的 role 字符串参数兼容，新代码请勿引用做业务判断。
**两级权限节点（2026-06-22）**：权限按「模块 → 操作」两级组织（`PermissionModule.moduleKey/moduleLabel` 父级 + `operations` 叶子）；`PermissionEntry.moduleKey=group`（向后兼容）+ `moduleLabel/moduleOrder`。**角色编码 `Role.code`**（可选、同 scope+teamId 唯一，内置固定 platform_admin/team_admin/team_member，系统角色检测基于 code 而非 name）。**可编辑权限组 `PermissionGroup`**（管理员改 moduleKey 显示名，不可增删 moduleKey 本身）。
改角色/权限时核对：`packages/contract/src/rbac.ts`（契约）、`apps/collab-api/prisma/schema.prisma`（Role/PermissionEntry/PermissionGroup/PluginGrant 模型）、`apps/collab-api/src/modules/permissions/permission-codes.ts`（权限码 + 模块 + 内置 code 注册表）、`apps/collab-api/src/modules/role.service.ts` + `permission-group.service.ts`（服务）、`apps/collab-api/src/permissions.guard.ts`（授权守卫）、`apps/desktop/src/lib/types.ts` + `apps/collab-admin/src/lib/types.ts`（前端 Role/PermissionEntry/PermissionGroup/PermissionModule 类型）。

## Error Codes

`packages/contract/src/llm.ts` defines stable error codes used by cross-runtime behavior. The server also has operational codes like `forbidden`, `bad_request`, `insufficient_balance`, and `payment_required`.

When frontend behavior branches on a new error code, add it to the shared contract or document why it remains route-local.

## Scenario: Plugin Capability Kind Alignment

### 1. Scope / Trigger
- Trigger: adding, renaming, or removing plugin capability kinds crosses `packages/contract`, `apps/collab-api`, and `apps/desktop`.
- Risk: desktop can generate a capability that passes local validation but is rejected by backend package normalization, or the backend can accept a capability that shared contract consumers reject.

### 2. Signatures
- Contract enum: `packages/contract/src/plugin.ts` `CapabilityKind`.
- Backend whitelist: `apps/collab-api/src/modules/plugin-package.ts` `CAPABILITY_KINDS`.
- Desktop draft normalization: `apps/desktop/src/lib/plugin-draft/manifest.ts` `FRONTEND_CAPABILITY_KINDS` and `FALLBACK_CAPABILITY`.

### 3. Contracts
- `CapabilityKind` must include every backend-accepted public capability kind.
- Backend `CAPABILITY_KINDS` must reject unknown strings with a 400-style validation error during plugin package normalization.
- Desktop fallback capability must be one of `CapabilityKind.options`; current code-assistant fallbacks use `code-assistant.run`, with `code-assistant.session` reserved for session capability metadata.

### 4. Validation & Error Matrix
- Contract missing a backend-accepted kind -> desktop/typecheck/tests fail before release.
- Desktop fallback uses a bare or stale kind such as `code-assistant` -> backend rejects draft publish/package normalization.
- Backend whitelist accepts a kind missing from `CapabilityKind` -> shared contract consumers reject otherwise valid backend data.

### 5. Good/Base/Bad Cases
- Good: `code-assistant.run` and `code-assistant.session` exist in both `CapabilityKind` and backend `CAPABILITY_KINDS`; desktop fallback uses `code-assistant.run`.
- Base: adding `plugin.export` updates all three locations in the same change and includes a regression test.
- Bad: adding `plugin.export` only to `apps/collab-api/src/modules/plugin-package.ts`.

### 6. Tests Required
- `pnpm -C packages/contract typecheck` verifies exported enum consumers compile.
- `pnpm -C apps/desktop test` covers draft manifest normalization and fallback capability acceptance.
- Backend plugin-package tests should assert unknown capability kinds are rejected and newly allowed kinds are accepted.

### 7. Wrong vs Correct

Wrong:

```ts
// Backend only: contract and desktop still reject or omit this value.
const CAPABILITY_KINDS = new Set(['code-assistant.run', 'plugin.export']);
```

Correct:

```ts
// packages/contract/src/plugin.ts
export const CapabilityKind = z.enum(['code-assistant.run', 'code-assistant.session', 'plugin.export']);

// apps/collab-api/src/modules/plugin-package.ts
const CAPABILITY_KINDS = new Set(['code-assistant.run', 'code-assistant.session', 'plugin.export']);

// apps/desktop/src/lib/plugin-draft/manifest.ts
const FRONTEND_CAPABILITY_KINDS = new Set<CapabilityKindType>(CapabilityKind.options);
```

