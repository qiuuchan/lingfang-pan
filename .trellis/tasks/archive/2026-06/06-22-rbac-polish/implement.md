# Implement — 权限管理系统完善

## 执行顺序（依赖驱动）

1. **child-2 permission-split**（权限码基础，最先）
2. **child-1 member-role-display** 与 **child-3 team-admin-ui-polish**（独立，可并行）
3. **child-4 admin-team-roles**（依赖 child-2 的 platform.team.role.manage）

## child-2 步骤

1. `permission-codes.ts`：移除 4 旧码，新增 11 码（3+2+3+2 + platform.team.role.manage）
2. 改 controller `@RequirePermission`（按 design 映射表，约 13 处端点 + 5 处 ensurePermission + 1 处 permission-group）
3. `GET teams/current/roles` list 端点改 OR 守卫（需 PermissionsGuard 支持多码 OR——已支持）
4. `seed-rbac.ts` 加 `migrateLegacyPermissionCodes()`（扩张映射，幂等）
5. 前端勾选面板：新码自动从 `/roles/permissions` 端点加载，无需硬编码
6. 测试：更新 `role.service.spec`/`permissions.guard.spec`，新增迁移逻辑测试
7. 验证：`pnpm -C apps/collab-api test && pnpm -C apps/collab-api lint`

## child-1 步骤

1. `team.service.ts` currentMembers include role + 返回补字段
2. contract `TeamMember` + desktop `types.ts` 同步
3. `MembersTab.tsx` 显示 roleName + 下拉用 teamRoleId + 清理冗余
4. 验证：`pnpm -C apps/collab-api test`、`pnpm -C apps/desktop typecheck`

## child-3 步骤

1. `PluginGrantsTab.tsx` Select 宽度 + 布局
2. `InvitationsTab.tsx` D1–D4
3. 验证：`pnpm -C apps/desktop typecheck` + 手动跑 tauri dev 看效果

## child-4 步骤

1. 后端：新 `admin-team-roles.controller.ts` + `RoleService` 代管方法（指定 teamId）+ 审计；扩展 `PATCH members/:userId/role` 接受 roleId
2. `permission-codes.ts` 的 platform.team.role.manage（child-2 已加）+ seed 系统平台管理员权限
3. collab-admin：types + api + teams-view「角色」tab + 抽权限勾选公共组件 + 成员下拉扩展
4. 测试 + 验证：`pnpm -C apps/collab-api test`、`pnpm -C apps/collab-admin typecheck`

## 全局验证命令

- `pnpm -C apps/collab-api test` （后端单测，含权限/迁移）
- `pnpm -C apps/collab-api lint` （typecheck）
- `pnpm -C apps/desktop typecheck`
- `pnpm -C apps/collab-admin typecheck`
- 迁移实测：测试环境跑 `pnpm -C apps/collab-api seed:rbac`，确认现有自定义角色 permissions 扩张正确、无旧码残留

## 回滚点

- 每个 child 独立 commit，便于单独 revert
- child-2 迁移若异常：git revert permission-codes + controller + seed-rbac 段；已迁移角色写反向脚本（新码合并回旧码）
- child-4 纯新增端点，回滚最简单

## Review Gates（task.py start 前）

- [ ] 用户评审 parent prd + design + implement
- [ ] 待启动的 child 自身 artifact 齐备（child-2/4 需自己的 design+implement；child-1/3 PRD 够）
- [ ] 测试环境验证迁移脚本
