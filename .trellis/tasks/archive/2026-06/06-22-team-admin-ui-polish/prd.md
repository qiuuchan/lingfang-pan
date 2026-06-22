# 团队管理 UI 完善（插件授权 + 邀请码）

## Goal
插件授权 tab 下拉不再挤压；邀请码 tab 补状态中文化/过期时间/Checkbox 一致/创建时间。

## 改动
- `PluginGrantsTab.tsx:183`：主体类型/效果 trigger 加 `w-full`、`SelectContent` 加 `min-w-[12rem]`；「选择用户/角色」Select 独占一行（不再和类型/效果挤 grid-cols-2）
- `InvitationsTab.tsx`：
  - D1 `:99` status 中文化（ACTIVE→正常、DISABLED→已禁用，用 Badge）
  - D2 暴露 `expiresAt`：生成区加日期输入，`createInvitation` 传 expiresAt（后端 `team.service.ts:180` 已支持）
  - D3 `:164` 公开加入开关：原生 checkbox → `@/components/ui/checkbox`
  - D4 历史表加「创建时间」列（`createdAt`，formatTime）

## Acceptance
- [ ] 插件授权 dialog 的下拉/悬浮框不再挤压，选项完整可见
- [ ] 邀请码状态显示中文 Badge
- [ ] 可设置邀请码过期时间并生效
- [ ] 公开加入开关与其他 tab 的 Checkbox 样式一致
- [ ] 邀请码历史显示创建时间
- [ ] `pnpm -C apps/desktop typecheck` 通过；tauri dev 手动验证

## 参考
parent `design.md` § child-3
