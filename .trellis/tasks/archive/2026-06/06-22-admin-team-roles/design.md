# Design — Web 端团队角色管理（D7）

## 后端新端点（新 admin-team-roles.controller.ts，挂 /api/admin/teams/:id/...）
| 方法端点 | 作用 | 守卫 |
|---|---|---|
| GET /admin/teams/:id/roles | list 该团队全部角色 | platform.team.role.manage |
| POST /admin/teams/:id/roles | create | platform.team.role.manage |
| PATCH /admin/teams/:id/roles/:roleId | update | platform.team.role.manage |
| DELETE /admin/teams/:id/roles/:roleId | delete | platform.team.role.manage |
| GET /admin/teams/:id/roles/permissions | listPermissions(TEAM) | platform.team.role.manage |

扩展现有 PATCH /admin/teams/:id/members/:userId/role（admin.controller:169）：body 接受任意 roleId（替代 TEAM_ADMIN/MEMBER 枚举），守卫维持 platform.team.member.role；service 校验 role 存在 + 属该团队 + scope=TEAM，双写 teamRole 枚举（系统团队管理员 code → TEAM_ADMIN，否则 MEMBER）。

## RoleService 适配
现有 createTeamRole/updateTeamRole/deleteTeamRole 用 resolveCurrentTeam(userId) 取 teamId。新增「代管版」：直接用 :id 参数（绕过当前团队），校验 platform.team.role.manage。复用 validatePermissions / normalizeRoleCode / assertCodeAvailable / 审计。

## 权限码
platform.team.role.manage（child-2 已新增注册）；系统平台管理员 seed 全量自动获得。

## 前端 collab-admin
- teams-view.tsx 团队详情 Sheet（TeamOverviewSheet）TabsList 加「角色」tab
- 角色管理面板：从 roles-view.tsx 抽公共组件 RoleEditDialog + PermissionChecklist（平台/团队角色面板逻辑近乎重复，抽组件两边复用）
- 成员 tab 角色下拉：调 GET /admin/teams/:id/roles 拿全部角色，SelectItem 展示 roleName；changeRole 改传 roleId
- lib/types.ts + lib/api 同步

## 兼容性
- 新端点纯新增，不影响现有
- 成员角色切换端点扩展（接受 roleId）：旧前端传 TEAM_ADMIN/MEMBER 仍兼容——service 判断 body 是枚举还是 roleId 分别处理

## 参考
parent design.md § child-4
