# Design — 子任务 B：多 RB 账号池 + 每账号并发门

> 遵守父 `design.md` 第 3 节。采用**拓扑乙**（单全局队列 + AccountPool acquire/release 门）。

## 数据与配置

### `RhAccount` / `AccountPool`（新文件 `app/core/accounts.py`）
```python
@dataclass
class RhAccount:
    id: str; api_key: str
    concurrency_limit: int = 3
    enabled: bool = True
    in_flight: int = 0          # 进程内运行态，不持久化

class AccountPool:
    async def acquire() -> RhAccount      # 阻塞直到有可用账号，选 in_flight 最小者，+1
    async def release(acc)                 # in_flight-1，notify
    async def reload(list[RhAccount])      # 热更新，保留在跑任务的 in_flight
    def snapshot() -> list[dict]           # 不含 api_key（给 UI）
    def get(id) -> RhAccount|None
    def any_enabled() -> RhAccount|None
    @property total_capacity -> int        # sum(enabled limits)
```
并发原语：`asyncio.Condition`（acquire/release 都在 `async with cond` 内；acquire 无可用则 `await cond.wait()`，release `notify(1)`，reload `notify_all()`）。

### 配置来源（优先级）
1. `data/accounts_state.json`（管理后台写，运行时覆盖）：`{"accounts":[{id,api_key,concurrency_limit,enabled}]}`（api_key 明文，服务端文件，同 .env 语义）
2. `config.yaml` 的 `runninghub_accounts: [{id,api_key,concurrency_limit,enabled}]`（bootstrap 默认）
3. legacy `RUNNINGHUB_API_KEY`（单账号 N=1，id="default"）

`settings.runninghub_api_key` 改为**可选**（默认 ""），避免无 key 的多账号部署启动失败。

## 队列集成（拓扑乙）

`QueueManager.__init__`：建 `self.pool = AccountPool(load_accounts())`；默认队列并发 = `max(1, pool.total_capacity)`。
`TaskQueue._run_worker`：取任务（含既有 pause 检查）→ `account = await pool.acquire()` → `await orchestrator.run_task(task_id, account)` → `finally: await pool.release(account)`。
热更新：`QueueManager.reload_accounts()` → `await pool.reload(...)` + `default_queue.set_concurrency(max(1,pool.total_capacity))`。

cancel 语义：worker 在 acquire 中被 cancel → 未拿到槽位，无需 release；在 run_task 中 cancel → finally release。安全。

## orchestrator / runninghub

- `run_task(task_id, account: RhAccount|None = None)`：`RunningHubClient(api_key=account.api_key if account else None)`；create 后 `db_repo.update_task(task_id, rh_account_id=account.id)`。
- `redownload_task`：用任务记录的 `rh_account_id` 对应 key；账号不存在/禁用 → `any_enabled()` 兜底 → 再退 `settings.runninghub_api_key`。
- `_create_task_with_421_retry` 不变（421 兜底；耗尽 → TaskFailed，worker finally 释放槽位，用户可 retry）。

## Task 模型

`Task.rh_account_id: Mapped[str|None] = mapped_column(String(32), nullable=True, index=True)`；`to_dict()` 加该字段；`init_db._ensure_columns` 加 `"rh_account_id": "VARCHAR(32)"`。NULL = 本地排队未分配（R6 区分依据）。

## API（B 定义，D 消费）

新 router `app/api/accounts.py`（挂在 `/api/v1/accounts`，需 require_user）：
- `GET /accounts` → `{accounts: pool.snapshot(), total_capacity}`（api_key 不返回）
- `PUT /accounts` body `{accounts:[{id,api_key,concurrency_limit,enabled}]}` → 写 state 文件 + `reload_accounts()`；api_key 空串=保持原值。返回 snapshot。
- `POST /accounts/test` body `{api_key}` → `RunningHubClient(api_key).ping()` → `{ok, detail}`（key 校验，给 UI 校验按钮）

## 改动文件清单
- 新 `app/core/accounts.py`
- `app/core/queue.py`（QueueManager.pool + worker acquire/release + reload）
- `app/core/orchestrator.py`（run_task account 参数 + rh_account_id 写入；redownload 取账号 key）
- `app/integrations/runninghub.py`（无改动，client 已支持 api_key 参数）
- `app/settings.py`（runninghub_api_key 可选 + RuntimeConfig.runninghub_accounts）
- `app/models/task.py`（rh_account_id 列 + to_dict）
- `app/models/db.py`（迁移）
- 新 `app/api/accounts.py` + `app/main.py`（挂载）
- `config.yaml`（注释示例 runninghub_accounts）

## 验证
- import + 启动：单账号（仅 RUNNINGHUB_API_KEY）→ pool 1 账号、队列并发 3、ping OK。
- `GET /accounts` 不含 api_key；`PUT /accounts` 改并发 → 队列并发变化；`POST /accounts/test` 回 ok/detail。
- 逻辑审查：acquire 选最小 in_flight；全满阻塞；release 唤醒；reload 保留 in_flight。
