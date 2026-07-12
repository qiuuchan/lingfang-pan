# 管理端异步资源与响应式基础

## Goal

为后续所有管理端业务 view 建立统一、可访问、可响应式的动态加载基础，消除客户端全量分页、状态混淆和浮层焦点问题。

## Requirements

- `api()` 支持调用方 AbortSignal，并区分主动取消、超时、网络和业务错误。
- 提供统一资源状态：`idle/loading/ready/empty/error`，错误状态有内联重试，不能把失败显示成“暂无”。
- Pagination 改为完全受控的服务端分页展示；保留桌面页码，移动端使用紧凑上一页/当前页/下一页。
- `DetailSheet` 内部使用现有 Radix Sheet，具备焦点锁定、焦点归还、ESC、背景滚动锁和固定 footer。
- Table 保留可见横向滚动指示，业务页可隐藏次要列。
- `Section` 改为无外层 Card 的工作台区块，减少卡片套卡片。
- App Header 收敛为紧凑工具栏，主内容使用单一滚动区和稳定宽度。
- 桌面 Sidebar 折叠与移动 Sheet 分离；移动端始终显示完整导航文案。
- 全局不再隐藏所有滚动条，只在明确标记 `.scrollbar-hide` 的区域隐藏。
- 不改变具体业务 API 或领域状态机。

## Acceptance Criteria

- [x] 主动取消的请求不会弹错误，真实超时和失败仍有明确反馈。
- [x] AsyncResource 可区分 loading、error、empty 和 ready，并支持重试。
- [x] Pagination 在 360px 宽度不溢出，在桌面可访问首末页和页码。
- [x] DetailSheet 关闭后焦点返回触发行，Tab 不会进入背景，短视口正文独立滚动。
- [x] 1024px 边界切换正常；移动侧栏显示分组与文字。
- [x] 管理端页头、Section、Table 不再形成三层浮卡。
- [x] 表格和详情滚动区有可见滚动指示。
- [x] `pnpm -C apps/collab-admin typecheck` 与 `build` 通过。

## Out Of Scope

- 迁移具体业务 view 的列表 API。
- 插件治理、审批状态机和设置页面拆分。
