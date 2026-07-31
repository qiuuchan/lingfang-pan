# Design — 子任务 E：插件改造

> 遵守父 `design.md` 第 4、5 节。C 的 bridge 已透传 `rh_account_id`，插件消费。

## 决策

### E1. 删 ProgressWorker，统一用 _PollWorker
- 删 `ProgressWorker` 类、`_progress_workers`、`_start_progress`、`_resume_progress`、closeEvent/_on_delete_task/_apply_submit_result 中的 ProgressWorker 引用。
- `_PollWorker`（批量一次性轮询）成为唯一进度来源，由定时器按 E2 节奏触发。

### E2. 双定时器解耦（重试 vs 轮询）
- `_refresh_timer` 保持 5s tick：每 tick 跑 `_process_due_retries`（自动重试响应不变）。
- 轮询节流：新增 `_last_poll_ts`，仅当 `now - _last_poll_ts >= refresh_interval_sec` 才 `_poll_non_terminal_tasks`。`refresh_interval_sec` 默认 **300**，QueuePanel 新增 `spin_refresh_interval`（30–3600s）可配，持久化到 QSettings。

### E3. 假进度（客户端插值）
- 新增 `_ui_timer`（2s tick）：对 `STATE_RUNNING/STATE_DOWNLOADING` 任务，按客户端斜率把**显示进度**向 99% 缓慢推进（不写 store，仅刷新卡片）；拉取到后端真实值时以真实值为锚（取 max，单调）。
- `_on_progress_update` 收到后端 progress → 写 store（权威锚）；UI tick 在锚之上插值。
- 实现：TaskCardWidget 直接读 `task.progress`；UI tick 临时给卡片一个"显示进度"覆盖值。简化做法：UI tick 直接给 `task.progress` 加小增量并 `update_task_card`（但不持久化每 tick——每 ~10 tick 存一次）。权衡后用：UI tick 增量改 `task.progress` + 刷卡片，每 30s 存一次盘。

### E4. 任务 ID 显示 + 复制
- `TaskCardWidget._meta_text` 末尾加 `· #<短id>`（rbflow_task_id 前 8 位）；tooltip 给完整 id。
- 任务列表右键菜单加「复制任务 ID」（有 rbflow_task_id 才显示），用 QApplication.clipboard。

### E5. 本地排队 vs 已提交（badge）
- StatusBadge 新增 `STATE_LOCAL_QUEUE`("本地排队") 概念：`task.rbflow_task_id` 为空，或轮询返回 `rh_account_id` 空 → 本地排队；`rh_account_id` 非空 → 已提交（按 state 显示 排队/运行/完成）。
- `_PollWorker` 解析 progress 事件里的 `rh_account_id`，经新信号 `_account_update(pair_id, rh_account_id)` 回传，存到 `task` 新字段 `rh_account_id`（dataclass 加字段，tasks.json 兼容）。badge/meta 据此显示。

### E6. 提交超时 ≠ 失败（C 兑现）
- `bridge_submit_video`/`bridge_submit_audio` 读超时 120 → **600**。
- `SubmitWorker`/`VoiceSubmitWorker`：捕获 requests 超时/连接异常 → 发新信号 `submit_unconfirmed(pair_id, msg)`，**不**标 FAILED、不 `pair_failed`；MainWindow 显示"提交未确认，任务可能已在后台运行，请稍后刷新"状态栏提示。仅 BridgeError（计费/参数）才 pair_failed。

## 改动文件
- `plugins/rbflow-video/main.py`（唯一文件）

## 验证
- `python -m py_compile plugins/rbflow-video/main.py`。
- grep 无 `ProgressWorker` 残留。
- 逻辑审查：5s 重试 tick + 300s 轮询节流；UI 假进度单调；提交超时不标 FAILED。
