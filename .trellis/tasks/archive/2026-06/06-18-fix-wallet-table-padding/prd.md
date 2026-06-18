# 修复余额流水表格贴边

## Goal

修复团队空间详情侧边栏（DetailSheet）「流水（ledger）」标签页中，最近余额流水列表 / 表格内容贴近侧栏左右边界、缺少水平内边距的样式问题，使其与侧栏整体留白协调。

## 根因（已调研确认）

- 流水内容位于 `apps/collab-admin/src/components/teams-view.tsx` 的 `TeamOverviewSheet` 中流水 `TabsContent`（约 [teams-view.tsx:365-392](../../apps/collab-admin/src/components/teams-view.tsx)）。
- `TabsContent` 来自 `apps/collab-admin/src/components/ui/tabs.tsx`，其 className 仅有 `mt-2`（[tabs.tsx:43-51](../../apps/collab-admin/src/components/ui/tabs.tsx)），**无水平 padding**。
- DetailSheet 内容区虽有 `p-5`，但 Tabs 内容区相对容器仍显贴边；当前流水是卡片列表（`rounded-xl border px-3 py-2`），视觉上紧贴侧栏内壁。

## Requirements

- 团队详情侧边栏「流水」标签页内容与侧栏内壁之间有合理水平留白，不再贴边。
- 修复应精准作用于流水列表 / 表格区域，**不破坏**同一 Tabs 下其他标签页（成员 / 插件 / 购买等）的既有布局；若其他标签页存在同样贴边，可一并以一致方式处理，但需逐一确认无回归。
- 复用既有间距 token / Tailwind 类，不硬编码像素、不引入新样式体系。
- 与侧栏 header / 内容区的 `p-5` 留白保持视觉一致。

## 实现要点

优先方案（精准、影响面小）：在 `teams-view.tsx` 流水列表的外层容器补充水平内边距（或调整 TabsContent 该处 className），使其与 DetailSheet 内容区留白对齐。若评估后认为所有 TabsContent 都应有统一水平间距，则在 `tabs.tsx` 的 TabsContent 统一补充并回归测试各标签页。最终方案由实现阶段基于实际 DOM 留白确定，记录在操作日志。

## Acceptance Criteria

- [ ] 团队空间打开某团队详情 → 流水标签页，流水条目左右与侧栏内壁有协调留白，不再贴边。
- [ ] 同一侧栏的其他标签页（成员 / 插件 / 购买等）布局无回归。
- [ ] 留白与侧栏 `p-5` 整体视觉一致。
- [ ] `apps/collab-admin` 类型检查 / 构建通过。

## Notes

- 轻量任务，PRD-only。
- 验证方式：本地起 collab-admin，进入团队详情查看流水标签页留白；对比其他标签页确认无回归。
