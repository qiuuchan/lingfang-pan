# Implement — 子任务 B：多 RB 账号池

> 仓库 `P:\RBFLow`，分支 `feat/rbflow-reliability-multiaccount`（续 A）。

## 步骤
1. `app/settings.py`：`runninghub_api_key` 改 `Field("", alias=...)`；`RuntimeConfig` 加 `runninghub_accounts: list = Field(default_factory=list)`。
2. 新 `app/core/accounts.py`：`RhAccount` + `AccountPool`（Condition）+ `load_accounts()`（state→yaml→legacy）+ state 文件读写。
3. `app/core/queue.py`：`QueueManager.__init__` 建 pool、设默认队列并发=total_capacity；`_run_worker` 加 acquire/release；`reload_accounts()`。
4. `app/core/orchestrator.py`：`run_task(task_id, account=None)` 用 account.api_key + 写 rh_account_id；`redownload_task` 按 rh_account_id 选 key（兜底 any_enabled/settings）。
5. `app/models/task.py`：加 `rh_account_id` 列 + `to_dict`。
6. `app/models/db.py`：`_ensure_columns` 加 `"rh_account_id": "VARCHAR(32)"`。
7. 新 `app/api/accounts.py`：GET/PUT/test 三个端点。
8. `app/main.py`：挂 accounts router；启动 ping 改用 pool 首个 enabled 账号（无账号则跳过）。
9. `config.yaml`：加 `runninghub_accounts` 注释示例。
10. 自检：import、单账号池快照、grep 无 `task_timeout_sec` 回归、PUT/GET 逻辑审查。

## 回滚点
步骤 3（queue worker 改动）最敏感——单独 commit；import 报错先查 accounts.py/queue.py。
