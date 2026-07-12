# Implementation Plan

- [x] 扩展 `api()` 的外部取消支持并覆盖 cleanup。
- [x] 新增 `useAsyncResource` 和纯展示 `AsyncResource`。
- [x] 改造 Pagination 为响应式受控组件，保留兼容 props。
- [x] 用 Radix Sheet 重写 `DetailSheet` 内部实现。
- [x] 调整 Table、Card、Button、Input、Select、Dialog 和滚动条样式。
- [x] 将 `Section` / `InfoGrid` 收敛为扁平工作台组合。
- [x] 重构 App Header、内容滚动区和 Footer。
- [x] 分离 Sidebar desktop collapsed 与 mobile expanded 渲染。
- [x] 在现有用户/团队 Sheet 上做回归验证，确认旧调用方不破坏。
- [x] 运行 typecheck、build、`git diff --check`。
- [x] 验证 1440x900、1024x768、768x1024、390x844、360x800、1280x720。

## Rollback

- 组件 API 尽量保持兼容，可逐文件回退内部实现。
- 若 Shell 改造阻塞后续 view，可先保留新资源/抽屉组件并回退布局样式。
