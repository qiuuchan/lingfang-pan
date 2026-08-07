# Implement — 权限码细分与迁移

## 步骤（有序）

1. permission-codes.ts：移除 4 旧码、新增 11 新码（含 platform.team.role.manage）；更新 label/description
2. auth.service.ts：加 ensureAnyPermission(userId, codes[])（OR），供 listTeamRoles 用
3. controller 守卫改挂（按 design 映射表）：plugins.controller / admin.controller / roles.controller
4. role.service.ts：5 处 ensurePermission 拆分；listTeamRoles 改 ensureAnyPermission；permission-group.service:123 → team.role.update
5. seed-rbac.ts：加 LEGACY_PERMISSION_EXPANSION 常量 + migrateLegacyPermissionCodes($transaction) + cleanupStalePermissionEntries；调整 main 顺序（design §执行位置）
6. 前端勾选面板：自动从 /roles/permissions 加载新码，验证显示正常
7. 测试：更新 role.service.spec / permissions.guard.spec；新增迁移单测
8. 验证 + 迁移实测

## 验证命令

- pnpm -C apps/collab-api test（含迁移单测）
- pnpm -C apps/collab-api lint（typecheck）
- pnpm -C apps/desktop typecheck / pnpm -C apps/collab-admin typecheck
- 迁移实测：测试环境 pnpm -C apps/collab-api seed:rbac，确认自定义角色扩张 + PermissionEntry 无旧码 + 断言 0 stale

## 风险/回滚点

- 迁移脚本错误 → 测试环境先验证（design §回滚）
- 漏改守卫 → grep 全库 4 个旧码，注册表/seed/测试 fixture 外应为 0
- 每个 commit 独立，便于 revert

## Review Gate（start 前）

- [ ] 用户终审本 child design（尤其迁移）+ implement
