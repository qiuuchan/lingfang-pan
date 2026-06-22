# Design — 权限码细分与迁移

## 新码定义（permission-codes.ts）
- 移除：team.plugin.edit / platform.user.update / team.role.manage / platform.plugin.manage
- 新增 team.plugin：edit_metadata / edit_draft / edit_price
- 新增 team.role：create / update / delete
- 新增 platform.user：update_profile / reset_password
- 新增 platform.plugin：edit / delete
- 新增 platform.team.role.manage（给 child-4 D7；系统平台管理员 seed 自动获得）

## Controller 守卫映射（逐端点已勘察）
| 端点 | → 新码 |
|---|---|
| POST plugins/:id/edit-draft | team.plugin.edit_draft |
| POST plugins/:id/edit-meta | team.plugin.edit_metadata |
| POST plugins/:id/set-price | team.plugin.edit_price |
| PATCH admin/users/:id | platform.user.update_profile |
| POST admin/users/:id/reset-password | platform.user.reset_password |
| POST admin/plugins(stub) / PATCH admin/plugins/:id | platform.plugin.edit |
| DELETE admin/plugins/:id | platform.plugin.delete |
| POST teams/current/roles | team.role.create |
| PATCH teams/current/roles/:id | team.role.update |
| DELETE teams/current/roles/:id | team.role.delete |
| GET teams/current/roles (list) | OR(create, update, delete, member.role.assign) |
| permission-group.service:123 (TEAM 分组守卫) | team.role.update |

role.service.ts 5 处 ensurePermission(team.role.manage) 按方法拆：listTeamRoles 改用新 ensureAnyPermission（OR），create/update/delete 各对应单码。

### list 放宽（连带修瑕疵）
MembersTab 角色下拉也调 GET roles，只配了 member.role.assign 的自定义角色必须能加载。在 AuthService 加 ensureAnyPermission(userId, codes[])（OR 语义），listTeamRoles 改用它。PermissionsGuard 已支持多码 OR，无需改。

---

## 迁移脚本设计（migrateLegacyPermissionCodes）— 重点

### 扩张映射表（单一事实来源）
LEGACY_PERMISSION_EXPANSION:
- team.plugin.edit       → [edit_metadata, edit_draft, edit_price]
- platform.user.update   → [update_profile, reset_password]
- team.role.manage       → [create, update, delete]
- platform.plugin.manage → [edit, delete]

### 算法（幂等）
对每个 Role（全部 scope，系统+自定义）：遍历 permissions，命中旧码则展开为新码集合，其余保留；去重；有变更才 update。

### 幂等保证
- 二次运行：permissions 已无旧码 → 不命中 → 不写
- 系统角色：seedPlatformAdminRole/seedTeamSystemRoles 在 migrate 前已用代码常量（改后含新码不含旧码）全量刷新 → 无旧码 → migrate 跳过
- 自定义角色：seed 不动 → 保留旧码 → migrate 扩张

### PermissionEntry 表清理
seedPermissionEntries 是 upsert（不删），改后旧码行残留。迁移阶段加 cleanupStalePermissionEntries：deleteMany where code notIn ALL_PERMISSIONS。清理旧码 + 任何历史过期码。PermissionGroup 无需清理（groupKey 没变）。

### 执行位置（seed-rbac main 新顺序）
1. seedPermissionEntries（写新码，不删旧）
2. seedPermissionGroups
3. seedPlatformAdminRole（全量新码）
4. seedTeamSystemRoles（全量新码）
5. migrateLegacyPermissionCodes（扩张自定义角色）← 新增
6. cleanupStalePermissionEntries（删旧码行）← 新增
7. backfillExistingRoleRefs（现有）

### 事务保护
步骤 5 用 prisma.$transaction 包裹全部 role.update，任一失败整体回滚，保持可重试。步骤 6 deleteMany 本身幂等。

### 环境场景
| 场景 | 行为 |
|---|---|
| 全新环境（无自定义角色） | migrate 0；cleanup 0 行 |
| 已跑旧 seed（自定义角色含旧码） | migrate 扩张；cleanup 删旧码行 |
| 迁移中断重跑 | 基于 permissions 当前值判断，未迁移继续、已迁移跳过 |
| 已迁移重跑 | 全 no-op |

### 迁移后断言（脚本末尾）
查 permissions hasSOME 旧码 key 的角色，正常应为 0；非 0 则 warn 列出。

### 回滚
- 事务内失败自动回滚
- 上线后发现映射错：反向脚本（新码→旧码合并，有损）
- 上线前必须：测试环境导一份生产角色数据，跑迁移 + 断言 + 抽查自定义角色 permissions

---

## 测试
- role.service.spec：更新 team.role.manage 用例为新三码；加 list OR 守卫用例（只配 member.role.assign 也能 list）
- 新增迁移单测：构造含旧码的 Role fixture，跑 migrate，断言扩张正确 + 二次跑 no-op + 系统角色不受影响
- permissions.guard.spec：多码 OR 用例

## 参考
parent design.md § child-2 全局映射
