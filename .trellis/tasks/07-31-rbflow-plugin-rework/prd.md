# 插件改造：任务id+本地/已提交区分+假进度+同步修复+删WS（子任务 E）

> 父任务：`07-31-rbflow-reliability-multiaccount`。共享架构见父 `design.md` 第 4、5 节。
> 仓库：`P:\lingfang-platform\plugins\rbflow-video\main.py`（PySide6，3648 行）。
> 安全边界不变：插件不持 RB 凭证，所有调用经桥。

## Goal

把插件从"WS/短轮询实时进度 + 提交即阻塞"改为"**5 分钟定时拉取 + 假进度 + 提交即入队**"，任务卡片显示任务 id 与"本地排队/已提交"区分，修复卡死/同步问题。

## Scope（改动文件）

- `plugins/rbflow-video/main.py`：`bridge_*` 客户端、`ProgressWorker`、`_PollWorker`、`TaskCardWidget`、`QueuePanel`、`SubmitWorker`/`VoiceSubmitWorker`、`MainWindow` 自动刷新定时器。

## Requirements

- R9.1 任务卡片显示 `rbflow_task_id`（短显示 + 完整 tooltip + 可复制）。
- R9.2 卡片/列表区分"本地排队中"（未得 task_id 或后端 phase=queued 未分配账号）与"已提交 RB"（有 rh_task_id）。
- R9.3 假进度：两次状态拉取间进度条平滑前进（本地 timer 估算），拉取后按后端返回对齐；与后端假进度语义一致（成功 100%、失败停前值）。
- R9.4 状态拉取改 **5 分钟**定时（沿用 `auto_refresh` 设置，间隔可调，默认 300s）；去掉 `_PollWorker` 的 5s 兜底短轮询或改为可配长间隔。
- R2.E 删除 `ProgressWorker`（长驻轮询线程），统一用定时拉取。
- R5.E1 提交（`SubmitWorker`）返回 task_id 即视为"已入队"，显示"本地排队/已提交"；提交请求超时 **不**标记任务失败，提示"提交超时，任务可能已在后台运行，请稍后刷新"。
- R5.E2 重进插件：从 `tasks.json` 恢复任务，按 task_id 拉真实阶段，不丢任务、不卡 UI。
- R5.E3 状态拉取非阻塞（短超时），UI 不卡；与 C 的桥状态接口配合。

## Acceptance Criteria

- [ ] 任务卡片可见任务 id（短显 + 可复制）。
- [ ] 提交后任务先显示"本地排队"，得 rh_task_id 后切"已提交/运行"。
- [ ] 进度条在 5 分钟拉取间隔内单调平滑前进，成功落 100%。
- [ ] 模拟提交请求超时：任务**不**被标失败，UI 不卡，重进后显示真实阶段。
- [ ] `ProgressWorker` 类已删除，无残留实例化。
- [ ] 状态拉取默认间隔 300s（可配），期间 UI 全程响应。
- [ ] 重进插件任务列表与 `tasks.json` 一致，状态可刷新到最新。

## Dependencies / Notes

- 依赖 A（后端假进度/状态语义）、C（桥/后端提交即入队 + 状态接口）。
- 与 C 同属"提交/同步"主题，建议相邻迭代、最好同分支验证。
- `tasks.json` 新字段走 `Task` dataclass 默认值（已知 known-field 过滤兼容）。
- 自动刷新定时器、本地假进度 timer 的具体节流参数 → 写在本任务 `design.md`。
