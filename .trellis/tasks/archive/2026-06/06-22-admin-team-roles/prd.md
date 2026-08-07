# Web 端团队角色管理（D7：B+C）

## Goal

平台管理员能在 collab-admin 为任意团队建/改/删角色并勾权限，能给任意成员分配该团队自定义角色。

## 范围（B+C）

- B 管：团队详情新增角色 CRUD + 两级权限勾选
- C 分配：成员 tab 角色下拉 TEAM_ADMIN/MEMBER 二选一 → 该团队全部角色
- A（只读）是 B 子集，不单做

## Acceptance

- [ ] collab-admin 团队详情 Sheet 有「角色」tab：列角色、建/改/删（系统角色锁定）、两级权限勾选
- [ ] 平台管理员能给任意团队成员分配该团队任意角色（含自定义）
- [ ] 后端新端点守卫 `platform.team.role.manage`；全部操作写审计
- [ ] `pnpm -C apps/collab-api test` + `pnpm -C apps/collab-admin typecheck` 通过

## 参考

parent `design.md` § child-4；本任务 `design.md`
