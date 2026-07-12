# 技术设计

## 现状

- 生产入口只在 `App.tsx` 中使用 `FloatingCreator variant="embedded"`。
- legacy floating 分支仍保留另一套标题栏、历史弹窗、上下文/模型/技能入口，造成双套组件契约。
- `CreatorMessageList` 底部 context 栏与 `CreatorComposer` 上下文按钮打开同一个 `ContextInspector`。
- `CREATOR_COLUMN_CLASS` 为 `max-w-[96rem]`，对话与 composer 在大屏上失去阅读边界。
- `FloatingCreator.tsx` 超过 1500 行；会话持久化、类型归一化和 UI 装配混在同一文件。

## 目标结构

```text
TitleBar: 运行插件 / 开发插件
└── CreatorWorkspace
    ├── CreatorWorkspaceSidebar
    │   ├── 新建会话
    │   ├── 历史列表
    │   └── 账户入口
    ├── Main Agent Thread
    │   ├── Empty state / message stream
    │   ├── Agent status / todo
    │   └── Compact composer
    └── Artifact Inspector (仅有草稿时)
        ├── 概览
        ├── 文件
        ├── 检查结果
        └── 保存 / 发布
```

## 组件边界

- 将 `FloatingCreator.tsx` 重命名并收口为 `CreatorWorkspace.tsx`，删除 `variant` 和 floating UI 分支。
- `CreatorWorkspaceChrome.tsx` 只保留工作区侧栏；删除未使用的 `CreatorFloatingTitleBar`。
- 删除只服务 legacy floating 分支的 `CreatorHistoryDialog`。
- 把会话类型、归一化、localStorage 持久化、流式文本去重等纯逻辑抽到 `lib/plugin-creator/creator-session.ts`，让页面文件回到 1500 行以下。
- 保留现有 Agent loop、tools、store 和草稿数据流，不改变其调用契约。

## Composer

- 单一 bordered surface，textarea 默认约 52–60px，可随内容增长。
- 左侧常驻：`+` 扩展菜单、Agent/Plan、模型。
- 右侧常驻：唯一上下文用量入口、发送/停止。
- `+` 菜单承载附件、技能、引用插件、提示词优化、语音和工作区操作。
- 已选择附件、已引用插件和已绑定工作区以紧凑 context chips 显示在输入框内，不再使用独立大卡片。

## 对话与状态

- 对话列最大宽度设为约 52rem。
- 用户消息保留右侧气泡；助手正文改为无框内容流，降低连续大卡片感。
- reasoning、tool、question 继续用现有结构化组件。
- 删除消息区底部 context 栏；压缩/搜索/生成状态保留为紧凑状态行。

## Artifact Inspector

- 响应式宽度 `clamp(360px, 30vw, 420px)`，直接作为右侧 surface，不再在 aside 内嵌套一张大卡。
- 使用“概览 / 文件”标签组织内容；检查结果放在概览中，底部保存/发布操作保持固定。
- 表单与状态色使用语义 token；保留现有校验、保存、发布逻辑。

## 兼容与回滚

- localStorage 会话 key 和数据格式保持不变，历史会话无需迁移。
- `App.tsx` 和 `view-preload.ts` 更新懒加载路径；不存在外部公共 API。
- 如视觉重构出现回归，可按组件逐个回滚，Agent loop 与后端不受影响。

## 实施后边界说明

`CreatorWorkspace.tsx` 完成纯会话逻辑抽取后约 1340 行，已低于强制拆分线。剩余主体集中在同一次 Agent run 的流式 callbacks、工具事件和状态回写；本次 UI 重构不继续拆 hook，以避免同时改变异步闭包与取消语义。后续若新增 Agent 行为，应先抽 `useCreatorAgentRun` / `useCreatorWorkspaceSession`，不要继续扩大页面文件。
