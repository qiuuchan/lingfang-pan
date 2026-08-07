# 本地定时任务 Local Scheduler

## Goal

参考 CodeBuddy WorkBuddy 桌面客户端的"自动化"功能，给灵坊桌面端加入**本地定时任务**：任务配置持久化到本地磁盘，**仅在桌面端运行时触发**，支持三种执行体（Agent prompt / 插件 action / 系统通知），Agent 可在对话中创建/管理，侧边栏顶级入口 + 失败红点。

**核心语义**：不补跑、串行（并发 1）、超时 30 分钟、关机重启不丢配置。

## Scope

### MVP 包含

- 三种执行体：`AGENT_PROMPT` / `PLUGIN_ACTION` / `NOTIFY`
- 两种触发：`ONCE`（一次性）/ `CRON`（cron 表达式）
- 持久化：每任务一文件夹，关机/重启不丢
- Agent 工具：`ScheduleCreate` / `ScheduleList` / `ScheduleDelete` / `SchedulePause` / `ScheduleResume`
- 管理页：列表 + 编辑 + 立即运行 + 历史记录
- 侧边栏：顶级入口 + 失败红点徽章
- 通知：应用内 + 系统通知，全状态推送，支持勿扰时段

### MVP 不做

- workflow-engine 触发（用户明示）
- 补跑（关机漏掉的不管）
- 并行执行（串行，并发 1）
- 自动重试
- 系统级守护（不开桌面端就跑）
- 无头 Agent 工具白名单（全开，用户自担风险）

## Requirements

### R1 契约（packages/contract）

- 新建 `packages/contract/src/local-scheduler.ts`
- 定义 `LocalSchedule`、`LocalScheduleTrigger`、`LocalScheduleRun`、`LocalScheduleStatus`、`LocalScheduleRunStatus` 等 Zod schema
- **不复用**云端 `AutomationSchedule`（plugin-cloud-automation.ts），命名加 `Local` 前缀划清边界
- 在 `packages/contract/src/index.ts` 加 `export * from './local-scheduler';`
- cron 表达式校验 regex；时区字段显式存（默认系统时区）
- payload 是 discriminatedUnion 三种；prompt 上限 10000 字符
- timeout 默认 30 分钟（1_800_000 ms）

### R2 Rust 调度器（src-tauri/src/scheduler/）

- 新模块：`mod.rs` / `state.rs` / `storage.rs` / `cron.rs` / `executor.rs` / `commands.rs`
- SchedulerState：tasks HashMap + due_queue VecDeque + running Option + 60s tick
- 文件存储：`app_data_dir/scheduler/tasks/<id>/{task.json, runs.jsonl}`，原子写
- runs.jsonl 保留最近 200 条，append 时 GC
- Tauri commands：scheduler_create / update / delete / list / pause / resume / run_now / list_runs / record_run
- tick loop：60s 间隔，算 next_run_at，due 的塞队列，**重算下一个未来时间（不补跑）**
- 串行执行：running.is_some() 时新到任务记 SKIPPED
- 30 分钟硬超时（tokio timeout 包裹），kill 进程
- 三种 payload 分发：
  - AGENT_PROMPT → emit("scheduler:trigger", { task_id }) 给前端
  - PLUGIN_ACTION → 复用 plugin_runner
  - NOTIFY → tauri-plugin-notification
- Cargo.toml 加 `croner = "2"`、`tauri-plugin-notification = "2"`
- 在 main.rs setup 注册 SchedulerState + 启动 tick

### R3 前端常驻组件

- 新建 `apps/desktop/src/components/SchedulerAgentRunner.tsx`
- 挂载在 `App.tsx` 根，不依赖当前 view
- 监听 `scheduler:trigger` 事件 → 启动隔离 Agent session
- workspace = `workspaces/scheduler/<task_id>/`（自动创建隔离）
- 复用 `agent/loop.ts` + 现有 18 个工具（全开）
- **AskQuestion 拦截**：无头 session 上下文里 execute 返回 `{ ok: false, error: '无人值守模式不支持提问' }`
- 跑完调 `scheduler_record_run` 回写结果

### R4 管理页（apps/desktop/src/pages/Schedules.tsx）

- 顶部 Banner：`⚠️ 定时任务仅在应用运行时触发，关闭窗口将暂停所有任务`
- 任务列表：名称 + 类型徽章 + cron/时间 + 下次触发 + 上次结果
- 操作：立即运行 / 编辑 / 暂停/恢复 / 删除 / 历史
- 编辑对话框：名称 / 类型选择 / 触发配置 / payload 编辑 / timeout / 时区
- 历史抽屉：runs.jsonl 最近 200 条
- App.tsx 加 `schedules` view 路由

### R5 侧边栏入口（Sidebar.tsx）

- `NAV` 加 `{ v: 'schedules', label: '定时', icon: ClockIcon }`
- 失败红点徽章：监听 run_finished 事件，FAILED|TIMEOUT 且未在 Schedules 页确认 → 红点

### R6 Agent 工具（agent/tools.ts）

- 5 个 defineTool：ScheduleCreate / ScheduleList / ScheduleDelete / SchedulePause / ScheduleResume
- 工具描述明确：cron 格式、时区、prompt 上限、三种 payload 字段

### R7 通知 + 勿扰

- 4 种状态文案（SUCCESS / FAILED / TIMEOUT / SKIPPED）
- 渠道：通知中心（NotificationCenter）+ 系统通知（tauri-plugin-notification）
- 设置页加 `lf:dnd-window`（如 `23:00-07:00`），勿扰时段仅存通知中心

### R8 关闭确认（main.rs close-action 接入）

- 现有 `lf:close-action: ask/tray/quit` 流程
- ask 路径对话框：若有 ACTIVE 任务，追加"⚠️ 有 N 个定时任务正在运行"
- tray 路径：进程常驻调度器照跑
- quit 路径：进程退出，重启后从下一个未来时间继续

## Acceptance Criteria

- [ ] AC1：`packages/contract` 导出 `LocalSchedule` 等类型，typecheck 通过
- [ ] AC2：Rust 调度器模块编译通过，60s tick 能算 next_run_at
- [ ] AC3：通过 Agent 工具 `ScheduleCreate` 能创建一个定时任务，写入 `app_data_dir/scheduler/tasks/<id>/task.json`
- [ ] AC4：到点后 AGENT_PROMPT 任务能触发前端 Agent session 并跑完
- [ ] AC5：到点后 NOTIFY 任务能弹出系统通知
- [ ] AC6：到点后 PLUGIN_ACTION 任务能调用插件 action
- [ ] AC7：侧边栏"定时"入口可进入管理页
- [ ] AC8：管理页能编辑/暂停/恢复/删除/立即运行任务
- [ ] AC9：历史抽屉能查看最近 200 条 runs
- [ ] AC10：任务跑完推通知（成功/失败/超时/跳过都有对应文案）
- [ ] AC11：30 分钟硬超时生效（测试时可调小）
- [ ] AC12：前一个任务未跑完时新到任务记 SKIPPED
- [ ] AC13：关闭窗口时若有 ACTIVE 任务弹确认（ask 模式）
- [ ] AC14：勿扰时段不弹系统通知但仍存通知中心
- [ ] AC15：`pnpm typecheck` 全绿
- [ ] AC16：单测覆盖 cron 解析、存储原子写、GC 轮转、状态机

## Technical Decisions

| 决策点                | 选定值                                                 | 理由                        |
| --------------------- | ------------------------------------------------------ | --------------------------- |
| 形态                  | B（持久化本地 + 在线触发）                             | CodeBuddy WorkBuddy 模式    |
| 补跑                  | 不补跑                                                 | 简化，避免追赶队列          |
| 执行体                | AGENT_PROMPT / PLUGIN_ACTION / NOTIFY（不含 workflow） | 用户明示不做 workflow       |
| 未登录                | skip + 日志                                            | 沿用 CodeBuddy 语义         |
| 超时                  | 30 分钟硬超时                                          | 用户指定                    |
| 失败处理              | 不重试，记日志                                         | 防雪崩                      |
| 并发                  | 串行，最大并发 1                                       | 资源/配额约束               |
| 进程模型              | Rust tokio task                                        | Tauri 原生                  |
| 窗口生命周期          | γ（默认 quit + 关闭确认）                              | 复用现有 close-action       |
| cron 库               | croner                                                 | 轻量纯 Rust                 |
| 存储                  | 每任务一文件夹                                         | 配置/日志分离，rmdir 一刀切 |
| 时区                  | 显式 time_zone，默认系统                               | 防 DST 坑                   |
| prompt 上限           | 10000 字符                                             | 用户指定                    |
| AGENT_PROMPT 执行路径 | Z（常驻隐藏组件）                                      | 复用 agent loop             |
| runs 保留             | 200 条                                                 | 防无限增长                  |
| 任务未跑完又到点      | 跳过 (a)                                               | 防队列堆积                  |
| 开机补跑              | 彻底忽略 (α)                                           | 与"不补跑"自洽              |
| 侧边栏入口            | 顶级 + 失败红点徽章                                    | 显眼 + 状态反馈             |
| 新建任务入口          | 管理页 + Agent 工具                                    | 双通道                      |
| 无头 Agent 工具       | 全开                                                   | 用户指定，工具不是二等公民  |
| AskQuestion 无头      | 返回错误让 Agent 自行绕开                              | 避免永久挂起                |
| 工作目录              | 自动隔离 workspaces/scheduler/<task_id>/               | 兜底文件爆炸半径            |
| 完成通知              | 全状态推送 + 勿扰时段                                  | 透明优先                    |

## References

- [CodeBuddy WorkBuddy 自动化指南](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Automation-Guide)
- [CodeBuddy Code 定时任务 CLI](https://www.codebuddy.ai/docs/zh/cli/scheduled-tasks)
