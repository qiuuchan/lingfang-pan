# 界面交互优化：插件管理悬浮窗 + Skill 展示 + 动画 + 主题

## Goal

优化桌面端多项界面交互：①插件管理重构为悬浮窗 + 侧边栏固定/历史插件；②右下角创建插件 FAB 点击弹窗动画；③内置 Skill 改居中悬浮窗 + 背景模糊 + 去专业术语 + 扩展数量；④调慢全局动画速度；⑤缩小个人资料页底部高度；⑥外观主题未选中按钮加边框。

## Requirements

### R1 插件管理重构为悬浮窗（需求 #8）

- 现状：`pages/Plugins.tsx` 用 Tabs（本地/团队/市场）页面布局。
- 改为悬浮窗形式展示；侧边栏支持固定常用插件 + 历史使用过的插件（已有 pins/recent 基础设施 `App.tsx:91-129`）。
- 重新设计 UI + 完善整体交互逻辑。

### R2 FAB 点击弹窗动画（需求 #13）

- 右下角创建插件 FAB（`FloatingCreateButton.tsx`）点击弹出悬浮窗（`FloatingCreator.tsx:324-541`）时加过渡动画。

### R3 内置 Skill 展示优化（需求 #14）

- 现状：小 Popover 列表（`FloatingCreator.tsx:374-395`），数据在 `lib/skills.ts`。
- 改居中悬浮窗 + 背景模糊；删除「拼入系统提示词」等专业术语，仅保留必要话术；扩展内置 Skill 数量。

### R4 调慢全局动画速度（需求 #7）

- 统一调慢 `lib/motion.tsx` 各动画 duration（FadeIn/SlideIn/Stagger/PageTransition 等）及散落 inline 动画。
- 优先在 `packages/ui-tokens` 定义动画时长 token，再统一引用。

### R5 缩小个人资料页底部高度（需求 #9）

- `ProfilePanel.tsx` + `PanelDialog.tsx`：降低整体高度 / 底部留白。

### R6 外观主题未选中按钮加边框（需求 #12）

- `AvatarMenu.tsx:184-195` 主题按钮未选中态加边框。

## Acceptance Criteria

- [ ] 插件管理以悬浮窗展示，侧边栏可固定常用 + 显示历史使用插件，交互完整
- [ ] FAB 点击弹出创建悬浮窗有平滑动画
- [ ] 内置 Skill 居中悬浮窗 + 背景模糊，话术通俗，数量扩展
- [ ] 全局动画整体变慢且观感一致
- [ ] 个人资料页整体高度降低
- [ ] 外观主题未选中按钮有边框
- [ ] 桌面端构建通过

## 关键代码位置（探查结论）

- 插件管理：`pages/Plugins.tsx:16-73`、`pages/plugins/*`（LocalPluginsSection / TeamPluginsSection / *Row）；`App.tsx:54-58,91-129`（pins/recent）
- FAB：`components/FloatingCreateButton.tsx:1-24`；`components/creator/FloatingCreator.tsx:324-327`
- Skill：`lib/skills.ts:13-102`、`FloatingCreator.tsx:374-395,320-322`
- 动画：`lib/motion.tsx:33-229`、`AvatarMenu.tsx:150`、`FloatingCreateButton.tsx:19`、`FloatingCreator.tsx:493`、`ui/{dialog,popover,select,sheet}.tsx`；`packages/ui-tokens/tokens.css`（无动画 token，需新增）
- 个人资料：`ProfilePanel.tsx:43-62`、`PanelDialog.tsx:32-50`
- 主题按钮：`AvatarMenu.tsx:176-198`

## Notes

- 复杂任务：插件管理悬浮窗重构需 design.md + implement.md；其余为相对独立的 UI 调整。
- 多项可独立验证，建议按"低风险快赢（R4/R5/R6）→ Skill（R3）→ FAB 动画（R2）→ 插件管理重构（R1，最大）"推进。
