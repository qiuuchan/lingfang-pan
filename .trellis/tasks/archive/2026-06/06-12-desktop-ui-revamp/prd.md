# 桌面端 UI 整改与页面接入

## Goal

把 `apps/desktop` 客户端的视觉语言统一到 Codex 桌面 App 风格，全面替换原生元素为 shadcn 成品组件，清理 AI 生成的说明性废话，全局隐藏滚动条，拆分超 1000 行的文件，并把已写好但未接线的 4 个页面接入应用。

## Background

- 桌面端已有 14 个 shadcn UI 原子组件、Tailwind v4、base-nova style，基础设施就绪。
- `View` 类型（`lib/types.ts`）已预留 `market`/`wallet`/`review`，但 `App.tsx` switch 和 Sidebar 未接线。
- `Market`/`Wallet`/`Review`/`TenantSelect` 四个页面已实现但零路由引用。
- `Generator.tsx` 与 `PluginCreatorHome.tsx` 功能重复（都是造插件对话页）。
- `PluginCreatorHome.tsx` 1007 行，突破 1000 行硬上限。

## Requirements

### 功能需求

- R1 全局隐藏滚动条视觉，保留滚动能力（鼠标滚轮、触控板、键盘仍可滚动）。
- R2 删除所有 AI 生成的说明性废话：产品定位 badge（如"AionUI 式单对话 · 本地代码助手 · 右侧详情"）、空状态长说明、解释卡片用途的 `CardDescription`。保留必要操作提示与数据展示。
- R3 创建插件页（PluginCreatorHome）合并两个详情入口为单一入口。
- R4 接入 4 个游离页面：
  - Market（市场）、Wallet（钱包）进 Sidebar 主导航，全员可见。
  - Review（审核）进 Sidebar，仅 `isPlatformAdmin` 可见。
  - TenantSelect（切换/创建团队）以 Dialog 形式接入 Sidebar 用户区"切换团队"按钮。
- R5 修复死链跳转：Plugins 空状态可跳市场；Market 余额不足可跳钱包。
- R6 删除 Generator.tsx，并从 `View` 类型移除 `'generator'`。
- R7 拆分 PluginCreatorHome.tsx，主文件与所有衍生文件均 < 1000 行。

### 视觉需求

- R8 默认深色主题（Codex 桌面风：深色、紧凑、高信息密度、细边框）。
- R9 圆角统一为 4 档规约：`rounded-md`（输入/小）、`rounded-lg`（列表项）、`rounded-xl`（卡片）、`rounded-full`（头像/标签）。禁用 `rounded-2xl`/`rounded-3xl`。
- R10 状态/命令/session id 等技术性文本用 `font-mono`。

### 工程需求

- R11 所有原生交互元素替换为 shadcn 成品：`<button>`→Button、`<details>`→Collapsible、`<input type=checkbox>`→Checkbox、`<table>`→Table、emoji 评分→基于 lucide 的 Stars。
- R12 所有 `.tsx`/`.ts` 文件 < 1000 行。

## Acceptance Criteria

- [ ] AC1 任意页面滚动时不出现可见滚动条（webkit 与 firefox 均隐藏）。
- [ ] AC2 全应用搜索不到"AionUI 式单对话"、"本地代码助手 · 右侧详情"等定位 badge；无解释卡片用途的废话 `CardDescription`。
- [ ] AC3 创建插件页只有一个"详情"入口（header），composer 不再有"查看详情"。
- [ ] AC4 Sidebar 可见"市场"、"钱包"；平台管理员额外可见"审核"；点击各自进入对应页面。
- [ ] AC5 Sidebar 用户区"切换团队"打开 Dialog，内含团队列表与创建表单，切换/创建生效。
- [ ] AC6 Plugins 空状态点击可跳市场；Market 余额不足提示可跳钱包。
- [ ] AC7 `Generator.tsx` 不存在；`View` 类型不含 `'generator'`。
- [ ] AC8 应用默认深色；圆角统一，无 `rounded-2xl`/`rounded-3xl`。
- [ ] AC9 原生 `<button>`/`<details>`/`<input type=checkbox>`/`<table>`/emoji 评分清零（调试性 pre 块除外）。
- [ ] AC10 `wc -l` 校验 `apps/desktop/src` 下所有 `.tsx`/`.ts` < 1000。
- [ ] AC11 `pnpm -C apps/desktop typecheck` 通过。

## Out of Scope

- 后端 API 改动（仅前端消费现有接口）。
- Tauri Rust 层（`src-tauri/`）改动。
- 移动端适配（桌面优先）。
- 国际化（维持简体中文）。

## Open Questions

无（关键决策已确认）。
