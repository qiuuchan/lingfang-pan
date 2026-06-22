# Implement — Web 端团队角色管理（D7）

## 前置依赖
child-2 完成（platform.team.role.manage 已注册 + seed）

## 步骤
1. 后端：新建 admin-team-roles.controller.ts（5 端点）+ RoleService 加代管方法（指定 teamId）+ 审计；扩展 PATCH members/:userId/role 接受 roleId（兼容旧枚举）
2. 注册 controller 到 module；platform.team.role.manage 已在 child-2 seed
3. collab-admin lib/types.ts + api 客户端加新端点
4. 抽公共组件：roles-view 的 RoleEditDialog + 权限勾选 → components/role-* 公共件
5. teams-view.tsx TeamOverviewSheet 加「角色」tab；成员 tab 角色下拉换全部角色
6. 测试：后端代管方法单测（跨团队拒绝、系统角色锁定、审计）；前端 typecheck

## 验证
- pnpm -C apps/collab-api test
- pnpm -C apps/collab-admin typecheck
- 手动：collab-admin 登录平台管理员 → 任选团队 → 建/改/删角色 + 给成员分配自定义角色

## 风险
- 成员角色端点扩展的向后兼容（旧枚举 vs roleId）—— service 双分支 + 测试覆盖
- 抽组件勿破坏现有 roles-view（平台角色管理）—— 抽完跑一遍平台角色 CRUD

## Review Gate
- [ ] 用户终审本 child design + implement
