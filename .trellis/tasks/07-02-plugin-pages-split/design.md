# Design

## Scope

本任务限定在 `apps/desktop` 前端层。页面装配继续使用现有 `View` + React state 模式，不引入路由库或新的全局状态库。

## Page Structure

- 保留现有 `plugins` 视图作为插件区域入口。
- 在插件区域内部新增局部 `mode` 状态：`run` / `develop`。
- `run` 模式渲染现有 `Plugins` 页面主体，不改变原有数据加载、pin、运行、删除等行为。
- `develop` 模式渲染现有 `PluginCreatorHome` 的功能逻辑，但改造其页面布局和视觉结构。

## Visual Direction

- 顶部左上角分段切换器采用 Trae 风格：紧凑胶囊底板、两个按钮、当前态高亮。
- 开发插件页采用 Claude 风格的深色工作台：
  - 左侧垂直导航栏用于承载创建器上下文入口和最近插件列表。
  - 主区域居中显示大标题、圆角输入框和横向快捷标签按钮。
  - 保留对话、草稿、详情 Sheet 等现有交互能力，只调整容器和控件样式。

## Compatibility

- 不改变 API payload、SSE 事件、插件草稿解析、上传/运行命令。
- 不移动或重命名公共导出，避免影响现有调用方。
- 遵循当前 Tailwind/shadcn/lucide 组合与桌面深色主题 token。
