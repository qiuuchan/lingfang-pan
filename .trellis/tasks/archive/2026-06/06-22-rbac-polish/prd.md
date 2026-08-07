# 权限管理系统完善

## Goal

打磨团队权限管理系统的 UI 细节、权限码粒度、整体完成度，并补齐 web 平台端管理任意团队角色能力，让团队/平台管理员都能精准管控权限。

## 背景（已确认事实）

- RBAC 两层（PLATFORM/TEAM）两级（模块/操作）；权限码注册表 `permission-codes.ts` 单一事实来源，`seed-rbac.ts` 同步进 DB。
- 授权链路：`@RequirePermission` → `PermissionsGuard`（按 `platformRoleId + teamRoleId` 解析）→ `session.permissions` 注入前端。
- 桌面端 `TeamAdmin.tsx` 5 tab；后端 `roles.controller.ts` 挂 `teams/current/roles` + `admin/roles`。

## 任务结构（parent + 4 children）

- **child-1 `member-role-display`**：① 成员角色名显示 + D5 MembersTab 清理（前后端联动，lightweight）
- **child-2 `permission-split`**：② 权限码细分（全拆 4 处）+ 迁移（核心，complex）
- **child-3 `team-admin-ui-polish`**：③ 插件授权 UI + D1–D4 InvitationsTab 完善（纯前端，lightweight）
- **child-4 `admin-team-roles`**：④-D7 web 端团队角色管理 B+C（新功能，complex）

## child-1：成员角色名显示 + 清理

- 后端 `currentMembers`（`team.service.ts:166`）补返回 `teamRoleId + roleName + roleCode`。
- 前端 `MembersTab.tsx` 改用 `teamRoleId` 匹配下拉、显示 `roleName`；清理 `roleById` 冗余 + name 字符串反查。
- contract + 前端 types 同步。

## child-2：权限码细分（全拆 4 处）+ 迁移

映射：

| 旧码                     | 拆成                                                      |
| ------------------------ | --------------------------------------------------------- |
| `team.plugin.edit`       | `team.plugin.edit_metadata` / `edit_draft` / `edit_price` |
| `platform.user.update`   | `platform.user.update_profile` / `reset_password`         |
| `team.role.manage`       | `team.role.create` / `update` / `delete`                  |
| `platform.plugin.manage` | `platform.plugin.edit` / `delete`                         |

影响点：`admin.controller.ts:77,98,203,225,239` / `plugins.controller.ts:46,53,60` / `roles.controller.ts:79,86,94,101` / `role.service.ts` ensurePermission×5 / `permission-group.service.ts:123`。
**迁移策略：扩张映射**（seed-rbac 幂等迁移，旧码→全部新码，自定义角色不丢权限；系统角色 seed 全量自动覆盖）。

## child-3：插件授权 UI + D1–D4

- `PluginGrantsTab.tsx:183` trigger + SelectContent 加宽度。
- D1 状态中文化；D2 暴露 `expiresAt`；D3 公开加入开关换项目 Checkbox；D4 历史加创建时间列。

## child-4：D7 web 端团队角色管理（B+C）

- **B 管**：collab-admin 团队详情新增角色 CRUD + 两级权限勾选（作用域=某团队）。后端新端点 `/api/admin/teams/:id/roles*` + `/permissions`。
- **C 分配**：`teams-view` 成员 tab 的 TEAM_ADMIN/MEMBER 二选一 → 该团队全部角色下拉。

## Acceptance Criteria（初步，各 child design 细化）

- [ ] child-1：成员列表显示角色实际名字；分配下拉默认值按 `teamRoleId` 正确匹配；无枚举硬编码/字符串反查。
- [ ] child-2：4 处旧码拆分到位（注册表+守卫+seed）；现有自定义角色权限经迁移**不丢失**；系统角色自动获新码；前端勾选面板展示新码。
- [ ] child-3：插件授权下拉/悬浮框不再挤压；邀请码状态中文、可设过期时间、Checkbox 一致、历史有创建时间。
- [ ] child-4：平台管理员能在 collab-admin 为任意团队建/改/删角色并勾权限；能给任意成员分配该团队自定义角色。
- [ ] 全部：typecheck + 现有测试通过；新增/调整守卫有测试。

## Open Questions

- [x] 迁移策略：**扩张映射**（已定）
- [ ] child-4 守卫权限码：复用 `platform.team.member.role` 还是新增 `platform.team.role.manage`？（design 定，倾向新增）

## Out of Scope

- Tauri 自动更新；D6 桌面端权限组改名 UI
