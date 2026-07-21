//! 本地定时任务的 Rust 类型定义（与 `packages/contract/src/local-scheduler.ts` 对齐）。
//!
//! 字段命名一律 snake_case（与契约一致），serde 默认命名。新增字段时务必同步契约 + 前端类型。

use serde::{Deserialize, Serialize};

/// 任务状态。
/// - `ACTIVE`：调度中，到点会触发。
/// - `PAUSED`：暂停，不触发（用户手动暂停或创建即暂停）。
/// - `COMPLETED`：已完成（ONCE 触发后自动转入；CRON 任务永不进入此状态）。
/// - `DELETED`：软删除（list 默认过滤，文件保留 7 天后由 GC 物理删除）。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum LocalScheduleStatus {
    Active,
    Paused,
    Completed,
    Deleted,
}

/// 触发器。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "UPPERCASE")]
pub enum LocalScheduleTrigger {
    /// 一次性触发（UTC ISO 字符串）。
    Once {
        /// 触发时间（RFC 3339 / ISO 8601）。
        run_at: String,
    },
    /// 周期触发（cron 表达式 + 时区）。
    Cron {
        /// 5 字段标准 cron（分 时 日 月 周）。
        cron: String,
        /// IANA 时区名（如 Asia/Shanghai）。
        time_zone: String,
    },
}

/// 执行体 payload（三种）。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LocalTaskPayload {
    /// 跑 Agent prompt（前端常驻组件接收 trigger 事件后启动隐藏 session）。
    AgentPrompt {
        /// Agent prompt（上限 10000 字符）。
        prompt: String,
    },
    /// 跑插件 action（plugin_id + action + 入参）。
    PluginAction {
        plugin_id: String,
        action: String,
        /// 任意 JSON 入参。
        input: serde_json::Value,
    },
    /// 仅发系统通知。
    Notify {
        title: String,
        #[serde(default)]
        body: String,
    },
}

impl LocalTaskPayload {
    /// 类型字符串，用于 UI 显示徽章。
    pub fn type_tag(&self) -> &'static str {
        match self {
            LocalTaskPayload::AgentPrompt { .. } => "AGENT_PROMPT",
            LocalTaskPayload::PluginAction { .. } => "PLUGIN_ACTION",
            LocalTaskPayload::Notify { .. } => "NOTIFY",
        }
    }
}

/// 任务定义。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LocalSchedule {
    pub id: String,
    pub name: String,
    pub trigger: LocalScheduleTrigger,
    pub payload: LocalTaskPayload,
    pub status: LocalScheduleStatus,
    /// 单次执行硬超时（ms）。
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    pub created_at: String,
    pub updated_at: String,
    /// 最近一次 run 的 ID。
    #[serde(default)]
    pub last_run_id: Option<String>,
    /// 下次触发时间（RFC 3339）。ACTIVE 必有；其他状态可为 null。
    #[serde(default)]
    pub next_run_at: Option<String>,
}

fn default_timeout_ms() -> u64 {
    1_800_000 // 30 分钟。
}

/// 创建请求（不含 id / 时间戳 / 运行时字段）。
#[derive(Clone, Debug, Deserialize)]
pub struct LocalScheduleCreateInput {
    pub name: String,
    pub trigger: LocalScheduleTrigger,
    pub payload: LocalTaskPayload,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_status_active")]
    pub status: LocalScheduleStatus,
}

fn default_status_active() -> LocalScheduleStatus {
    LocalScheduleStatus::Active
}

/// 更新请求（部分字段；任一提供即覆盖）。
#[derive(Clone, Debug, Deserialize, Default)]
pub struct LocalScheduleUpdateInput {
    pub name: Option<String>,
    pub trigger: Option<LocalScheduleTrigger>,
    pub payload: Option<LocalTaskPayload>,
    pub timeout_ms: Option<u64>,
    pub status: Option<LocalScheduleStatus>,
}

/// 列表过滤条件。
#[derive(Clone, Debug, Deserialize, Default)]
pub struct LocalScheduleListFilter {
    /// 不传 = 所有非 DELETED；传则按状态过滤。
    pub status: Option<LocalScheduleStatus>,
}

/// 运行记录状态。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum LocalScheduleRunStatus {
    Running,
    Success,
    Failed,
    Timeout,
    Skipped,
}

/// 单次运行记录（写入 runs.jsonl）。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LocalScheduleRun {
    pub id: String,
    pub task_id: String,
    pub started_at: String,
    /// RUNNING 时为 null。
    #[serde(default)]
    pub finished_at: Option<String>,
    pub status: LocalScheduleRunStatus,
    #[serde(default)]
    pub skip_reason: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub output_summary: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

/// 前端 AGENT_PROMPT 跑完回写 run 结果的入参（不含 id，由后端生成或前端传入）。
#[derive(Clone, Debug, Deserialize)]
pub struct LocalScheduleRunRecordInput {
    pub id: String,
    pub task_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub status: LocalScheduleRunRecordStatus,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub output_summary: Option<String>,
}

/// 回写时的允许状态（前端只能回写 SUCCESS/FAILED；TIMEOUT/SKIPPED 由后端判定）。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum LocalScheduleRunRecordStatus {
    Success,
    Failed,
}

/// 每任务保留的 run 记录上限（超出自动 GC 最旧的）。与契约 LOCAL_SCHEDULE_RUNS_KEEP 对齐。
pub(crate) const LOCAL_RUNS_KEEP: usize = 200;
