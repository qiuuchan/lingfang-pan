# 多 RB 账号池 + 每账号并发门（子任务 B）

> 父任务：`07-31-rbflow-reliability-multiaccount`。共享架构见父 `design.md` 第 3 节。
> 仓库：`P:\RBFLow`（独立 git 仓库）。

## Goal

RBFLow 后端从单 RB key 改为**多账号池**：N 个 RB API key，每 key 并发上限默认 3（可配），新任务分配给最闲的可用账号，全满则在本地队列排队。满足"一个 RB 账号最多 3 个并发"硬约束 + 横向扩容。

## Scope（改动文件）

- 新增 `app/core/accounts.py`（`RhAccount` + `AccountPool`）或并入 `app/core/queue.py`（design 决定）。
- `app/core/queue.py`：`_run_worker` 增加"取任务 → `AccountPool.acquire()`（阻塞等待）→ release"门；`QueueManager` 暴露账号池快照。
- `app/core/orchestrator.py` + `app/integrations/runninghub.py`：`run_task(task_id, account)` 用 `account.api_key` 构造 client；`RunningHubClient.__init__` 已支持 `api_key` 参数（确认即可）。
- `app/settings.py` + `config.yaml`：`runninghub.accounts: [{id, api_key, concurrency_limit, enabled}]`；向后兼容（无则用 `RUNNINGHUB_API_KEY` 造默认单账号）。
- `data/accounts_state.json`：运行时启用/限流覆盖持久化。
- `app/models/task.py` + 迁移：`Task` 增 `rh_account_id` 列。
- `app/api/*`：账号池读写 API（与 D 的配置页对接，接口在 B 定义、D 消费）。

## Requirements

- R4.1 支持配置 N 个账号；每账号 `concurrency_limit` 默认 3。
- R4.2 `AccountPool.acquire()`：`enabled and in_flight < limit` 中选 `in_flight` 最小者；全满阻塞/塞回队列等待 `release` 唤醒。
- R4.3 worker 取任务后先 acquire 账号；拿不到则任务回队列顶端 + 等唤醒（**拓扑乙**，见父 design 3.3）。避免活锁（回队列后让出 worker）。
- R4.4 任务记录 `rh_account_id`（NULL=本地排队未分配）。
- R4.5 保留 `_create_task_with_421_retry` 作 421 兜底；421 退避耗尽 → release 槽位 + 任务回队列重试。
- R4.6 单账号部署（仅 `RUNNINGHUB_API_KEY`）行为与现状一致（N=1 特例）。
- R4.7 账号池可热更新（配置页改 → 重建池，保留在跑任务归属）。

## Acceptance Criteria

- [ ] 配 2 账号 × 并发 2，提交 5 任务：前 4 立即提交（日志见 4 个不同/分配的 rh_task_id），第 5 个 `state=PENDING, rh_account_id=NULL`（本地排队）；某任务完成后第 5 个被 acquire 并提交。
- [ ] 单账号配置下，行为与改造前一致（无回归）。
- [ ] 账号池快照 API 返回每账号 `{id, in_flight, limit, enabled}`。
- [ ] 手动停用一个账号 → 新任务不再分配到它；在跑任务不受影响。
- [ ] DB 迁移可空列 `rh_account_id`，老数据 NULL，phase/派生正常。

## Dependencies / Notes

- 依赖 A 的 `settings.py` 改动先合（避免冲突），或与 A 协调同改。
- 拓扑选择（甲 vs 乙）、账号池热更新细节、活锁防护 → 写在本任务 `design.md`。
- 账号 key 校验（RB ping）接口归本任务，配置页 UI 归 D。
