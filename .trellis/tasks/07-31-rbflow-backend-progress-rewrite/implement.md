# Implement — 子任务 A：后端进度链路重构

> 仓库 `P:\RBFLow`。按序执行，每步后自检。

## 步骤

1. **settings.py** — `RuntimeConfig`：加 `run_poll_interval_sec: float = 300.0`、`eta_baseline_sec: float = 1200.0`；删 `task_timeout_sec: int = 900` 行。自检：`extra='ignore'` 兜底老 yaml（pydantic v2 默认）。

2. **progress.py** — `ProgressEstimator`：
   - `__init__` 加 `ramp_seconds: float = 1200.0`，存 `self._ramp_seconds`。
   - `tick()`：`frac = min(1.0, elapsed / self._ramp_seconds)`（替换 `RUNNING_LINEAR_RAMP_SECONDS`）。
   - 保留模块常量作默认参考（或删，二选一；保留更稳）。

3. **orchestrator.py**：
   - `run_task`：构造 `ProgressEstimator(ramp_seconds=runtime.eta_baseline_sec, tracker=ProgressTracker())`。
   - `_wait_and_collect_outputs`：
     - 删除 `wss_url`/`net_wss_url` 相关（`created.net_wss_url`、`_obtain_wss_with_retry` 调用、Phase B `monitor_progress`、`wss_url = ...`）。
     - 删除 `run_deadline` 变量；"等 RUNNING"循环里删 `run_deadline = now + runtime.task_timeout_sec`。
     - 末尾 `return await _poll_outputs_with_grace(client, rh_id, task_id, estimator, grace_deadline)`（去掉 `run_deadline` 实参）。
   - `_poll_outputs_with_grace`：
     - 签名去 `run_deadline`。
     - 删除 `if run_deadline is not None and now > run_deadline and grace_deadline is None:` 整块（含其 SUCCESS 续 grace 子分支——该续 grace 由现有 SUCCESS-empty 逻辑覆盖，复核不丢）。
     - `await asyncio.sleep(...)` 改 `runtime.run_poll_interval_sec if grace_deadline is None else runtime.poll_interval_sec`。
   - 删除 `_obtain_wss_with_retry`、`_try_get_wss` 两个函数整体。
   - 复核：`_create_task_with_421_retry` 不动；`retry_task`/`redownload_task` 不动。

4. **自检**：
   - `cd /p/RBFLow && python -c "from app.core import orchestrator, progress; from app.settings import runtime, RuntimeConfig; print('poll', runtime.run_poll_interval_sec, 'eta', runtime.eta_baseline_sec)"`。
   - `grep -nE "monitor_progress|net_wss_url|_obtain_wss|_try_get_wss|run_deadline|task_timeout_sec" app/core/orchestrator.py`（应无输出）。
   - 逻辑审查：终态条件仅 outputs 非空 / grace 耗尽；grace 仍由 SUCCESS-empty 与 FAILED 触发。

5. **commit**（在 `P:\RBFLow` 仓库，新分支 `feat/progress-no-timeout-no-ws`）。

## 回滚点
- 步骤 3 改动较大，单独 commit；若 import 报错先回查 settings/progress 小改。
