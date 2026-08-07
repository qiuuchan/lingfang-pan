# desktop 适配 collab-api 路由与客户端 bug 修复

## Goal

desktop 客户端适配子任务 B 新增的 collab-api 路由（wallet/market 改 /api 前缀），修复 3 个客户端 bug：切 tab 中断生成、侧边栏悬浮字深色不可见、生成过程 JSON 输出步骤化。

## Parent

06-12-backend-collab-unification

## Requirements

### C1 wallet/market 调用改 /api 前缀（依赖子任务 B）

- Wallet.tsx：`/wallet` → `/api/wallet`
- Market.tsx：`/marketplace/*` → `/api/marketplace/*`、`/wallet/purchase` → `/api/wallet/purchase`

### C2 切 tab 中断生成（需求 5 前半）

- App.tsx：PluginCreatorHome 常驻挂载（display 控制），不再因 view 切换卸载，保留 Tauri 会话状态

### C3 侧边栏悬浮字（需求 3）

- Sidebar.tsx：PopoverContent/导航文字在深色下显式保证 text-popover-foreground/text-foreground

### C4 JSON 输出步骤化（需求 5 后半，参考 AionUI）

- code_assistant adapters 解析 CLI 结构化输出，发出细粒度 transcript 事件
- 前端 LiveProcess 改为事件时间线渲染

## Acceptance Criteria

- [ ] AC1 Wallet/Market 页面请求走 `/api/*`，不再 404
- [ ] AC2 生成中切换到其他 tab 再切回，生成状态与输出保留不中断
- [ ] AC3 深色主题下侧边栏 Popover 与导航文字清晰可见
- [ ] AC4 生成过程展示 CLI 各步骤（思考/命令/结果/输出）
- [ ] AC5 `pnpm -C apps/desktop typecheck` 通过

## Out of Scope

- server 清理（子任务 D）
- 三端模块化（子任务 E）

## Notes

- C4 需先看 codex.rs/claude.rs/opencode.rs 实际 stdout 结构再定事件粒度
- C2 最小改动：仅 home 常驻，其余页面仍条件渲染
