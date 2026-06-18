# 插件运行状态支持刷新

## Goal

为桌面壳云端插件列表（PluginList）补充手动刷新能力，让用户在插件运行 / 启用状态发生变化（自己切换、或被管理员 / 其他端改动）后，能主动拉取最新状态而无需重启或重新进入页面。

## 根因（已调研确认）

- 云端插件列表 `apps/desktop/src/pages/PluginList.tsx` 通过 `loadPlugins()` 一次性加载，**无刷新按钮、无轮询**；首次加载后状态固定，仅在作者自己改价 / 切状态时经 `onAuthorChanged` 回调局部刷新。
- 对比：本地插件列表 `LocalPluginList` 已有「重新扫描」刷新按钮（Card 标题栏右侧 `RefreshCwIcon`，触发 `scanPluginStatus`），可作为样式与交互范本。
- 后端无需改造：`GET /api/plugins/mine`、`GET /api/plugins/available`、`POST /api/plugins/:id/set-status` 已满足，重新调用即拿到最新状态。

## Requirements

- 在云端插件列表（PluginList）Card 标题栏右侧新增刷新按钮，复用本地插件列表的 `RefreshCwIcon` 样式与位置，保持两处视觉一致。
- 点击刷新触发重新加载 `loadPlugins()`，更新列表状态。
- 刷新进行中显示加载态（按钮 disabled + 图标 spin 或等价反馈），防止重复点击与并发请求。
- 不引入自动轮询 / WebSocket（明确范围之外）。
- 仅做云端插件列表的刷新；本地插件已具备刷新，不重复改造。

## 实现要点

- 复用 `Plugins.tsx` 中已有的 `reload()` / `loadPlugins()` 链路，把刷新入口暴露到 PluginList 的标题栏。
- 加载态用组件局部 state（如 `refreshing`）控制按钮 disabled 与图标动画。
- 复用 `lucide-react` 的 `RefreshCwIcon` 与既有按钮组件，不新增依赖。

## 依赖与协调

- 本任务与 `06-18-author-plugin-management` 均可能改动 `apps/desktop/src/pages/PluginList.tsx`。若另一任务先合并，本任务基于最新代码实现，避免冲突；反之亦然。

## Acceptance Criteria

- [ ] 云端插件列表标题栏出现刷新按钮，样式与本地插件刷新按钮一致。
- [ ] 点击刷新后列表重新拉取并反映最新启用 / 运行状态。
- [ ] 刷新过程中按钮处于加载态且不可重复触发，完成后恢复。
- [ ] 本地插件列表的既有刷新功能无回归。
- [ ] `apps/desktop` 类型检查 / 构建通过。

## Notes

- 轻量任务，PRD-only。
- 范围之外：自动轮询、实时推送、跨端状态同步通知。
