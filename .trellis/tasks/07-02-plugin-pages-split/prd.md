# 插件页重构：运行/开发双子页 + Trae分段切换 + Claude风格创建器

## Goal

将插件相关入口拆成「运行插件」和「开发插件」两个独立子页面，并在页面左上角提供 Trae 风格的分段模式切换器。运行插件页保留现有布局与交互；开发插件页改为 Claude 风格的深色创建器布局，同时复用现有插件创建交互和数据逻辑。

## Requirements

- 在插件区域左上角新增分段模式切换器，选项为「运行插件」和「开发插件」。
- 点击「运行插件」时显示现有插件运行/管理页面，现有布局、数据加载、插件固定、运行入口等行为保持不变。
- 点击「开发插件」时显示现有插件创建器能力，但整体 UI 重构为深色主题：左侧垂直导航栏，中间居中大标题和圆角输入框，输入框下方横向快捷标签按钮。
- 快捷标签按钮包含 Code、Learn、Create、Write、Life stuff，并作为现有输入/发送体验的视觉快捷入口，不改变后端协议或草稿合并逻辑。
- 仅修改样式、布局和页面切换装配；不改变插件运行、插件创建、上传、草稿解析、会话流式响应等数据逻辑。

## Acceptance Criteria

- [ ] `beta` 分支承载本次修改。
- [ ] 插件区域可在「运行插件 / 开发插件」之间切换。
- [ ] 「运行插件」页视觉和行为保持现状。
- [ ] 「开发插件」页呈现 Claude 风格深色 UI，包含左侧垂直导航、中间标题、圆角输入框和横向快捷标签按钮。
- [ ] 现有插件创建交互与数据逻辑可继续工作。
- [ ] 前端类型检查、测试和构建通过，或记录无法运行的原因。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
