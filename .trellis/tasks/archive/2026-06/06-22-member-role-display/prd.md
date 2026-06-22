# 成员角色名显示与 MembersTab 清理

## Goal
成员管理 tab 显示成员实际角色名（含自定义角色），分配下拉按 roleId 正确匹配。

## 现状（勘察）
- `team.service.ts:166` currentMembers 只返回 `role` 枚举（TEAM_ADMIN/MEMBER），无 roleId/roleName。
- `MembersTab.tsx:70-81` 枚举硬编码「团队管理员/成员」+ name 字符串反查下拉默认值（脆弱）；`roleById` Map（:46）建了没用。

## 改动
- 后端 currentMembers：prisma `include: { role: { select: { id, name, code } } }`（经 teamRoleId 关联），返回补 `teamRoleId + roleName + roleCode`
- contract `TeamMember` schema + desktop `types.ts` 加 optional 字段（向后兼容）
- MembersTab：「当前角色」列显示 roleName；分配下拉 value 用 teamRoleId；删 roleById + name 反查

## Acceptance
- [ ] 成员列表「当前角色」列显示角色实际名字（自定义角色如「开发者」也正确）
- [ ] 分配下拉默认选中成员当前角色
- [ ] 无枚举硬编码、无 name 字符串匹配、无 roleById 冗余
- [ ] `pnpm -C apps/collab-api test` + `pnpm -C apps/desktop typecheck` 通过

## 参考
parent `design.md` § child-1
