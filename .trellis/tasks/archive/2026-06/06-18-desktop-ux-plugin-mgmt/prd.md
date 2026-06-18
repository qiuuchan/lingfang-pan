# 桌面壳体验优化与插件管理（父任务）

## 背景

用户在使用 LingFang 桌面壳过程中反馈了 6 项相互独立的问题，覆盖插件运行交互、聊天体验、团队空间样式、作者侧插件治理与 AI 回复观感。本父任务作为需求源与任务地图的承载，不直接承担实现，由各子任务独立交付并独立验收。

## 需求来源（原始 6 项）

1. 启用插件后进入插件运行页，页面内无法点击 / 交互无响应。
2. 使用大模型接口为聊天会话自动生成标题。
3. 插件运行 / 启用状态支持手动刷新。
4. 团队空间「最近余额流水」表格贴边（缺少水平内边距）。
5. 在软件内管理自己发布的插件（编辑名称 / 描述 / 图标、上下架 / 启停、版本 / 价格管理、删除）。
6. 美化 AI 回复：当前「三种插件类型」用 Markdown 表格输出，桌面渲染观感差，希望改为非表格的友好展示。

## 子任务地图

| 子任务目录 | 标题 | 复杂度 | 主要改动面 |
| --- | --- | --- | --- |
| 06-18-fix-plugin-iframe-click | 修复插件进入后无法点击 | 轻量 | 桌面前端 dialog.tsx |
| 06-18-llm-chat-title | 大模型生成聊天标题 | 复杂 | collab-api + 桌面前端 |
| 06-18-plugin-status-refresh | 插件运行状态支持刷新 | 轻量 | 桌面前端 PluginList |
| 06-18-fix-wallet-table-padding | 修复余额流水表格贴边 | 轻量 | collab-admin 样式 |
| 06-18-author-plugin-management | 作者侧插件管理 | 复杂 | collab-api + 桌面前端新页面 |
| 06-18-beautify-ai-response | 美化 AI 回复渲染 | 轻量 | 桌面前端 markdown.tsx + prompt |

## 子任务排序与依赖

各子任务无强依赖，可并行实现。建议执行顺序按「收益 / 成本比」从高到低：

1. `fix-plugin-iframe-click`（阻断性 bug，一行修复，最高优先）
2. `fix-wallet-table-padding`（纯样式，低成本）
3. `beautify-ai-response`（局部前端改动）
4. `plugin-status-refresh`（局部前端改动）
5. `llm-chat-title`（跨端，含后端新接口）
6. `author-plugin-management`（跨端，含后端接口补齐与新前端页面，工作量最大）

依赖说明：`author-plugin-management` 与 `plugin-status-refresh` 可能同时改动 `apps/desktop/src/pages/PluginList.tsx`，由先合并者负责协调，后者基于最新代码实现，避免冲突。该约束已写入两个子任务的 `prd.md`。

## 跨子任务验收标准

- [ ] 6 个子任务各自的 `prd.md` 验收项全部满足，且各自通过 `trellis-check`。
- [ ] 桌面前端 `apps/desktop` 与 `apps/collab-admin` 改动后 `pnpm build` / 类型检查通过。
- [ ] collab-api 改动后 `pnpm build` 通过，新增接口有最小验证（手动或单测）。
- [ ] 全部改动遵循简体中文注释与既有代码风格规范。
- [ ] 不引入新的自研基础设施，优先复用既有组件与接口。

## 范围之外

- 不做插件状态的 WebSocket / 实时推送（仅做手动刷新）。
- 不做订阅 / 分级定价（沿用现有 priceCents 单价模型）。
- 不引入新的安全防御逻辑。
