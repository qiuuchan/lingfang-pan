# collab-api 质量与契约规范

## Cloud Schedule Deprecation Contract

Cloud automation schedule rows remain readable for migration and audit, but they are no longer an execution target. `AutomationScheduleService.create/update/resume` must return `AppError(410, 'cloud_disabled', ...)`. `AutomationScheduleFireProcessor.process()` must return `{ outcome: 'DEPRECATED', run_id: null }` before reading or creating a workflow run whenever an automation config is injected; the reconciler removes the stale queue projection. Historical data must not be deleted and a deprecated fire must never call `WorkflowRunService.startScheduled()`.

Required coverage: service mutation rejection, processor short-circuit without Prisma lookup, and reconciler removal of the queue projection.

## Current Backend Boundary

`apps/collab-api` 是当前平台后端。新增后端能力时，不要往已删除的 `apps/server` 路径或旧 Rust server spec 增加实现规则。

## API Error Contract

所有受保护接口使用 Bearer token。错误响应由 `AppExceptionFilter` 统一输出：

```json
{
  "code": "forbidden",
  "message": "权限不足",
  "requestId": "req-id",
  "details": {}
}
```

业务错误使用 `AppError` 或 `badRequest` / `unauthorized` / `forbidden` / `notFound` / `conflict` / `insufficientBalance` helpers。不要直接把 Prisma 原始错误 message 返回给客户端。

## Database Contract

`resolveDatabaseConfig()` 的契约：

- `DATABASE_PROVIDER` 缺失或空串 -> `postgresql`
- `postgres` / `postgresql` -> `postgresql`
- `mysql` -> `mysql`
- 其他值 -> throw `DATABASE_PROVIDER must be postgresql or mysql`
- `DATABASE_URL` 缺失 -> throw `DATABASE_URL is required`
- provider 与 URL scheme 不匹配 -> throw 明确错误

不要为缺失数据库 URL 生成默认连接串；部署错误必须显式暴露。

## Scenario: Team Invitation Code Contract

### 1. Scope / Trigger
- Trigger: changing `TeamService.createInvitation`, `TeamService.redeemInvitation`, `TeamsController`, desktop onboarding invite input, or team invitation list UI.

### 2. Signatures
- `POST /api/teams/current/invitations -> { invitation: InvitationCode & { code: string } }`
- `GET /api/teams/current/invitations -> { invitations: InvitationCode[] }`
- `POST /api/invitations/redeem { code: string } -> CollabSessionResponse`
- DB: `InvitationCode.codeHash` stores only the SHA-256 hash of the normalized full code; `displayCodePrefix` is a short display-only prefix.

### 3. Contracts
- Generated invite codes are full codes shaped as `LF-` plus 12 URL-safe uppercase characters.
- The full plaintext `code` is returned only by the create response. List responses must not expose reusable full codes.
- `displayCodePrefix` is not a redeemable code and must be labeled as a prefix in UI.
- Redemption normalizes by `trim().toUpperCase()` before hashing, so casing and surrounding whitespace do not matter.
- Desktop onboarding placeholders and validation must use a full-length example (`LF-XXXXXXXXXXXX`), not the display prefix length.

### 4. Validation & Error Matrix
- Empty code -> `400 bad_request` with `输入团队邀请码` from desktop pre-submit validation.
- Prefix-only or too-short code such as `LF-ABCD` -> `400 bad_request` with `请输入完整邀请码`.
- Full-length nonexistent code -> `400 bad_request` with `邀请码无效`.
- Expired invite -> `400 bad_request` with `邀请码已过期`.
- Active invite whose team is suspended -> `403 forbidden` with `团队当前不可加入`.
- Invite at `maxUses` -> `400 bad_request` with `邀请码已达到使用次数上限`.

### 5. Good/Base/Bad Cases
- Good: admin creates an invite, copies the full code from the create result, and a user redeems it regardless of input casing.
- Base: admin later views invite history and sees only `displayCodePrefix`, status, and usage counts.
- Bad: UI labels `displayCodePrefix` as an invite code or uses `LF-XXXXXXX` as a placeholder; users copy the prefix and receive misleading invalid-code failures.

### 6. Tests Required
- Backend unit: create then redeem a lower/upper/trimmed full code and assert the same `codeHash` lookup.
- Backend unit: prefix-only input rejects before `invitationCode.findUnique`.
- Desktop unit: invite input helper rejects prefix-only values and exposes the full-length placeholder.
- Frontend typecheck after changing `Onboarding.tsx` or `TeamManage.tsx`.

### 7. Wrong vs Correct
Wrong:

```tsx
<Input placeholder="团队邀请码，例如 LF-XXXXXXX" />
```

Correct:

```tsx
<Input placeholder="团队邀请码，例如 LF-XXXXXXXXXXXX" />
```

Wrong:

```tsx
headers={['邀请码', '状态']}
rows={invitations.map((i) => [i.displayCodePrefix, i.status])}
```

Correct:

```tsx
headers={['前缀（非完整邀请码）', '状态']}
rows={invitations.map((i) => [i.displayCodePrefix, i.status])}
```

## Test And Build Contract

- `tsconfig.json` 必须排除 `src/**/*.spec.ts`、`dist`、`node_modules`，避免 CommonJS build 产物污染 Vitest。
- `vitest.config.ts` 必须用 `include: ['src/**/*.spec.ts']` 锁定测试来源。
- 后端单元测试运行时加 60 秒硬超时。

## Scenario: RBAC Permission Resolution (角色 + 权限码 + 插件授权)

### 1. Scope / Trigger
- Trigger: 改 `@RequirePermission` 装饰器、`PermissionsGuard`、`AuthService.ensurePermission`、`RoleService`、`PluginGrantService`、`PermissionGroupService`、v4 package 可见性、角色/插件授权相关 Prisma 模型（Role/PermissionEntry/PermissionGroup/PluginGrant）或权限码注册表 `permission-codes.ts`。

### 2. Signatures
- `@RequirePermission(...codes: string[])` 装饰器 → `PermissionsGuard.canActivate` 校验（OR 语义，任一命中放行）
- `AuthService.ensurePermission(userId, ...codes)` 命令式 helper（service 内部条件分支用）
- `PluginGrantService.resolvePluginAccess(teamId, packageId, userId, teamRoleId)` → boolean（v4 package 授权解析）
- `RoleService.{list,create,update,delete}{Platform,Team}Role` / `assign{Platform,Member}Role`（入参含可选 `code`）
- `PermissionGroupService.{list,upsert,delete}Group(userId, scope, input)`（分组显示名管理）
- `RoleService.listPermissions(scope)` → `{ modules: PermissionModuleDef[], permissions: PermissionEntry[] }`（两级结构 + 扁平兼容）
- DB: `User.platformRoleId`（平台角色）、`TeamMembership.teamRoleId`（团队角色）、`Role.code String?`（角色编码，同 scope+teamId 唯一）、`Role.permissions String[]`（权限码数组）、`PermissionEntry.{moduleKey,moduleLabel,moduleOrder}`（两级模块结构）、`PermissionGroup(scope,groupKey,displayName,sortOrder,isSystem)`（可编辑分组显示名）、`PluginGrant(teamId, packageId, subjectKind, subjectId, effect)`

### 3. Contracts
- 权限码为预定义字符串（`permission-codes.ts` 注册表，dot.notation 如 `team.member.invite`），不可由用户自由新增。
- **两级权限节点（模块 → 操作）**：权限按 `PermissionModule`（父级，moduleKey+moduleLabel，如「插件管理」）组织，每模块含若干操作（叶子节点）。`PermissionEntry.moduleKey = group`（向后兼容），`moduleLabel/moduleOrder` 用于前端勾选树折叠与排序。新增/删除权限码本身由代码注册表控制；管理员不可凭空增删节点。
- **权限组（PermissionGroup）显示名可编辑**：管理员可对已注册 moduleKey 自定义显示名覆盖（如「插件管理」→「插件中心」），不可新增/删除 moduleKey。内置分组（isSystem=true，seed 写入）；`deleteGroup` = 重置为内置默认（非删除）。
- **角色编码 Role.code**：可选、同 scope+teamId 下唯一（`@@unique([scope, teamId, code])`，null 各行独立）。内置角色固定 code：`platform_admin` / `team_admin` / `team_member`（见 `permission-codes.ts` 的 `SYSTEM_*_ROLE_CODE` 常量）。**系统角色检测必须基于 code（非 name 字符串比较）**——`PluginGrantService.resolvePluginAccess` 与 `RoleService.assignMemberRole` 均用 `role.code === SYSTEM_TEAM_ADMIN_ROLE_CODE` 判定系统团队管理员。
- 角色两层 scope：`PLATFORM`（全局，teamId=null，web 端管理）/ `TEAM`（归属某 team，桌面端管理）。
- 内置角色（`isSystem=true`）3 个：系统平台管理员（code=platform_admin，全部 platform.*）、系统团队管理员（code=team_admin，全部 team.*）、系统成员（code=team_member，只读基线）。不可删、不可改权限/code，可改显示名。
- 插件授权语义（resolvePluginAccess）：deny 优先、user 级优先于 role 级、系统团队管理员默认放行、无 grant 默认放行。
- 迁移期双写：`User.platformRole` 枚举与 `platformRoleId` 并存；`TeamMembership.role` 枚举与 `teamRoleId` 并存。`assignPlatformRole`/`assignMemberRole` 同时写两者 + `tokenVersion` increment（吊销旧 token）。
- 平台管理线路（web collab-admin，`/api/admin/roles` + `/api/admin/permission-groups`）与团队管理线路（桌面端 TeamAdmin，`/api/teams/current/roles` + `/api/teams/current/permission-groups`）两条干净分离，互不干扰。
- **session 权限契约（跨层关键）**：`AuthService.sessionFor` 必须在响应中返回 `permissions: string[]`（平台角色 + 团队角色权限码合并，团队 SUSPENDED 时不含团队权限）、`user.platformRoleId`、`team.teamRoleId`。前端据此做入口门控（`apps/desktop/src/lib/permissions.ts` 的 `isTeamManager`/`hasPermission`），**不得再用 `session.role === 'TEAM_ADMIN'` 旧枚举判定**——否则自定义角色（如"运营"有 team.role.manage 但枚举是 MEMBER）的用户看不到入口。`resolveOnboarding` 同样基于权限码判断 TEAM_ADMIN_SPACE（有任意 team.* 管理权限），而非旧枚举。
- **门控边界**：collab-admin web 控制台整体进入权用 `platformRole === 'PLATFORM_ADMIN'`（仅系统平台管理员），自定义平台角色不进整个后台；桌面端 review（市场审核）入口同理保留 `isPlatformAdmin`。细粒度功能权限由 `@RequirePermission` 在后端守卫层强制。

### 4. Validation & Error Matrix
- 权限码不在注册表 → 400 `bad_request`（`未知权限码：X`）
- 权限码 scope 不匹配（团队角色用 platform.* 码）→ 400 `bad_request`（`权限码 X 不属于平台/团队级`）
- 缺权限（`@RequirePermission` 或 `ensurePermission` 未命中）→ 403 `forbidden`（`权限不足`）
- 改内置角色权限 → 403 `forbidden`（`内置角色权限不可修改`）
- 改内置角色 code → 403 `forbidden`（`内置角色编码不可修改`）
- 删内置角色 → 403 `forbidden`（`内置角色不可删除`）
- 删有引用的角色 → 409 `conflict`（`该角色仍有 N 个引用，请先解除分配`）
- 角色名重复（同 scope+teamId）→ 409 `conflict`（`角色名已存在`）
- 角色 code 重复（同 scope+teamId）→ 409 `conflict`（`角色编码已存在`）
- 角色 code 格式非法 → DTO 层 400（`@Matches(ROLE_CODE_PATTERN)`）
- 跨团队操作角色（teamId 不匹配）→ 404 `not_found`（`团队角色不存在`）
- 权限分组 groupKey 非已注册 moduleKey → 400 `bad_request`（`未知的权限分组键：X（不允许新增模块）`）
- 重置未自定义的权限分组 → 404 `not_found`（`权限分组尚未自定义，无需重置`）
- 插件授权 subjectKind=USER 但 subjectId 非本团队成员 → 400 `bad_request`
- 插件授权 subjectKind=ROLE 但 subjectId 非本团队角色 → 400 `bad_request`

### 5. Good/Base/Bad Cases
- Good: 团队管理员创建「开发者」自定义角色勾选 `team.plugin.upload` + `team.plugin.edit`，分配给成员后该成员可上传/编辑团队插件。
- Base: 团队管理员为某 v4 package 对「成员」角色设 DENY，所有成员不能访问该 package；团队管理员自身不受限（默认放行）。
- Bad: 对单个用户设 ALLOW 但对其角色设 DENY —— 正确行为是 ALLOW（user 级优先）；错误实现会拒绝（role DENY 覆盖 user ALLOW）。

### 6. Tests Required
- `permissions.guard.spec.ts`: @Public 放行、无 metadata 放行、平台权限命中/未命中、团队权限解析（含 SUSPENDED 不解析）、OR 语义、请求级缓存、缺登录态拒绝。
- `role.service.spec.ts`: 角色 CRUD happy path + 每条 forbidden/conflict 分支 + 内置角色保护 + 权限码 scope 校验 + 双写 tokenVersion + **code 唯一性/写入/code 重复 409**。
- `permission-group.service.spec.ts`: listGroups 合并覆盖+customized 标注、upsert 改名+未知 groupKey 400、delete 重置+404、scope 隔离（TEAM 无 membership 拒绝 / PLATFORM 不调 resolveCurrentTeam）。
- `plugin-grant.service.spec.ts`: setGrant/removeGrant + resolvePluginAccess 全矩阵（团队管理员放行、user DENY 优先、user ALLOW 胜 role DENY、无 grant 默认放行）。系统团队管理员 mock 须带 `code: 'team_admin'`（基于 code 检测）。

### 7. Wrong vs Correct
Wrong:

```ts
// 插件授权用 role DENY 覆盖 user ALLOW（违反 user 级优先语义）
if (roleGrants.some((g) => g.effect === 'DENY')) return false;
if (userGrants.some((g) => g.effect === 'ALLOW')) return true;
```

Correct:

```ts
// user 级先判，user 级有结果就不再看 role 级（deny 优先、user 级优先于 role 级）
const userGrants = grants.filter((g) => g.subjectKind === 'USER');
if (userGrants.some((g) => g.effect === 'DENY')) return false;
if (userGrants.some((g) => g.effect === 'ALLOW')) return true;
const roleGrants = grants.filter((g) => g.subjectKind === 'ROLE');
if (roleGrants.some((g) => g.effect === 'DENY')) return false;
if (roleGrants.some((g) => g.effect === 'ALLOW')) return true;
```

Wrong:

```ts
// 新建团队时不补团队级系统角色，申请人 membership 无 teamRoleId → 团队角色权限解析失败
await tx.teamMembership.create({ data: { teamId, userId, role: 'TEAM_ADMIN' } });
```

Correct:

```ts
// 新建团队时事务内补两条 isSystem 系统角色（确定性 id + 固定 code），申请人指向系统团队管理员
const teamAdminRoleId = `team-admin-${team.id}`;
await tx.role.create({ data: { id: teamAdminRoleId, name: '系统团队管理员', code: SYSTEM_TEAM_ADMIN_ROLE_CODE, scope: 'TEAM', teamId: team.id, isSystem: true, permissions: TEAM_PERMISSIONS.map((p) => p.code) } });
await tx.teamMembership.create({ data: { teamId, userId, role: 'TEAM_ADMIN', teamRoleId: teamAdminRoleId } });
```

Wrong:

```ts
// 用 name 字符串比较检测系统团队管理员（脆弱：name 可被改名，多语言/重命名即失效）
const role = await prisma.role.findUnique({ where: { id: teamRoleId }, select: { isSystem: true, name: true } });
if (role?.isSystem && role.name === '系统团队管理员') return true;
```

Correct:

```ts
// 基于 code 检测（code 不可被用户修改，内置角色固定 SYSTEM_TEAM_ADMIN_ROLE_CODE）
const role = await prisma.role.findUnique({ where: { id: teamRoleId }, select: { isSystem: true, code: true } });
if (role?.isSystem && role.code === SYSTEM_TEAM_ADMIN_ROLE_CODE) return true;
```

## Scenario: Team Shared Relay API Key And Plugin AI Boundary

### 1. Scope / Trigger
- Trigger: 改 `PlatformApiKeyService`、`TeamApiKeyController`、`DualAuthGuard`、relay 鉴权、桌面设置/团队管理 API Key UI、插件 SDK AI 能力或生成提示词。

### 2. Signatures
- `GET /api/teams/current/api-keys -> { apiKeys: PlatformApiKeyPublic[] }`，需 `team.api_key.manage`
- `POST /api/teams/current/api-keys ApiKeyCreateDto -> PlatformApiKeyCreated`，需 `team.api_key.manage`
- `DELETE /api/teams/current/api-keys/:id -> { ok: true }`，需 `team.api_key.manage`
- `PlatformApiKeyService.rotateForTeamAdmin(userId, teamId, { name?, scopes? }) -> PlatformApiKeyCreated`
- 插件 AI 调用只允许：`sdk.llm.chat({ messages, model })` 与 `sdk.image.generate({ prompt, model, size, n })`

### 3. Contracts
- 普通成员和插件不得创建、查看、配置、保存或展示 API Key、API URL、baseUrl、provider、自定义模型接口或上游模型服务地址。
- 团队共享 Key 只给外部 relay 兼容接入使用；插件/Agent 运行时通过宿主桥、本地桥 token 或登录态进入 `/api/relay/v1/*`。
- `POST /api/teams/current/api-keys` 是轮换，不是追加创建：同团队所有 `ACTIVE` Key 先置为 `DISABLED`，再创建一个 `expiresAt=null` 的新 Key。
- 明文 `plaintextKey` 只在轮换响应返回一次；列表和管理端总览永远不返回 `plaintextKey` 或 `keyHash`。
- `model` 可以保留，但只表示平台模型标识（如 `fast` / `premium`），不得承载上游真实模型、地址或 provider 配置。

### 4. Validation & Error Matrix
- 无登录态 -> 401（全局鉴权）
- 无 `team.api_key.manage` -> 403 `forbidden`
- 当前用户无 ACTIVE 当前团队 -> 403/业务错误（由 `ensureCurrentTeam` 保持现有语义）
- DELETE 非本团队 Key -> 404 `api_key_not_found`
- `scopes` 为空或全是未知值 -> 默认 `['*']`
- relay Bearer `lf_...` 无效/禁用/过期 -> `api_key_invalid` / `api_key_disabled`

### 5. Good/Base/Bad Cases
- Good: 团队管理员轮换 Key，旧 active Key 立即禁用，新 Key 明文只显示一次，外部系统用新 Key 调 relay。
- Base: 插件调用 `sdk.llm.chat({ messages, model: 'fast' })`，宿主用登录态转发到 relay，插件代码里没有密钥字段。
- Bad: 设置页或插件配置页出现 API Key/API URL/provider 输入框，或继续暴露 `/api/me/api-keys` 给普通用户自助创建。

### 6. Tests Required
- `api-key.service.spec.ts`: 轮换会禁用同团队 active Key、新 Key `expiresAt=null`、响应不含 `keyHash`。
- `api-key.service.spec.ts`: `listForTeam` 只返回脱敏字段。
- `pnpm -C apps/collab-api test` 覆盖后端回归；跨层 UI/SDK 改动还需桌面、contract、plugin-sdk typecheck。

### 7. Wrong vs Correct
Wrong:

```ts
await api('/api/me/api-keys', { method: 'POST', body: { name, scopes } });
```

Correct:

```ts
await api('/api/teams/current/api-keys', {
  method: 'POST',
  body: { name: '团队共享 Key', scopes: ['*'] },
});
```

Wrong:

```ts
await fetch(userConfiguredApiUrl, {
  headers: { Authorization: `Bearer ${userConfiguredApiKey}` },
});
```

Correct:

```ts
await sdk.llm.chat({ messages, model: 'fast' });
```

## Wrong vs Correct

Wrong:

```ts
try {
  return await prisma.pluginPackage.create(data);
} catch {
  return { ok: true };
}
```

Correct:

```ts
throw conflict('资源已存在或与现有记录冲突');
```

Wrong:

```ts
const url = process.env.DATABASE_URL || 'postgresql://localhost/dev';
```

Correct:

```ts
const config = resolveDatabaseConfig();
```
