//! Tauri commands：本地定时任务 CRUD + 运行管理。
//!
//! 命令一览：
//! - `scheduler_create(input)` → 写入新任务（含 next_run_at 初始化）。
//! - `scheduler_update(id, input)` → 部分字段更新（重算 next_run_at）。
//! - `scheduler_delete(id)` → 物理删除（删磁盘 + 清内存）。
//! - `scheduler_list(filter?)` → 列表（默认过滤 DELETED）。
//! - `scheduler_pause(id)` / `scheduler_resume(id)` → 状态切换。
//! - `scheduler_run_now(id)` → 立即入队（无视 next_run_at），用于手动测试。
//! - `scheduler_list_runs(task_id?, limit?)` → 历史记录。
//! - `scheduler_record_run(record)` → 前端 AGENT_PROMPT 跑完后回写结果。
//! - `scheduler_has_active()` → 是否有 ACTIVE 任务（close 确认对话框用）。

use chrono::Utc;
use tauri::State;
use uuid::Uuid;

use super::cron::next_run_after;
use super::executor::PendingRuns;
use super::state::SchedulerState;
use super::types::{
    LocalSchedule, LocalScheduleCreateInput, LocalScheduleListFilter, LocalScheduleRun,
    LocalScheduleRunRecordInput,
    LocalScheduleStatus, LocalScheduleTrigger, LocalScheduleUpdateInput,
};

/// 创建任务。
#[tauri::command]
pub(crate) async fn scheduler_create(
    state: State<'_, SchedulerState>,
    input: LocalScheduleCreateInput,
) -> Result<LocalSchedule, String> {
    // 验证 cron 表达式（CRON 触发器）。
    if let LocalScheduleTrigger::Cron { cron, .. } = &input.trigger {
        super::cron::parse_cron(cron)?;
    }
    let now = Utc::now();
    let id = Uuid::new_v4().to_string();
    let next_run_at = next_run_after(&input.trigger, now)
        .map_err(|e| format!("算 next_run_at 失败：{e}"))?
        .map(|dt| dt.to_rfc3339());
    let task = LocalSchedule {
        id,
        name: input.name,
        trigger: input.trigger,
        payload: input.payload,
        status: input.status,
        timeout_ms: input.timeout_ms,
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
        last_run_id: None,
        next_run_at,
    };
    state.upsert_task(task.clone())?;
    Ok(task)
}

/// 更新任务（部分字段；任一提供即覆盖）。
#[tauri::command]
pub(crate) async fn scheduler_update(
    state: State<'_, SchedulerState>,
    id: String,
    input: LocalScheduleUpdateInput,
) -> Result<LocalSchedule, String> {
    let mut task = state
        .get_task(&id)
        .ok_or_else(|| format!("任务「{id}」不存在"))?;
    // 先记录哪些字段被提供（避免部分 move 后无法访问 input.trigger）。
    let trigger_changed = input.trigger.is_some();
    let status_changed = input.status.is_some();
    if let Some(name) = input.name {
        task.name = name;
    }
    if let Some(trigger) = input.trigger {
        if let LocalScheduleTrigger::Cron { cron, .. } = &trigger {
            super::cron::parse_cron(cron)?;
        }
        task.trigger = trigger;
    }
    if let Some(payload) = input.payload {
        task.payload = payload;
    }
    if let Some(timeout_ms) = input.timeout_ms {
        task.timeout_ms = timeout_ms;
    }
    if let Some(status) = input.status {
        task.status = status;
    }
    // 若 trigger / status 改变，重算 next_run_at。
    if trigger_changed || status_changed {
        task.next_run_at = if task.status == LocalScheduleStatus::Active {
            next_run_after(&task.trigger, Utc::now())
                .map_err(|e| format!("算 next_run_at 失败：{e}"))?
                .map(|dt| dt.to_rfc3339())
        } else {
            None
        };
    }
    task.updated_at = Utc::now().to_rfc3339();
    state.upsert_task(task.clone())?;
    Ok(task)
}

/// 删除任务（物理删除）。
#[tauri::command]
pub(crate) async fn scheduler_delete(
    state: State<'_, SchedulerState>,
    id: String,
) -> Result<(), String> {
    state.delete_task(&id)
}

/// 列出任务（默认过滤 DELETED）。
#[tauri::command]
pub(crate) async fn scheduler_list(
    state: State<'_, SchedulerState>,
    filter: Option<LocalScheduleListFilter>,
) -> Result<Vec<LocalSchedule>, String> {
    let tasks = state.snapshot_tasks();
    let filtered = match filter.and_then(|f| f.status) {
        Some(status) => tasks.into_iter().filter(|t| t.status == status).collect(),
        None => tasks
            .into_iter()
            .filter(|t| t.status != LocalScheduleStatus::Deleted)
            .collect(),
    };
    Ok(filtered)
}

/// 暂停任务（ACTIVE → PAUSED）。
#[tauri::command]
pub(crate) async fn scheduler_pause(
    state: State<'_, SchedulerState>,
    id: String,
) -> Result<LocalSchedule, String> {
    let mut task = state
        .get_task(&id)
        .ok_or_else(|| format!("任务「{id}」不存在"))?;
    if task.status != LocalScheduleStatus::Active {
        return Err("仅 ACTIVE 状态可暂停".to_string());
    }
    task.status = LocalScheduleStatus::Paused;
    task.next_run_at = None;
    task.updated_at = Utc::now().to_rfc3339();
    state.upsert_task(task.clone())?;
    Ok(task)
}

/// 恢复任务（PAUSED → ACTIVE，重算 next_run_at）。
#[tauri::command]
pub(crate) async fn scheduler_resume(
    state: State<'_, SchedulerState>,
    id: String,
) -> Result<LocalSchedule, String> {
    let mut task = state
        .get_task(&id)
        .ok_or_else(|| format!("任务「{id}」不存在"))?;
    if task.status != LocalScheduleStatus::Paused {
        return Err("仅 PAUSED 状态可恢复".to_string());
    }
    task.status = LocalScheduleStatus::Active;
    task.next_run_at = next_run_after(&task.trigger, Utc::now())
        .map_err(|e| format!("算 next_run_at 失败：{e}"))?
        .map(|dt| dt.to_rfc3339());
    task.updated_at = Utc::now().to_rfc3339();
    state.upsert_task(task.clone())?;
    Ok(task)
}

/// 立即运行（手动测试）：直接入队，无视 next_run_at。
/// 注意：若 running.is_some()，会被 try_claim_next 内部跳过（无法排队）。
/// 调用方应通过 has_active / has_running 先检查。
#[tauri::command]
pub(crate) async fn scheduler_run_now(
    state: State<'_, SchedulerState>,
    id: String,
) -> Result<(), String> {
    let task = state
        .get_task(&id)
        .ok_or_else(|| format!("任务「{id}」不存在"))?;
    if task.status == LocalScheduleStatus::Deleted {
        return Err("任务已删除".to_string());
    }
    if state.has_running() {
        return Err("当前已有任务在跑，请稍候".to_string());
    }
    state.enqueue(&id);
    Ok(())
}

/// 列出 run 历史。
/// task_id 不传 → 跨任务返回最近 limit 条（按时间倒序合并）。
/// task_id 传入 → 仅返回该任务的历史。
#[tauri::command]
pub(crate) async fn scheduler_list_runs(
    state: State<'_, SchedulerState>,
    task_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<LocalScheduleRun>, String> {
    let limit = limit.unwrap_or(50).min(500);
    let storage = state.storage();
    if let Some(tid) = task_id {
        return storage.list_runs(&tid, limit);
    }
    // 跨任务合并：遍历所有任务目录读 runs.jsonl，合并后按时间倒序取前 limit。
    let tasks = state.snapshot_tasks();
    let mut all: Vec<LocalScheduleRun> = Vec::new();
    for t in tasks {
        if let Ok(runs) = storage.list_runs(&t.id, 500) {
            all.extend(runs);
        }
    }
    all.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    all.truncate(limit);
    Ok(all)
}

/// 前端 AGENT_PROMPT 跑完后回写 run 结果。
/// 通过 PendingRuns 把结果送给正在等待的 executor。
#[tauri::command]
pub(crate) async fn scheduler_record_run(
    pending: State<'_, PendingRuns>,
    record: LocalScheduleRunRecordInput,
) -> Result<(), String> {
    let id = record.id.clone();
    pending.deliver(&id, record)
}

/// 是否有 ACTIVE 任务（close 确认对话框用）。
#[tauri::command]
pub(crate) async fn scheduler_active_count(state: State<'_, SchedulerState>) -> Result<usize, String> {
    Ok(state.active_count())
}

/// 是否有任务正在跑（close 确认对话框用）。
#[tauri::command]
pub(crate) async fn scheduler_has_running(state: State<'_, SchedulerState>) -> Result<bool, String> {
    Ok(state.has_running())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::{LocalScheduleRunRecordStatus, LocalScheduleRunStatus};

    #[test]
    fn list_filter_status_discriminant() {
        // 仅类型层 sanity（实际集成测试在 commands 集成层）。
        let f = LocalScheduleListFilter {
            status: Some(LocalScheduleStatus::Active),
        };
        assert_eq!(f.status, Some(LocalScheduleStatus::Active));
    }

    #[test]
    fn run_record_status_serializes_uppercase() {
        let s = serde_json::to_string(&LocalScheduleRunRecordStatus::Success).unwrap();
        assert_eq!(s, "\"SUCCESS\"");
    }

    #[test]
    fn run_status_serializes_uppercase() {
        let s = serde_json::to_string(&LocalScheduleRunStatus::Skipped).unwrap();
        assert_eq!(s, "\"SKIPPED\"");
    }

    #[test]
    fn status_serializes_uppercase() {
        let s = serde_json::to_string(&LocalScheduleStatus::Paused).unwrap();
        assert_eq!(s, "\"PAUSED\"");
    }
}
