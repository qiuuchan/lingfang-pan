//! 本地定时任务（Local Scheduler）。
//!
//! 设计见 `.trellis/tasks/07-20-local-scheduler/prd.md`，参考 CodeBuddy WorkBuddy「自动化」。
//!
//! 核心语义：
//! - 配置持久化到本地磁盘（`app_data_dir/scheduler/tasks/<id>/{task.json, runs.jsonl}`）。
//! - 仅在桌面端运行时触发；关机/重启不丢配置，但**不补跑**历史漏掉的任务。
//! - 串行执行（最大并发 1）：前一个未跑完时新到任务记 `SKIPPED`。
//! - 30 分钟硬超时（tokio timeout 包裹），超时强制终止 + 记 `TIMEOUT`。
//! - 三种执行体（payload.type）：
//!   - `AGENT_PROMPT` → emit `scheduler:trigger` 给前端常驻 `<SchedulerAgentRunner>` 组件。
//!   - `PLUGIN_ACTION` → 复用 `plugin_runner`（本 MVP 仅占位，二期对接 action invoke 通道）。
//!   - `NOTIFY`       → tauri-plugin-notification 发系统通知。
//!
//! 模块布局：
//! - `state`：内存状态（tasks HashMap + due_queue + running + tick handle）。
//! - `storage`：文件读写（task.json 原子写 + runs.jsonl append + GC 200 条）。
//! - `cron`：croner 封装，算 next_run_at。
//! - `executor`：60s tick loop + 串行执行分发。
//! - `commands`：Tauri commands（create/update/delete/list/pause/resume/run_now/list_runs/record_run）。
//! - `types`：与 `packages/contract/src/local-scheduler.ts` 对齐的 Rust 类型。
pub(crate) mod commands;
pub(crate) mod cron;
pub(crate) mod executor;
pub(crate) mod state;
pub(crate) mod storage;
pub(crate) mod types;

pub(crate) use executor::PendingRuns;
pub(crate) use state::SchedulerState;
pub(crate) use storage::SchedulerStorage;
