# 后端不可达页面美化

## Goal

当 fetch collab-api(:3000) 失败（localhost 拒绝连接）时，桌面端从"仅 toast 瞬时反馈"升级为展示一个友好、可操作的"无法访问此页面"组件，提供重试、去设置（配置后端地址）、查看状态等操作。

## Context

- 现状（api.ts:166-175）：fetch 抛异常 → toast 一条错误消息，无全屏/区块级错误态。
- 启动时（App.tsx:237-266）：网络错误保留 session 进主界面，后续操作持续 toast，体验差。
- 无 axios，原生 fetch wrapper；桌面端有 RootErrorBoundary（main.tsx:12-64）但只兜渲染崩溃。

## Requirements

- R6.1 新增一个 `<BackendUnreachable>` 组件（或 App 级错误态），在后端持续不可达时主内容区渲染该组件，替代反复 toast。
- R6.2 组件内容：友好图标 + "无法访问此页面 / 无法连接到 LingFang 服务" + 后端地址展示 + "重试"按钮（重新 testBackendUrl）+ "去设置"按钮（跳 backend tab 配地址）。
- R6.3 触发策略：区分"地址未配置"（现有 env-readiness 横幅已处理）与"地址已配但 fetch 失败"（本组件）。后者在关键全局请求（如 refreshSession / 首屏数据）失败且非 401 时，进入不可达态。
- R6.4 可恢复：点"重试"成功后自动退出不可达态、恢复正常界面；用户手动改地址后重试亦然。
- R6.5 不破坏现有 401→登出、AbortError→超时 toast 的既有路径。

## Acceptance Criteria

- [ ] 后端服务关闭时，桌面端显示"无法访问此页面"友好组件（非仅 toast）
- [ ] 组件展示当前后端地址
- [ ] "重试"按钮可重新探测，恢复后正常
- [ ] "去设置"跳转 backend tab
- [ ] 启动后端恢复后能自动/手动恢复主界面
- [ ] 401 登出、超时提示等既有行为不受影响
- [ ] lint/type-check 通过

## Design

- **状态归属**：在 App 顶层维护 `backendReachable` 状态。api wrapper 增加可选错误分类导出（如 `isConnectionError(err)`），App 监听全局事件（仿 `lf:unauthorized`，新增 `lf:backend-unreachable` / `lf:backend-reachable`）。
- **组件**：`apps/desktop/src/components/BackendUnreachable.tsx`，props 含 `address`、`onRetry`、`onGoSettings`。复用现有 UI 组件（Button/Card/Icon）。
- **降级渲染**：当 `backendReachable === false` 且已有 session 时，主内容区渲染该组件（不登出、不丢 session）。
- **重试**：调 `testBackendUrl()`（api.ts:81-93），成功派发 reachable 事件。

## Files

- `apps/desktop/src/components/BackendUnreachable.tsx`（新增）
- `apps/desktop/src/lib/api.ts`（事件派发）
- `apps/desktop/src/pages/App.tsx`（状态 + 渲染）

## Notes

- 中等复杂度，design 已给出，实现前可补 implement.md 或直接按 design 执行。
- 与 R7（拖动）无耦合。
