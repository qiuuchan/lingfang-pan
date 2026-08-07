# 权限码细分与迁移

## Goal

把 4 个「敏感度混合」的权限码拆细，并幂等迁移现有角色权限，不丢权限。

## 范围

4 处全拆 + 新增 `platform.team.role.manage`（给 child-4 D7）：见 parent `design.md` 映射表。

## Acceptance

- [ ] 4 旧码从注册表移除、11 新码注册；controller 守卫/ensurePermission 全部改挂新码
- [ ] `GET /teams/current/roles` list 改 OR 守卫
- [ ] seed-rbac 迁移脚本：现有自定义角色旧码扩张为新码，**不丢权限**；PermissionEntry 表无旧码残留
- [ ] 迁移幂等（二次运行 no-op）；事务保护；各环境场景通过
- [ ] 前端勾选面板展示新码
- [ ] 全部测试通过

## 参考

parent `design.md` / `implement.md` § child-2；本任务 `design.md` 详述迁移
