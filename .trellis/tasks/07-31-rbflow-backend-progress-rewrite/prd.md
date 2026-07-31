# 后端进度链路重构：去硬超时+删WS+5分钟轮询+假进度（子任务 A）

> 父任务：`07-31-rbflow-reliability-multiaccount`。共享架构见父 `design.md` 第 2 节。
> 仓库：`P:\RBFLow`（独立 git 仓库）。是整个改造的**地基**，B/D/E 消费本任务的进度/状态模型。

## Goal

把 `orchestrator._wait_and_collect_outputs` 从"WS 实时 + 5s 短轮询 + 900s 硬超时"重构为"**无 WS + 5 分钟轮询 + 无硬超时 + 假进度**"，让长任务不再被本地超时误杀，进度条在长间隔内仍平滑可见。

## Scope（改动文件）

- `app/core/orchestrator.py`：`_wait_and_collect_outputs`、`_poll_outputs_with_grace`、`_obtain_wss_with_retry`、`_try_get_wss`、`run_task`（UPLOAD/CREATE 阶段节奏）。
- `app/core/progress.py`：`ProgressEstimator` 去除对 WS `tracker` 输入的依赖，确认纯 phase + 时间线性 ramp 可用；调假进度斜率/封顶。
- `app/settings.py`：`RuntimeConfig` 新增 `run_poll_interval_sec`(默认 300)、`eta_baseline_sec`(默认 1200)；明确 `poll_interval_sec`、`task_timeout_sec`、`failure_grace_sec` 的新语义（`task_timeout_sec` 弃用/移除，`extra=ignore` 兜底老配置）。

## Requirements

- R1.1 移除 `_poll_outputs_with_grace` 中 `run_deadline` 到点 `return []` 的硬放弃分支；终止仅靠"outputs 非空"或"FAILED 且 grace 耗尽"。
- R1.2 RUNNING 阶段轮询用 `run_poll_interval_sec`（默认 300s）；UPLOAD/CREATE 阶段保持主动调用节奏（可沿用较短间隔）。
- R2.1 删除 `_wait_and_collect_outputs` 的 Phase B（WS `monitor_progress` 调用）及 `_obtain_wss_with_retry`/`_try_get_wss`；`run_task` 不再获取 `net_wss_url`。
- R2.2 `RunningHubClient.monitor_progress` 是否物理删除由本任务 design 决定（推荐保留方法、编排不调用，降低 diff 风险）。
- R3.1 假进度：`SUCCESS`→100%；`RUNNING`→按已运行时间/`eta_baseline_sec` 线性推进，封顶 95%；`FAILED`→停在当前值。两次轮询间进度必须可见前进。
- R3.2 保留 `failure_grace_sec`（SUCCESS-empty / FAILED 后等 CDN），grace 不再被任何硬上限截断。

## Acceptance Criteria

- [ ] 构造一个 mock 慢任务（RB 持续返回 RUNNING 30+ 分钟），后端**不**判失败，最终 SUCCESS 落盘。
- [ ] 编排路径无 `monitor_progress` 调用（grep 确认）；`netWssUrl` 不再被读取。
- [ ] RUNNING 阶段两次状态查询间隔 ≈ `run_poll_interval_sec`（看日志/计日志次数验证）。
- [ ] 进度条值在 5 分钟间隔内单调前进，无长时间不动；成功=100%。
- [ ] `config.yaml` 仍写 `task_timeout_sec` 不报错（extra ignore 兜底）。

## Dependencies / Notes

- 无上游子任务依赖（地基）。
- B 与本任务共享 `settings.py` 改动，注意合并冲突（先合 A）。
- 假进度的具体斜率/封顶数值、是否删 `monitor_progress` 方法 → 写在本任务 `design.md`。
