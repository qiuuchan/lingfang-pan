//! Executor：60s tick + 串行执行分发。
//!
//! 流程：
//! 1. `spawn_tick_loop`：每 60 秒 tick 一次。对每个 ACTIVE 任务算 next_run_at，
//!    若 due（now 与 next 差 <= tick 间隔）则入队 due_queue；刷新 next_run_at。
//! 2. `spawn_executor_loop`：循环 try_claim_next。拿到任务则按 payload 分发：
//!    - AGENT_PROMPT → emit `scheduler:trigger`，前端跑完调 record_run 命令回写。
//!      executor 在 oneshot channel 上等待，30 分钟硬超时。
//!    - PLUGIN_ACTION → emit `scheduler:plugin-action`，由桌面 Action runtime 执行并回写。
//!    - NOTIFY       → emit `scheduler:notify` 给前端（前端走 NotificationCenter + 系统通知）。
//!
//! 事件（emit）：
//! - `scheduler:trigger` { task_id, run_id, started_at } → 前端启动隐藏 Agent session。
//! - `scheduler:plugin-action` { task_id, run_id, started_at, plugin_id, action, input } → 前端调用插件 Action。
//! - `scheduler:cancel`  { run_id }                      → 前端取消正在跑的 session（超时时）。
//! - `scheduler:run_finished` { task, run }              → 前端更新 UI / 红点徽章。
//! - `scheduler:notify` { title, body }                  → 前端走应用内通知中心 + 系统通知（尊重勿扰时段）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use tokio::time::{interval, timeout};
use uuid::Uuid;

use super::cron::next_run_after;
use super::state::SchedulerState;
use super::types::{
    LocalSchedule, LocalScheduleRun, LocalScheduleRunRecordInput, LocalScheduleRunRecordStatus,
    LocalScheduleRunStatus, LocalScheduleStatus, LocalScheduleTrigger, LocalTaskPayload,
};

/// tick 间隔（60s）。cron 最小粒度本就是分钟。
const TICK_INTERVAL_SECS: u64 = 60;
/// 默认硬超时（30 分钟），任务自带 timeout_ms 时用任务值。
const DEFAULT_TIMEOUT_SECS: u64 = 1_800;

/// Pending run 等待表：run_id → oneshot Sender。
/// record_run 命令收到前端结果时，从表里取出发送，executor 端被唤醒。
/// 用 Mutex 包 HashMap（执行频次低，竞争极小）。
#[derive(Default)]
pub(crate) struct PendingRuns {
    inner: Mutex<HashMap<String, oneshot::Sender<LocalScheduleRunRecordInput>>>,
}

impl PendingRuns {
    pub(crate) fn insert(&self, run_id: &str, tx: oneshot::Sender<LocalScheduleRunRecordInput>) {
        let mut m = self.inner.lock().expect("pending runs lock poisoned");
        m.insert(run_id.to_string(), tx);
    }

    pub(crate) fn deliver(
        &self,
        run_id: &str,
        record: LocalScheduleRunRecordInput,
    ) -> Result<(), String> {
        let mut m = self.inner.lock().expect("pending runs lock poisoned");
        match m.remove(run_id) {
            Some(tx) => {
                // send 失败说明 executor 端已超时退出；忽略。
                let _ = tx.send(record);
                Ok(())
            }
            None => Err(format!("run_id「{run_id}」不在等待表中（可能已超时）")),
        }
    }

    /// executor 超时退出时清理（避免悬挂 sender）。
    pub(crate) fn cancel(&self, run_id: &str) {
        let mut m = self.inner.lock().expect("pending runs lock poisoned");
        m.remove(run_id);
    }
}

/// 启动 tick + executor 两个异步任务。应在 setup 阶段调用一次。
///
/// 关键：必须用 `tauri::async_runtime::spawn` 而非裸 `tokio::spawn`。
/// Tauri 2 的 setup 闭包是同步的，且自有独立 runtime（async_runtime）；
/// 裸 tokio::spawn 在 setup 同步上下文里会 panic「there is no reactor running」。
pub(crate) fn spawn(app: AppHandle) {
    {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            tick_loop(app_clone).await;
        });
    }
    {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            executor_loop(app_clone).await;
        });
    }
}

/// 60s tick：扫所有 ACTIVE 任务，due 的入队，刷新 next_run_at。
async fn tick_loop(app: AppHandle) {
    let mut tick = interval(Duration::from_secs(TICK_INTERVAL_SECS));
    // 首次立即触发一次（启动后立即把 next_run_at 校准到下一个未来时间）。
    tick.tick().await;
    loop {
        tick.tick().await;
        if let Err(e) = run_tick(&app) {
            eprintln!("[scheduler] tick 失败：{e}");
        }
    }
}

fn run_tick(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<SchedulerState>();
    let now = Utc::now();
    let tasks = state.snapshot_tasks();
    for mut task in tasks {
        if task.status != LocalScheduleStatus::Active {
            continue;
        }
        match next_run_after(&task.trigger, now) {
            Ok(Some(next)) => {
                // due 判定：next 与 now 的差距 <= 1.5 个 tick（容忍 90s 抖动）。
                let delta = (next - now).num_seconds().abs();
                let due = delta <= (TICK_INTERVAL_SECS as i64 * 3 / 2);
                if due {
                    state.enqueue(&task.id);
                }
                let next_iso = next.to_rfc3339();
                if task.next_run_at.as_deref() != Some(next_iso.as_str()) {
                    task.next_run_at = Some(next_iso);
                    let _ = state.upsert_task(task);
                }
            }
            Ok(None) => {
                // ONCE 已过期 → 标 COMPLETED。
                if matches!(task.trigger, LocalScheduleTrigger::Once { .. }) {
                    task.status = LocalScheduleStatus::Completed;
                    task.next_run_at = None;
                    let _ = state.upsert_task(task);
                }
            }
            Err(e) => {
                eprintln!("[scheduler] 任务 {} 算 next_run_at 失败：{}", task.id, e);
            }
        }
    }
    Ok(())
}

/// executor 循环：持续 try_claim_next，拿到就分发。
async fn executor_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let state = app.state::<SchedulerState>();

        // PRD Q5.3 (a)：若当前有任务在跑，把队列里堆积的待执行任务全部清空并记 SKIPPED。
        // 避免长任务跑完后续被堆积的旧任务轮番触发（可能过时无意义）。
        let skipped = state.drain_skipped();
        for task_id in skipped {
            record_skipped(&app, &task_id, "previous run still active");
        }

        let Some(task) = state.try_claim_next() else {
            continue;
        };
        if let Err(e) = run_one_task(&app, task).await {
            eprintln!("[scheduler] 执行任务失败：{e}");
            app.state::<SchedulerState>().mark_done();
        }
    }
}

/// 记录 SKIPPED run（不进入 running 槽位，直接写 runs.jsonl + emit run_finished + 推通知）。
fn record_skipped(app: &AppHandle, task_id: &str, reason: &str) {
    let state = app.state::<SchedulerState>();
    let Some(task) = state.get_task(task_id) else {
        return;
    };
    let now = Utc::now();
    let run = LocalScheduleRun {
        id: Uuid::new_v4().to_string(),
        task_id: task_id.to_string(),
        started_at: now.to_rfc3339(),
        finished_at: Some(now.to_rfc3339()),
        status: LocalScheduleRunStatus::Skipped,
        skip_reason: Some(reason.to_string()),
        error: None,
        output_summary: None,
        duration_ms: Some(0),
    };
    finalize_run(app, &task, run);
}

/// 执行单个任务（含硬超时）。返回时已 mark_done + finalize_run。
async fn run_one_task(app: &AppHandle, task: LocalSchedule) -> Result<(), String> {
    let run_id = Uuid::new_v4().to_string();
    let started_at = Utc::now().to_rfc3339();
    let timeout_secs = if task.timeout_ms > 0 {
        (task.timeout_ms / 1000).max(1)
    } else {
        DEFAULT_TIMEOUT_SECS
    };

    // NOTIFY 类型：直接发通知 + 记 SUCCESS，不走前端。
    if let LocalTaskPayload::Notify { title, body } = &task.payload {
        let finished_at = Utc::now().to_rfc3339();
        let duration_ms = parse_iso_delta(&finished_at, &started_at).unwrap_or(0);
        let summary = if body.is_empty() {
            title.clone()
        } else {
            format!("{title}｜{body}")
        };
        let run = LocalScheduleRun {
            id: run_id.clone(),
            task_id: task.id.clone(),
            started_at,
            finished_at: Some(finished_at),
            status: LocalScheduleRunStatus::Success,
            skip_reason: None,
            error: None,
            output_summary: Some(summary),
            duration_ms: Some(duration_ms),
        };
        finalize_run(app, &task, run);
        return Ok(());
    }

    // PLUGIN_ACTION：交给桌面 Action runtime 执行，复用安装校验、权限和 invocation 语义。
    if let LocalTaskPayload::PluginAction {
        plugin_id,
        action,
        ..
    } = &task.payload
    {
        let (tx, rx) = oneshot::channel::<LocalScheduleRunRecordInput>();
        app.state::<PendingRuns>().insert(&run_id, tx);
        let _ = app.emit(
            "scheduler:plugin-action",
            serde_json::json!({
                "task_id": task.id,
                "run_id": run_id,
                "started_at": started_at,
                "type": task.payload.type_tag(),
                "plugin_id": plugin_id,
                "action": action,
                "input": task.payload,
            }),
        );
        let result = timeout(Duration::from_secs(timeout_secs), rx).await;
        let pending = app.state::<PendingRuns>();
        let finished_at = Utc::now().to_rfc3339();
        let duration_ms = parse_iso_delta(&finished_at, &started_at).unwrap_or(0);
        let run = match result {
            Ok(Ok(record)) => LocalScheduleRun {
                id: run_id.clone(), task_id: task.id.clone(), started_at,
                finished_at: Some(finished_at),
                status: match record.status { LocalScheduleRunRecordStatus::Success => LocalScheduleRunStatus::Success, LocalScheduleRunRecordStatus::Failed => LocalScheduleRunStatus::Failed },
                skip_reason: None, error: record.error, output_summary: record.output_summary, duration_ms: Some(duration_ms),
            },
            Ok(Err(_)) => {
                pending.cancel(&run_id);
                LocalScheduleRun { id: run_id.clone(), task_id: task.id.clone(), started_at, finished_at: Some(finished_at), status: LocalScheduleRunStatus::Failed, skip_reason: None, error: Some("执行通道关闭".to_string()), output_summary: None, duration_ms: Some(duration_ms) }
            }
            Err(_) => {
                pending.cancel(&run_id);
                let _ = app.emit("scheduler:cancel", serde_json::json!({ "run_id": run_id }));
                LocalScheduleRun { id: run_id.clone(), task_id: task.id.clone(), started_at, finished_at: Some(finished_at), status: LocalScheduleRunStatus::Timeout, skip_reason: None, error: Some(format!("执行超时（{} 秒）", timeout_secs)), output_summary: None, duration_ms: Some(duration_ms) }
            }
        };
        finalize_run(app, &task, run);
        return Ok(());
    }

    // AGENT_PROMPT：emit 给前端常驻组件跑，通过 oneshot 等回写。
    let (tx, rx) = oneshot::channel::<LocalScheduleRunRecordInput>();
    app.state::<PendingRuns>().insert(&run_id, tx);
    let _ = app.emit(
        "scheduler:trigger",
        serde_json::json!({
            "task_id": task.id,
            "run_id": run_id,
            "started_at": started_at,
            "type": task.payload.type_tag(),
        }),
    );

    let result = timeout(Duration::from_secs(timeout_secs), rx).await;
    let pending = app.state::<PendingRuns>();
    let finished_at = Utc::now().to_rfc3339();
    let duration_ms = parse_iso_delta(&finished_at, &started_at).unwrap_or(0);

    let run = match result {
        Ok(Ok(record)) => {
            // 前端正常回写。校验 task_id 防串台；优先用前端回传的真实执行起止时间（含 agent
            // 思考/执行时长），缺失或非法时兜底 executor 自计时。
            if record.task_id != task.id {
                pending.cancel(&run_id);
                LocalScheduleRun {
                    id: run_id.clone(),
                    task_id: task.id.clone(),
                    started_at: started_at.clone(),
                    finished_at: Some(finished_at.clone()),
                    status: LocalScheduleRunStatus::Failed,
                    skip_reason: None,
                    error: Some("回写记录 task_id 与任务不匹配，记录已丢弃".to_string()),
                    output_summary: None,
                    duration_ms: Some(duration_ms),
                }
            } else {
                let record_started = record.started_at.trim();
                let record_finished = record.finished_at.trim();
                let (actual_started, actual_finished, actual_duration) =
                    if !record_started.is_empty() && !record_finished.is_empty() {
                        let d =
                            parse_iso_delta(record_finished, record_started).unwrap_or(duration_ms);
                        (
                            record.started_at.clone(),
                            Some(record.finished_at.clone()),
                            d,
                        )
                    } else {
                        (started_at.clone(), Some(finished_at.clone()), duration_ms)
                    };
                LocalScheduleRun {
                    id: run_id.clone(),
                    task_id: task.id.clone(),
                    started_at: actual_started,
                    finished_at: actual_finished,
                    status: match record.status {
                        LocalScheduleRunRecordStatus::Success => LocalScheduleRunStatus::Success,
                        LocalScheduleRunRecordStatus::Failed => LocalScheduleRunStatus::Failed,
                    },
                    skip_reason: None,
                    error: record.error,
                    output_summary: record.output_summary,
                    duration_ms: Some(actual_duration),
                }
            }
        }
        Ok(Err(_)) => {
            // sender 被 drop（不应发生，记录 FAILED）。
            pending.cancel(&run_id);
            LocalScheduleRun {
                id: run_id.clone(),
                task_id: task.id.clone(),
                started_at,
                finished_at: Some(finished_at),
                status: LocalScheduleRunStatus::Failed,
                skip_reason: None,
                error: Some("执行通道关闭".to_string()),
                output_summary: None,
                duration_ms: Some(duration_ms),
            }
        }
        Err(_) => {
            // 超时：清理 pending + 通知前端取消 session。
            pending.cancel(&run_id);
            let _ = app.emit("scheduler:cancel", serde_json::json!({ "run_id": run_id }));
            LocalScheduleRun {
                id: run_id.clone(),
                task_id: task.id.clone(),
                started_at,
                finished_at: Some(finished_at),
                status: LocalScheduleRunStatus::Timeout,
                skip_reason: None,
                error: Some(format!("执行超时（{} 秒）", timeout_secs)),
                output_summary: None,
                duration_ms: Some(duration_ms),
            }
        }
    };
    finalize_run(app, &task, run);
    Ok(())
}

/// 把 run 写盘 + emit run_finished + 推通知 + 释放 running 槽位。
fn finalize_run(app: &AppHandle, task: &LocalSchedule, run: LocalScheduleRun) {
    let state = app.state::<SchedulerState>();
    let storage = state.storage();
    if let Err(e) = storage.append_run(&run) {
        eprintln!("[scheduler] 写入 run 失败：{e}");
    }

    // 更新任务的 last_run_id + 重算 next_run_at（ONCE 任务转 COMPLETED）。
    if let Some(mut latest) = state.get_task(&task.id) {
        latest.last_run_id = Some(run.id.clone());
        if matches!(latest.trigger, LocalScheduleTrigger::Once { .. }) {
            latest.status = LocalScheduleStatus::Completed;
            latest.next_run_at = None;
        } else {
            match next_run_after(&latest.trigger, Utc::now()) {
                Ok(Some(next)) => latest.next_run_at = Some(next.to_rfc3339()),
                _ => latest.next_run_at = None,
            }
        }
        latest.updated_at = Utc::now().to_rfc3339();
        let _ = state.upsert_task(latest);
    }

    // 推通知（全状态推送：成功/失败/超时/跳过）。
    let (title, body) = run_notification(task, &run);
    // emit 给前端，由前端走应用内通知中心 + 系统通知（尊重勿扰时段）。
    let _ = app.emit(
        "scheduler:notify",
        serde_json::json!({ "title": title, "body": body }),
    );

    // emit 给前端 UI / 红点徽章。
    let _ = app.emit(
        "scheduler:run_finished",
        serde_json::json!({ "task": task, "run": run }),
    );

    // 释放 running 槽位。
    state.mark_done();
}

/// 生成通知文案（按状态分模板）。
fn run_notification(task: &LocalSchedule, run: &LocalScheduleRun) -> (String, String) {
    let prefix = "[定时任务]";
    match run.status {
        LocalScheduleRunStatus::Success => {
            let dur = run
                .duration_ms
                .map(|ms| format!("（耗时 {} 秒）", ms / 1000))
                .unwrap_or_default();
            (
                format!("{prefix}「{}」执行完成{dur}", task.name),
                run.output_summary.clone().unwrap_or_default(),
            )
        }
        LocalScheduleRunStatus::Failed => (
            format!("{prefix}「{}」执行失败", task.name),
            run.error.clone().unwrap_or_else(|| "未知错误".to_string()),
        ),
        LocalScheduleRunStatus::Timeout => (
            format!("{prefix}「{}」执行超时", task.name),
            run.error.clone().unwrap_or_else(|| "超过最大执行时长".to_string()),
        ),
        LocalScheduleRunStatus::Skipped => (
            format!("{prefix}「{}」已跳过", task.name),
            run.skip_reason.clone().unwrap_or_default(),
        ),
        LocalScheduleRunStatus::Running => (
            format!("{prefix}「{}」开始执行", task.name),
            String::new(),
        ),
    }
}

/// 计算 ISO 时间差（毫秒）。
fn parse_iso_delta(later: &str, earlier: &str) -> Option<u64> {
    let l = super::cron::parse_iso(later).ok()?;
    let e = super::cron::parse_iso(earlier).ok()?;
    Some((l - e).num_milliseconds().max(0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_runs_insert_deliver_cancel() {
        let pending = PendingRuns::default();
        let run_id = "r1";
        let (tx, rx) = oneshot::channel();
        pending.insert(run_id, tx);
        let record = LocalScheduleRunRecordInput {
            id: run_id.to_string(),
            task_id: "t1".to_string(),
            started_at: "2026-07-20T00:00:00Z".to_string(),
            finished_at: "2026-07-20T00:00:01Z".to_string(),
            status: LocalScheduleRunRecordStatus::Success,
            error: None,
            output_summary: Some("ok".to_string()),
        };
        pending.deliver(run_id, record.clone()).unwrap();
        let got = futures::executor::block_on(rx).unwrap();
        assert_eq!(got.id, "r1");
    }

    #[test]
    fn pending_runs_deliver_missing_returns_err() {
        let pending = PendingRuns::default();
        let record = LocalScheduleRunRecordInput {
            id: "nope".to_string(),
            task_id: "t1".to_string(),
            started_at: "2026-07-20T00:00:00Z".to_string(),
            finished_at: "2026-07-20T00:00:01Z".to_string(),
            status: LocalScheduleRunRecordStatus::Success,
            error: None,
            output_summary: None,
        };
        assert!(pending.deliver("nope", record).is_err());
    }
}
