# Implement — 子任务 E：插件改造

> `plugins/rbflow-video/main.py`。分支 lingfang `feat/rbflow-reliability-multiaccount`（与 C 桥改动同库同分支）。

## 步骤
1. Task dataclass：加 `rh_account_id: str = ""`。
2. bridge_submit_video/audio：timeout 读超时 120→600。
3. SubmitWorker/VoiceSubmitWorker：加 `submit_unconfirmed` 信号；requests 超时/连接错发它（不 pair_failed）。
4. 删 ProgressWorker 类 + MainWindow 里 `_progress_workers`/`_start_progress`/`_resume_progress` 及 closeEvent/_on_delete_task/_apply_submit_result 引用。
5. _PollWorker：progress 事件解析 `rh_account_id`，加信号 `account_update(pair_id, rh_account_id)`。
6. QueuePanel：加 `spin_refresh_interval`（30–3600，默认 300）+ 存 QSettings；右键菜单「复制任务 ID」。
7. MainWindow：`_refresh_timer` 5s tick 跑 `_process_due_retries`；`_last_poll_ts` 节流 300s 轮询；加 `_ui_timer` 2s 假进度；连 `submit_unconfirmed` → 状态栏提示（不标失败）；连 `account_update` → 存 task.rh_account_id。
8. TaskCardWidget：meta 加短 id + tooltip 完整 id；badge 区分本地排队（无 task_id 或无 rh_account_id）。
9. 自检：py_compile + grep 无 ProgressWorker + 逻辑审查。

## 回滚点
步骤 4（删 ProgressWorker）改动大，单独 commit；import/编译报错先查 MainWindow 信号连接。
