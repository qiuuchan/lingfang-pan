# Design

## Scope

本任务限定在 `apps/desktop` 前端层。页面装配继续使用现有 `View` + React state 模式，不引入路由库或新的全局状态库。

## Page Structure

- 使用两个独立主区 view：`run-plugins` 与 `develop-plugins`。
- 标题栏分段切换直接在两个 view 间切换；App 不再用单个 `plugins` view + `pluginMode` 分支承载两个页面。
- `run-plugins` 直接渲染现有 `PluginCenterBody` 主体，不改变原有数据加载、pin、运行、删除等行为。
- `develop-plugins` 渲染现有 `FloatingCreator` 的 `embedded` 形态，改造其页面布局和视觉结构。
- 删除右下角创建插件 FAB 与插件中心 Dialog 装配；旧的 `setView('creator')` 兼容入口改为切到 `develop-plugins`。
- 两个插件 view 通过现有 `PageTransition` 做简单淡入/位移动画。

## Visual Direction

- 顶部标题栏左侧分段切换器采用 Trae 风格：紧凑胶囊底板、两个按钮、当前态高亮。
- 开发插件页采用 Codex App / Claude 风格的深色工作台：
  - 左侧垂直导航栏用于承载创建器上下文入口、历史对话列表和工作模式入口。
  - 主区域显示大标题，输入框固定在底部居中，输入框下方保留横向快捷标签按钮。
  - 模型切换控件内聚到输入框区域，避免左侧栏控制过密。
  - 保留对话、草稿、详情 Sheet 等现有交互能力，只调整容器和控件样式。

## Compatibility

- 不改变 API payload、SSE 事件、插件草稿解析、上传/运行命令。
- 保留 `openPluginCenter(tab)` 的调用语义，但将实现从打开弹窗改为进入 `run-plugins` 主界面，避免影响现有调用方。
- 遵循当前 Tailwind/shadcn/lucide 组合与桌面深色主题 token。
