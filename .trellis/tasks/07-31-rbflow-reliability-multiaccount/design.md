# Design — RBFLow 可靠性与多账号改造（父任务架构）

本文档定义**跨子任务共享**的技术契约与架构。各子任务在自己的 `design.md` 里细化局部设计，但必须遵守此处的状态机、轮询模型、账号池契约。

## 1. 现状速记（改动基线）

- `orchestrator.run_task(task_id)` 是单任务全生命周期协程：UPLOAD → CREATE → WAIT(RUN) → DOWNLOAD → SUCCESS。由 `queue.TaskQueue._run_worker` 从本地 `asyncio.PriorityQueue` 取出后调用。
- 等待阶段（`_wait_and_collect_outputs`）：先 WS 实时进度（`monitor_progress`），WS 断后切 `_poll_outputs_with_grace` 轮询；有 `create_deadline`(60s)+`run_deadline`(`task_timeout_sec`=900s)+`grace_deadline`(`failure_grace_sec`=120s) 三套时限。
- 单 RB key：`RunningHubClient(api_key=settings.runninghub_api_key)`；`settings.runninghub_api_key` 必填。
- 本地队列：`QueueManager` 持 `dict[name, TaskQueue]`，默认 `default` 队列，并发可配（持久化在 `data/queue_state.json`）。421 由 `_create_task_with_421_retry` 退避重试（最长 `rh_create_421_max_wait_sec`=600s）。
- 插件：`SubmitWorker` 调 `bridge_submit_video`（读超时 120s）→ 成功得 `task_id`；`ProgressWorker`/`_PollWorker` 轮询桥 `/video/stream`（短超时 3s，sleep 3s）。

## 2. 新轮询 / 假进度模型（R1/R2/R3）

### 2.1 时限模型简化
移除 `run_deadline`（硬超时）的"到点 return []"。保留：
- `create_deadline`：QUEUED→RUNNING 的等待（可延展，纯日志，不放弃）。
- `grace_deadline`：观察到 FAILED 或 SUCCESS-empty 后，等 CDN 上传的宽限窗口（可配，默认保留 120s 量级；**不再被 run_deadline 截断**）。
- 终止条件**仅**：RB `query_outputs` 返回非空（成功），或 `query_status` 长期 FAILED 且 grace 耗尽（真失败）。

### 2.2 轮询节奏
- 新增 `runtime.run_poll_interval_sec`（默认 **300**），取代 `poll_interval_sec` 在 RUNNING 阶段的使用（UPLOAD/CREATE 阶段可用更短间隔，因其本身持续主动调用 RB）。
- 旧 `poll_interval_sec`(5s) 仅保留给"等 RUNNING"快速探测阶段，或整体上调；在 `settings.py` 的 `RuntimeConfig` 里拆清语义。

### 2.3 假进度
- 复用 `ProgressEstimator`（已有 phase 权重 + 线性 ramp + `tracker`）。WS 移除后 `tracker.apply` 不再被调用，estimator 退化为纯 phase + 时间线性推进。
- 每次轮询回锚：`status=RUNNING` 时按"已运行时间 / 经验均值"推进（封顶 95%）；`SUCCESS` 拉到 100%；FAILED 停在当前值。
- 经验均值可配（`runtime.eta_baseline_sec`，默认如 1200s），用于假进度斜率；斜率必须保证 5 分钟间隔内肉眼可见前进。

### 2.4 删除 WS
- `orchestrator._wait_and_collect_outputs`：去掉 Phase B（`monitor_progress` + `_obtain_wss_with_retry` + `_try_get_wss`）。`_wait_and_collect_outputs` 简化为"等 RUNNING → 进入 _poll_outputs_with_grace 直到终态"。
- `runninghub.RunningHubClient.monitor_progress` 方法**保留**（独立可用工具），但编排路径不再调用；或在 A 子任务内一并删除，A 的 design 决定。
- 前端 `ProgressMonitor.tsx` + 路由/导航删除（子任务 D）。
- 插件 `ProgressWorker` 删除，统一用定时拉取（子任务 E）。

## 3. 多 RB 账号池（R4）

### 3.1 数据结构
新增 `AccountPool`（`app/core/accounts.py` 新文件，或并入 `queue.py`）：
```
@dataclass
class RhAccount:
    id: str            # 稳定标识（如 "acc1"），用于任务记录归属
    api_key: str
    concurrency_limit: int = 3
    enabled: bool = True
    # 运行态（进程内）
    in_flight: int = 0
```
来源：`config.yaml` 的 `runninghub.accounts: [{id, api_key, concurrency_limit, enabled}]`（向后兼容：若无则从 `settings.runninghub_api_key` 造 1 个默认账号）。运行时改动持久化到 `data/accounts_state.json`（启用/限流覆盖）。

### 3.2 分配策略
`AccountPool.acquire() -> RhAccount | None`：在 `enabled and in_flight < concurrency_limit` 的账号里选 `in_flight` 最小者，`in_flight += 1`，返回；全满返回 `None`。`release(acc)` 时 `in_flight -= 1` 并唤醒等待者。

### 3.3 与本地队列/worker 的关系（关键）
两种可行拓扑，**子任务 B 的 design 选其一**：

- **拓扑甲（账号感知 worker）**：每个账号一个 `TaskQueue`，并发 = `concurrency_limit`；新任务入"最闲账号队列"。简单，但账号池变更要重建队列。
- **拓扑乙（单全局队列 + acquire 门）**：保留单 `default` 队列；worker 从队列取任务后先 `AccountPool.acquire()`，拿不到账号则把任务塞回队列顶端并 sleep，等 `release` 唤醒。账号池热更简单，但"塞回+唤醒"需小心活锁。

推荐**拓扑乙**（与现有 `QueueManager` 单队列结构最接近，且配置页热改账号池不必重建队列）。worker 改动集中在 `_run_worker`：取任务 → acquire 账号（阻塞等待）→ `run_task(task_id, account)` → finally release。

### 3.4 任务记录账号归属
`Task` 表新增 `rh_account_id`（NULL=本地排队中未分配）。`create_task` 用 `account.api_key` 建 `RunningHubClient`，提交后写 `rh_account_id`。这是"本地排队 vs 已提交"的权威依据（R6）。

### 3.5 421 兜底
本地并发门已限流，正常不触发 421；但保留 `_create_task_with_421_retry` 作为"账号被外部占用"兜底（如有人手动在 RB 后台跑了任务）。421 退避耗尽 → 释放账号槽位 + 任务回队列重试。

## 4. 阶段语义 / 状态机（R6）

定义 `phase` 派生字段（不必入库，由 `state` 派生）供 UI：

| phase | 触发 state | 含义 |
|-------|-----------|------|
| `queued` | PENDING（且未分配账号）/ QUEUED | 本地或 RB 排队中 |
| `uploading` | UPLOADING | 正在上传素材到 RB |
| `running` | RUNNING | RB 工作流执行中 |
| `done` | SUCCESS | 完成 |
| `failed` | FAILED / *_PENDING | 失败/待处理 |

`/tasks` 序列化补 `phase`、`rh_account_id`、`rh_task_id`、`duration_sec`、`retry_count`、`error_code`（R8）。

"本地排队 vs 已提交"区分：`state=PENDING and rh_account_id is None` → 本地排队；`rh_account_id is not None` → 已提交 RB。

## 5. 提交即入队契约（R5，跨库）

### 5.1 当前疑点（待 C 的 research 确认）
怀疑链路：插件 `bridge_submit_video`(120s) → 桥 `/video/generate` → RBFLow `/tasks`（或 `/video/generate`）。若 RBFLow 该接口**同步执行 create+421重试**才返回，则桥/插件会等到超时；后端却继续。需在 research 阶段读 `app/api/tasks.py` 与桥 `plugin_llm_bridge.rs` 确认是否同步阻塞。

### 5.2 目标契约
- RBFLow 提交接口：**写库（state=PENDING）→ 入本地队列 → 立即返回 task_id**，绝不阻塞到 RB create。
- 桥 `/video/generate`：先扣灵石，再转发该快速接口；转发不阻塞。
- 插件：提交调用返回 task_id 即视为"已入队"；后续状态一律走定时拉取（5 分钟）。提交层超时 ≠ 任务失败；插件重进按 task_id 拉真实阶段。

## 6. 跨库改动清单

| 库 | 路径 | 改动 | 子任务 |
|----|------|------|--------|
| RBFLow | `app/core/orchestrator.py` | 去硬超时、删 WS、5min 轮询、假进度 | A |
| RBFLow | `app/core/runninghub.py` | client 支持 per-account api_key | A/B |
| RBFLow | `app/settings.py` | RuntimeConfig 新字段、AccountPool 配置 | A/B |
| RBFLow | `app/core/queue.py` 或新 `accounts.py` | AccountPool + worker acquire/release | B |
| RBFLow | `app/api/tasks.py` + 配置/统计 API | 快速入队、phase 字段、配置读写、统计 | C/D |
| RBFLow | `frontend/src/components/pages/*` | 配置页、阶段化任务管理、仪表盘增强；删 ProgressMonitor | D |
| lingfang | `apps/desktop/.../plugin_llm_bridge.rs` | 非阻塞转发、状态拉取接口 | C |
| lingfang | `plugins/rbflow-video/main.py` | 假进度、5min 拉取、任务id、本地/已提交区分、删 ProgressWorker | E |

## 7. 回滚 / 兼容

- `task_timeout_sec` 移除后，老 `config.yaml` 里若有该键，`RuntimeConfig` 用 `extra="ignore"` 兜底（已是 pydantic BaseModel，确认）。
- 多账号：N=1（仅 `runninghub_api_key`）是默认特例，单账号部署行为不变。
- DB：`rh_account_id` 新列可空，老数据 NULL = "未知/单账号"，phase 派生仍正常。
- 插件 `tasks.json`：新字段走 `Task` dataclass 默认值（已有 known-field 过滤）。

## 8. 开放问题（留给子任务 design）

- 假进度斜率与封顶策略的具体数值（A）。
- 账号池热更新时在跑任务的归属处理（B）。
- 桥侧 `/video/stream` 是保留改短超时，还是换成新 `/video/status` 轻量接口（C，取决于 research）。
- 仪表盘统计是实时聚合还是定时快照（D）。
