# 完善管理面板、前台插件工作流与本地自动化

## Goal

让平台的管理端、桌面端和本地自动化形成可用闭环：管理员可以正确完成密码重置，用户可以并行运行多个插件、把插件 Action 接入定时任务和工作流，并能从界面看到清晰的运行状态与后续规划。

## Background / Confirmed Facts

- `apps/collab-admin/src/components/landing/LoginPage.tsx` 目前只有管理员找回密码请求，没有解析 `reset_token` 或重置表单。
- `apps/desktop/src/pages/Auth.tsx` 已实现 `reset_token` 解析和 `/api/auth/reset-password` 调用，可作为管理端实现参考。
- `packages/contract/src/local-scheduler.ts` 已定义 `PLUGIN_ACTION`，但 `apps/desktop/src-tauri/src/scheduler/executor.rs` 只记录占位成功。
- Rust `PluginProcessTable` 已按 `plugin_id` 保存进程，桌面前端 `App.tsx` 仍以单一 `runningPlugin` 作为当前视图。
- `packages/workflow-engine` 与 `apps/collab-api/src/modules/workflow-run.service.ts` 已支持工作流计划、嵌套工作流和 Action invocation，但桌面侧缺少把工作流作为普通插件调用的稳定适配层。
- Cloud deployment / automation 契约和数据库模型被其他工作流/治理代码引用。本任务不做破坏性删除，只关闭 Cloud 定时执行和新建入口，保留兼容读取。

## Requirements

### R1 密码重置

管理后台从邮件链接打开时必须识别 `reset_token`，展示新密码/确认密码表单，调用公共重置接口；成功后回到登录并清理 URL token。无效、过期或不一致密码必须显示明确错误，不能静默回到普通登录页。

### R2 本地定时任务调用插件

`PLUGIN_ACTION` 必须真实调用已安装插件的 Action，复用桌面 Action runtime 的权限、输入校验、超时和错误语义；成功记录输出摘要，失败/超时记录对应状态。删除 Cloud 定时任务的新建与执行入口，旧数据读取时显示为已弃用或不可执行。

### R3 多插件同时运行

桌面端允许多个 Node/Python 插件同时运行，启动、停止、状态刷新和崩溃回收必须按 plugin id 隔离；当前插件视图可以切换，但不能因切换或关闭一个插件而终止其他插件。

### R4 工作流开发与工作流实例插件

提供可保存、校验、发布和运行的工作流实例插件适配：工作流节点可以调用普通插件 Action，普通插件 Action 也可以调用已发布工作流实例；必须复用现有 workflow-engine 的依赖、绑定、嵌套递归和并行限制校验。桌面端至少提供工作流节点列表/连接编辑和运行结果展示的 MVP。

### R5 管理面板、前台状态和规划

管理端增加平台运行概览（插件、工作流、定时任务、失败运行数）和“未来规划”页面；桌面端增加插件/工作流/定时任务状态入口，明确本地任务仅在应用运行时执行。新增 `docs/roadmap.md`，记录当前版本、已知未完成项、下一阶段里程碑和 Cloud 兼容策略。

## Acceptance Criteria

- [ ] 管理端邮件链接 `/?reset_token=...` 打开后显示重置密码表单，成功调用 API 并返回登录；相关组件测试覆盖 token 解析和失败状态。
- [ ] 定时任务 Action 不再直接返回占位成功；至少一个真实已安装插件 Action 的成功、失败、超时路径有自动化测试。
- [ ] 两个不同 plugin id 可同时启动；停止其中一个后另一个仍为 running；前端状态刷新不互相覆盖。
- [ ] 工作流实例可作为 Action target 被调用，工作流内部可调用插件 Action；非法依赖/递归仍被 workflow-engine 拒绝。
- [ ] Cloud 定时任务入口不再出现在新建/执行路径，旧配置不会被删除且能显示弃用状态。
- [ ] 管理端和桌面端构建、类型检查、相关单元测试通过；`docs/roadmap.md` 与实际功能状态一致。

## Scope Decisions

- 本轮不删除 Cloud 数据表、契约和历史 API，避免已有工作流发布物无法读取。
- 本轮不实现后台常驻 Cloud executor；定时任务统一走桌面本地 scheduler。
- 视觉重构不作为阻塞项，优先保证跨层契约、运行状态和错误处理。
