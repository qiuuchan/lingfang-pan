# Design — 权限管理系统完善

## 架构与边界

parent 协调 4 个独立可验证 child：
- **child-1** member-role-display：成员角色名显示（前后端联动）
- **child-2** permission-split：权限码细分 + 迁移（核心，其余 child 的基础）
- **child-3** team-admin-ui-polish：插件授权 + 邀请码 UI（纯前端）
- **child-4** admin-team-roles：web 端团队角色管理（新功能）

依赖：child-2 是基础（权限码体系）；child-1/3 互相独立可并行；child-4 依赖 child-2 新增的平台级守卫码 `platform.team.role.manage`。

---

## child-2 权限码拆分设计

### 新码定义（permission-codes.ts）
- TEAM：移除 `team.plugin.edit` → 新增 `edit_metadata`/`edit_draft`/`edit_price`；移除 `team.role.manage` → 新增 `create`/`update`/`delete`
- PLATFORM：移除 `platform.user.update` → 新增 `update_profile`/`reset_password`；移除 `platform.plugin.manage` → 新增 `edit`/`delete`
- PLATFORM 新增 `platform.team.role.manage`（给 child-4 D7 用，语义=平台管理员代管任意团队角色 CRUD）

### Controller 守卫映射（已勘察确认）
| 端点 | 旧码 | 新码 |
|---|---|---|
| `POST plugins/:id/edit-draft`（plugins.controller:46）| team.plugin.edit | team.plugin.edit_draft |
| `POST plugins/:id/edit-meta`（:53）| team.plugin.edit | team.plugin.edit_metadata |
| `POST plugins/:id/set-price`（:60）| team.plugin.edit | team.plugin.edit_price |
| `PATCH admin/users/:id`（admin.controller:77）| platform.user.update | platform.user.update_profile |
| `POST admin/users/:id/reset-password`（:98）| platform.user.update | platform.user.reset_password |
| `POST admin/plugins`（:203，stub）| platform.plugin.manage | platform.plugin.edit |
| `PATCH admin/plugins/:id`（:225）| platform.plugin.manage | platform.plugin.edit |
| `DELETE admin/plugins/:id`（:239）| platform.plugin.manage | platform.plugin.delete |
| `POST teams/current/roles`（roles.controller:86）| team.role.manage | team.role.create |
| `PATCH teams/current/roles/:id`（:94）| team.role.manage | team.role.update |
| `DELETE teams/current/roles/:id`（:101）| team.role.manage | team.role.delete |
| `GET teams/current/roles`（:79，list）| team.role.manage | **OR(create, update, delete, member.role.assign)** ※ |
| permission-group.service:123（TEAM 分组守卫）| team.role.manage | team.role.update |

※ list 放宽成 OR：`MembersTab` 分配角色（`member.role.assign`）也要加载角色下拉，若 list 仍只认 `role.manage` 会导致只配了 assign 的自定义角色看不到下拉——这是拆分必须连带修的现存瑕疵。`role.service.ts` 5 处 `ensurePermission('team.role.manage')` 同步按 list/create/update/delete 拆分。

### 迁移脚本（seed-rbac.ts 扩张映射）
新增 `migrateLegacyPermissionCodes()`，在 `seedTeamSystemRoles()` 之后执行，幂等：
- 扫全部 Role（PLATFORM + TEAM），对 `permissions` 数组里的旧码扩张替换：
  - `team.plugin.edit` → [edit_metadata, edit_draft, edit_price]
  - `platform.user.update` → [update_profile, reset_password]
  - `team.role.manage` → [create, update, delete]
  - `platform.plugin.manage` → [edit, delete]
- 去重写回；系统角色 seed 全量已含新码，对其 no-op；旧码移除后二次运行不重新引入。

---

## child-1 currentMembers 契约变更
- `team.service.ts:159` currentMembers：prisma `include: { role: {select:{id,name,code}} }`（经 teamRoleId 关联），返回补 `teamRoleId + roleName + roleCode`
- contract `TeamMember` schema 加 optional 字段（向后兼容，旧客户端忽略）
- desktop `types.ts` 同步；`MembersTab.tsx` 删 `roleById` 冗余 + name 字符串反查，「当前角色」列显示 `roleName`，分配下拉 `value` 用 `teamRoleId`

---

## child-4 D7 端点契约（B+C）
### 后端新端点（建议新 `admin-team-roles.controller.ts`，挂 `/api/admin/teams/:id/...`）
- `GET /admin/teams/:id/roles` — list 该团队全部角色（守卫 platform.team.role.manage）
- `POST /admin/teams/:id/roles` — create
- `PATCH /admin/teams/:id/roles/:roleId` — update
- `DELETE /admin/teams/:id/roles/:roleId` — delete
- `GET /admin/teams/:id/roles/permissions` — `listPermissions('TEAM')`
- 扩展现有 `PATCH /admin/teams/:id/members/:userId/role`（admin.controller:169）：body 接受任意 `roleId`（不再限 TEAM_ADMIN/MEMBER 枚举），守卫 `platform.team.member.role`
- 复用 `RoleService` 团队角色逻辑，但用 `:id` 指定团队（绕过 resolveCurrentTeam），全部写审计

### 前端 collab-admin teams-view
- 团队详情 Sheet 新增「角色」tab：角色列表 + CRUD Dialog + 两级权限勾选面板（从 roles-view 抽公共组件复用）
- 成员 tab 角色下拉：TEAM_ADMIN/MEMBER 二选一 → 调 `GET /admin/teams/:id/roles` 拿全部角色下拉

---

## child-3 UI 改动
- `PluginGrantsTab.tsx:183`：「主体类型/效果」grid-cols-2 → 给 trigger 加 `w-full`、`SelectContent` 加 `min-w-[12rem]`；「选择用户/角色」Select 独占一行
- `InvitationsTab.tsx`：D1 status Badge 中文化（ACTIVE→正常/DISABLED→已禁用）；D2 加 expiresAt 日期输入 + 传后端；D3 原生 checkbox → `@/components/ui/checkbox`；D4 历史表加 createdAt 列

---

## 兼容性与回滚
- 权限码拆分是破坏性变更（旧码从注册表移除）。回滚靠 git revert + 反向迁移脚本（新码→旧码合并）；建议先测试环境验证 migrateLegacyPermissionCodes
- currentMembers 新字段 optional，前端旧版本不受影响
- D7 端点纯新增，回滚 = 删端点 + 前端 tab

## 风险点
- 迁移脚本必须在所有环境（含已跑过旧 seed 的）幂等正确
- team.role.manage 拆分后，现有配了 role.manage 的自定义角色扩张为 create+update+delete（符合扩张语义，design 接受）
- D7 让平台管理员能改任意团队角色，审计必须完整
