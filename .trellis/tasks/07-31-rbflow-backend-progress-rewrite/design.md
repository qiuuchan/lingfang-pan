# Design — 子任务 A：后端进度链路重构

> 遵守父 `design.md` 第 2 节。本文档定 A 的局部决策。

## 决策

### A1. `monitor_progress` 方法保留，编排不调用
- `RunningHubClient.monitor_progress` 是独立可用的 WS 工具，保留方法本身与 `websockets` 依赖（删了反而要动 requirements、import）。
- **删除** orchestrator 里所有 WS 编排路径：`_wait_and_collect_outputs` 的 Phase B（`await client.monitor_progress(...)`）、`_obtain_wss_with_retry`、`_try_get_wss`、`created.net_wss_url` 的读取与传递。
- 验收用 grep 确认 orchestrator 内无 `monitor_progress`/`net_wss_url`/`_obtain_wss`/`_try_get_wss` 引用。

### A2. `_wait_and_collect_outputs` 简化
原三段（A 等 RUNNING → B WS → C poll）改两段：
- **等 RUNNING**：保留现有"轮询 status 直到 RUNNING/SUCCESS/FAILED"循环，间隔 `poll_interval_sec`（短，5s 量级，因其本身在主动探活）；SUCCESS 提前返回、FAILED 进 grace。**移除 `run_deadline` 的设置与使用**（run_deadline 不再存在）。
- **poll outputs**：进入 `_poll_outputs_with_grace(client, rh_id, task_id, estimator, grace_deadline)`——签名去掉 `run_deadline`。

### A3. `_poll_outputs_with_grace` 去硬超时 + 双速轮询
- **删除** `if run_deadline is not None and now > run_deadline and grace_deadline is None: ... return []` 整块。终态仅由"outputs 非空"或"grace 耗尽"决定。
- 轮询间隔：`grace_deadline` 激活时用 `poll_interval_sec`（grace 窗口短，需快探 CDN 上传），否则用 `run_poll_interval_sec`（默认 300s）。`await asyncio.sleep(runtime.run_poll_interval_sec if grace_deadline is None else runtime.poll_interval_sec)`。
- grace 进入/续期逻辑不变（SUCCESS-empty / FAILED → `grace_deadline = now + failure_grace_sec`）。

### A4. 假进度 ramp 接 `eta_baseline_sec`
- `progress.py`：`ProgressEstimator.__init__` 加 `ramp_seconds: float = 1200.0`；`tick()` 用 `self._ramp_seconds` 替代模块常量 `RUNNING_LINEAR_RAMP_SECONDS`。模块常量降为默认值来源。
- orchestrator 构造 estimator 时传 `ramp_seconds=runtime.eta_baseline_sec`。
- 语义：RUNNING 阶段从 15% 线性到 90%，铺满 `eta_baseline_sec`（默认 1200s=20min）。每次 `_poll_outputs_with_grace` 迭代调一次 `estimator.tick()`。SUCCESS→`set_phase("SUCCESS")`→100%。

### A5. settings.py
`RuntimeConfig` 新增：
- `run_poll_interval_sec: float = 300.0`
- `eta_baseline_sec: float = 1200.0`
移除 `task_timeout_sec`（pydantic v2 默认 extra='ignore'，老 yaml 残留键不报错）。保留 `poll_interval_sec`(5.0)、`failure_grace_sec`(120)、`ws_reconnect_*`（monitor_progress 方法仍在用，保留）。

## 改动文件清单
- `app/core/orchestrator.py`：`_wait_and_collect_outputs`、`_poll_outputs_with_grace`、删除 `_obtain_wss_with_retry`/`_try_get_wss`、`run_task` 里 `created.net_wss_url` 相关、estimator 构造传 ramp。
- `app/core/progress.py`：`ProgressEstimator.ramp_seconds` + `tick()` 用它。
- `app/settings.py`：`RuntimeConfig` 两增一删。

## 验证
- `python -c "from app.core import orchestrator, progress; from app.settings import runtime; print(runtime.run_poll_interval_sec, runtime.eta_baseline_sec)"`（import 无错）。
- grep 确认 orchestrator 无 `monitor_progress`/`net_wss_url`/`_obtain_wss`/`_try_get_wss`/`run_deadline`/`task_timeout_sec`。
- mock 慢任务路径（单测或脚本注入假 client）非必需，import + grep + 逻辑审查即可（无测试框架现成用例时）。
