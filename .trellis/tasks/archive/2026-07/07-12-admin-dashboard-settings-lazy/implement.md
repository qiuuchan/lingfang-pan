# Implementation Plan

> 完成记录（2026-07-12）：Dashboard 首屏只加载核心接口，生成/财务区显式打开后加载；Settings 五域首次访问加载并保留草稿；入口文件已拆为稳定导出与 settings workspace。

- [x] 拆分 Dashboard core metrics、governance todos 和 on-demand insights。
- [x] 修正 dashboard backend pending plugin count 和前端 DashboardData type。
- [x] 实现 governance navigation intent 和正确初始 Tab/filter。
- [x] 移除 Dashboard 首屏 generation/finance 请求和重复 quick actions。
- [x] 移除 Footer changelog 请求，合并版本信息到 About/基础设置。
- [x] 拆分 Settings 五个 Tab 和 settings-api helper。
- [x] 实现 visitedTabs、按域 AsyncResource 和失败阻止空表单。
- [x] 删除/脱敏宽版 settings GET，并增加 secret 不泄漏回归测试。
- [x] 验证草稿保留、保存/测试失败状态和平台信息同步。
- [x] 运行 admin typecheck/build、network assertions 和多视口截图。

## Rollback

Dashboard insights 与 Settings Tab 可独立回退；后端统计接口不删除，只改变调用时机。
