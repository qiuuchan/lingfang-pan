# 美化 AI 回复渲染

## Goal

改善桌面壳中 AI 回复的渲染观感。当前痛点：AI 介绍「三种插件类型（client / python / nodejs）」时以 Markdown 表格输出，桌面渲染成裸边框网格，观感呆板；用户明确希望这类对比信息**不要以表格显示**，改为更友好的卡片 / 列表式展示。

## 根因（已调研确认）

两层原因：

1. **渲染层**：`apps/desktop/src/components/markdown.tsx` 的 `COMPONENTS` 映射（[markdown.tsx:103-136](../../apps/desktop/src/components/markdown.tsx)）**完全没有 table / thead / tbody / tr / th / td 的定制**，表格走 react-markdown + remark-gfm 的默认裸 HTML 样式（仅 `border px-3 py-2`），缺乏圆角、表头底色、行分隔等现代观感。
2. **内容源头**：「三种插件类型」文案出自插件创建对话的系统提示 `apps/desktop/src/lib/plugin-creator-protocol.ts` 的 `DEFAULT_CONVERSATION_SYSTEM_PROMPT`（[plugin-creator-protocol.ts:67-84](../../apps/desktop/src/lib/plugin-creator-protocol.ts)），原文是 H3 标题 + 文本，**并未硬编码表格**。AI 自行选择用表格输出该对比，导致观感问题。

## Requirements

- 针对「三种插件类型」这类介绍 / 对比信息，最终在桌面壳中**不以裸表格呈现**，而是友好的卡片或结构化列表观感。
- 采用「双管齐下」策略，两项都做：
  - **渲染层**：在 `markdown.tsx` 为 table 系列元素补充美化样式（圆角容器、表头底色、行分隔 / 交替底色、单元格内边距增大、横向滚动保留），使所有 Markdown 表格观感提升——这是兜底，保证即使 AI 仍偶发输出表格也不难看。
  - **内容层**：在 `plugin-creator-protocol.ts` 的系统提示中，明确引导 AI 用卡片式 / 列表式（而非 Markdown 表格）介绍三种插件类型，给出期望的输出范式示例。
- 美化样式需适配亮 / 暗主题（复用主题色 token：`bg-muted`、`border-border` 等），不得硬编码颜色。
- 不破坏既有 Markdown 渲染（标题、列表、代码块、行内代码、链接）的现有观感。
- 不引入新的 Markdown 渲染库，沿用 react-markdown + remark-gfm。

## 实现要点

- 渲染层：在 `COMPONENTS` 增加 `table`（外层 `div` 包 `rounded-lg overflow-hidden border` + `overflow-x-auto`）、`thead`（`bg-muted/50`）、`th` / `td`（`px-4 py-2.5`）、`tr`（底部分隔线 / 交替底色）等映射，复用 `cn` 与主题 token。
- 内容层：修改系统提示，将三种插件类型从「易被渲染成表格的并列结构」改写为引导 AI 输出「每种类型一段带小标题的卡片式说明」或明确「不要用表格」。保持原有信息量不丢失。

## Acceptance Criteria

- [ ] 触发 AI 介绍三种插件类型时，输出不再是裸表格观感，呈现为卡片 / 列表式友好排版。
- [ ] 即便 Markdown 中出现表格，渲染后具备圆角、表头底色、行分隔、合理内边距，亮 / 暗主题下均协调。
- [ ] 其余 Markdown 元素（标题 / 列表 / 代码块 / 行内代码 / 链接）渲染无回归。
- [ ] 系统提示修改后信息完整，AI 仍能准确传达三种插件类型的适用场景。
- [ ] `apps/desktop` 类型检查 / 构建通过。

## Notes

- 轻量任务，PRD-only。
- 参考既有美化范本：`.trellis/tasks/archive/2026-06/06-13-output-rendering-polish/design.md`（代码块美化）。
- 验证方式：本地起桌面壳，触发插件创建对话查看实际渲染；或构造含表格的 Markdown 文本验证渲染样式。
