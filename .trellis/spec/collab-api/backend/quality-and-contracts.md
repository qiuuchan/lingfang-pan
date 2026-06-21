# collab-api 质量与契约规范

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

## Scenario: Installed Marketplace Plugin Package Visibility

### 1. Scope / Trigger
- Trigger: changing `GET /api/plugins/available`, marketplace install, plugin package serialization, or desktop plugin loading.

### 2. Signatures
- `PluginService.availablePlugins(userId) -> { plugins }`
- `publicAvailablePlugin(plugin, currentTeamId) -> public plugin payload`
- `PluginInstallation(pluginId, teamId, status)` controls whether another team may receive package files.

### 3. Contracts
- Uploaded plugins are stored as JSON package data: `manifest + files[]`, not multipart uploads or zip archives.
- Own-team plugins return `files` and `manifest`.
- Public marketplace plugins from another team return no `files`/`manifest` until the current team has an ENABLED `PluginInstallation`.
- Installed marketplace plugins return `files`/`manifest` so desktop can run them; review internals such as `reviewReason` and `reviewedById` stay hidden.

### 4. Validation & Error Matrix
- Missing or disabled installation -> `files` and `manifest` are `undefined` in `available`.
- ENABLED installation for current team -> package fields are returned.
- Paid plugin without purchase -> install endpoint returns `payment_required`; `available` must not expose package files before installation.

### 5. Good/Base/Bad Cases
- Good: team B installs an approved public plugin from team A, then `/api/plugins/available` returns its `files` for team B.
- Base: team B sees the same public plugin in marketplace listings before install, but no package files through `available`.
- Bad: hiding `files` for already installed marketplace plugins; desktop will show a placeholder instead of running the plugin.

### 6. Tests Required
- `plugin-available.spec.ts`: uninstalled marketplace plugin hides package fields.
- `plugin-available.spec.ts`: installed marketplace plugin returns package fields but hides review internals.
- `plugin.service.spec.ts`: upload/edit paths still normalize package files and capabilities.

### 7. Wrong vs Correct
Wrong:

```ts
if (plugin.teamId !== currentTeamId) return { ...public_, files: undefined };
```

Correct:

```ts
return publicAvailablePlugin(plugin, currentTeamId);
```

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
- Trigger: 改 `@RequirePermission` 装饰器、`PermissionsGuard`、`AuthService.ensurePermission`、`RoleService`、`PluginGrantService`、`PluginService.availablePlugins`、角色/插件授权相关 Prisma 模型（Role/PermissionEntry/PluginGrant）或权限码注册表 `permission-codes.ts`。

### 2. Signatures
- `@RequirePermission(...codes: string[])` 装饰器 → `PermissionsGuard.canActivate` 校验（OR 语义，任一命中放行）
- `AuthService.ensurePermission(userId, ...codes)` 命令式 helper（service 内部条件分支用）
- `PluginGrantService.resolvePluginAccess(teamId, pluginId, userId, teamRoleId)` → boolean（插件授权解析）
- `RoleService.{list,create,update,delete}{Platform,Team}Role` / `assign{Platform,Member}Role`
- DB: `User.platformRoleId`（平台角色）、`TeamMembership.teamRoleId`（团队角色）、`Role.permissions String[]`（权限码数组）、`PluginGrant(teamId, pluginId, subjectKind, subjectId, effect)`

### 3. Contracts
- 权限码为预定义字符串（`permission-codes.ts` 注册表，dot.notation 如 `team.member.invite`），不可由用户自由新增。
- 角色两层 scope：`PLATFORM`（全局，teamId=null，web 端管理）/ `TEAM`（归属某 team，桌面端管理）。
- 内置角色（`isSystem=true`）3 个：系统平台管理员（全部 platform.*）、系统团队管理员（全部 team.*）、系统成员（只读基线）。不可删、不可改权限，可改显示名。
- 插件授权语义（resolvePluginAccess）：deny 优先、user 级优先于 role 级、系统团队管理员默认放行、无 grant 默认放行。
- 迁移期双写：`User.platformRole` 枚举与 `platformRoleId` 并存；`TeamMembership.role` 枚举与 `teamRoleId` 并存。`assignPlatformRole`/`assignMemberRole` 同时写两者 + `tokenVersion` increment（吊销旧 token）。
- 平台管理线路（web collab-admin，`/api/admin/roles`）与团队管理线路（桌面端 TeamAdmin，`/api/teams/current/roles`）两条干净分离，互不干扰。
- **session 权限契约（跨层关键）**：`AuthService.sessionFor` 必须在响应中返回 `permissions: string[]`（平台角色 + 团队角色权限码合并，团队 SUSPENDED 时不含团队权限）、`user.platformRoleId`、`team.teamRoleId`。前端据此做入口门控（`apps/desktop/src/lib/permissions.ts` 的 `isTeamManager`/`hasPermission`），**不得再用 `session.role === 'TEAM_ADMIN'` 旧枚举判定**——否则自定义角色（如"运营"有 team.role.manage 但枚举是 MEMBER）的用户看不到入口。`resolveOnboarding` 同样基于权限码判断 TEAM_ADMIN_SPACE（有任意 team.* 管理权限），而非旧枚举。
- **门控边界**：collab-admin web 控制台整体进入权用 `platformRole === 'PLATFORM_ADMIN'`（仅系统平台管理员），自定义平台角色不进整个后台；桌面端 review（市场审核）入口同理保留 `isPlatformAdmin`。细粒度功能权限由 `@RequirePermission` 在后端守卫层强制。

### 4. Validation & Error Matrix
- 权限码不在注册表 → 400 `bad_request`（`未知权限码：X`）
- 权限码 scope 不匹配（团队角色用 platform.* 码）→ 400 `bad_request`（`权限码 X 不属于平台/团队级`）
- 缺权限（`@RequirePermission` 或 `ensurePermission` 未命中）→ 403 `forbidden`（`权限不足`）
- 改内置角色权限 → 403 `forbidden`（`内置角色权限不可修改`）
- 删内置角色 → 403 `forbidden`（`内置角色不可删除`）
- 删有引用的角色 → 409 `conflict`（`该角色仍有 N 个引用，请先解除分配`）
- 角色名重复（同 scope+teamId）→ 409 `conflict`（`角色名已存在`）
- 跨团队操作角色（teamId 不匹配）→ 404 `not_found`（`团队角色不存在`）
- 插件授权 subjectKind=USER 但 subjectId 非本团队成员 → 400 `bad_request`
- 插件授权 subjectKind=ROLE 但 subjectId 非本团队角色 → 400 `bad_request`

### 5. Good/Base/Bad Cases
- Good: 团队管理员创建「开发者」自定义角色勾选 `team.plugin.upload` + `team.plugin.edit`，分配给成员后该成员可上传/编辑团队插件。
- Base: 团队管理员为某插件对「成员」角色设 DENY，所有成员不再看到该插件（availablePlugins 过滤）；团队管理员自身不受限（默认放行）。
- Bad: 对单个用户设 ALLOW 但对其角色设 DENY —— 正确行为是 ALLOW（user 级优先）；错误实现会拒绝（role DENY 覆盖 user ALLOW）。

### 6. Tests Required
- `permissions.guard.spec.ts`: @Public 放行、无 metadata 放行、平台权限命中/未命中、团队权限解析（含 SUSPENDED 不解析）、OR 语义、请求级缓存、缺登录态拒绝。
- `role.service.spec.ts`: 角色 CRUD happy path + 每条 forbidden/conflict 分支 + 内置角色保护 + 权限码 scope 校验 + 双写 tokenVersion。
- `plugin-grant.service.spec.ts`: setGrant/removeGrant + resolvePluginAccess 全矩阵（团队管理员放行、user DENY 优先、user ALLOW 胜 role DENY、无 grant 默认放行）。

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
// 新建团队时事务内补两条 isSystem 系统角色（确定性 id），申请人指向系统团队管理员
const teamAdminRoleId = `team-admin-${team.id}`;
await tx.role.create({ data: { id: teamAdminRoleId, name: '系统团队管理员', scope: 'TEAM', teamId: team.id, isSystem: true, permissions: TEAM_PERMISSIONS.map((p) => p.code) } });
await tx.teamMembership.create({ data: { teamId, userId, role: 'TEAM_ADMIN', teamRoleId: teamAdminRoleId } });
```

## Wrong vs Correct

Wrong:

```ts
try {
  return await prisma.plugin.create(data);
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
