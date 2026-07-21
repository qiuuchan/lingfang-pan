// local-scheduler.ts —— 本地定时任务的前端 API 封装。
//
// 与 Rust 端 `src-tauri/src/scheduler/commands.rs` 一一对应。
// 类型从 `@lingfang/contract` 复用（单一事实来源，contract/index.ts 已 `export * from './local-scheduler'`）。
//
// 设计要点：
// - 所有调用走 tauriInvoke（不经 HTTP，本地调度器不依赖 collab-api）。
// - 错误消息走 errorMessage() 归一化（与 api.ts 一致）。
// - 列表 / 历史记录支持分页（limit + 可选 task_id 过滤）。
import { tauriInvoke, errorMessage } from '@/lib/api';
import type {
  LocalSchedule,
  LocalScheduleCreateInput,
  LocalScheduleRun,
  LocalScheduleRunRecordInput,
  LocalScheduleStatus,
  LocalScheduleUpdateInput,
} from '@lingfang/contract';

// 复用 contract 的 schema 做运行时校验（Agent 工具 + UI 编辑对话框都用）。
export {
  LocalSchedule,
  LocalScheduleCreateInput,
  LocalScheduleUpdateInput,
  LocalScheduleRun,
  LocalScheduleRunRecordInput,
  LocalScheduleStatus,
  LocalScheduleRunStatus,
  LocalScheduleTrigger,
  LocalTaskPayload,
  LocalTaskType,
  LOCAL_SCHEDULE_TIMEOUT_MS_DEFAULT,
  LOCAL_SCHEDULE_TIMEOUT_MS_MIN,
  LOCAL_SCHEDULE_TIMEOUT_MS_MAX,
  LOCAL_SCHEDULE_RUNS_KEEP,
} from '@lingfang/contract';

// —— Commands ——（与 src-tauri/src/scheduler/commands.rs 一一对应）

/** 创建任务。 */
export async function schedulerCreate(input: LocalScheduleCreateInput): Promise<LocalSchedule> {
  return tauriInvoke<LocalSchedule>('scheduler_create', { input });
}

/** 更新任务（部分字段）。 */
export async function schedulerUpdate(
  id: string,
  input: LocalScheduleUpdateInput,
): Promise<LocalSchedule> {
  return tauriInvoke<LocalSchedule>('scheduler_update', { id, input });
}

/** 删除任务（物理删除）。 */
export async function schedulerDelete(id: string): Promise<void> {
  await tauriInvoke<void>('scheduler_delete', { id });
}

/** 列出任务（默认过滤 DELETED）。 */
export async function schedulerList(
  filter?: { status?: LocalScheduleStatus },
): Promise<LocalSchedule[]> {
  return tauriInvoke<LocalSchedule[]>('scheduler_list', { filter: filter ?? null });
}

/** 暂停任务（ACTIVE → PAUSED）。 */
export async function schedulerPause(id: string): Promise<LocalSchedule> {
  return tauriInvoke<LocalSchedule>('scheduler_pause', { id });
}

/** 恢复任务（PAUSED → ACTIVE）。 */
export async function schedulerResume(id: string): Promise<LocalSchedule> {
  return tauriInvoke<LocalSchedule>('scheduler_resume', { id });
}

/** 立即运行（手动测试）。 */
export async function schedulerRunNow(id: string): Promise<void> {
  await tauriInvoke<void>('scheduler_run_now', { id });
}

/** 列出历史 run 记录。task_id 不传 → 跨任务合并。 */
export async function schedulerListRuns(
  taskId?: string,
  limit = 50,
): Promise<LocalScheduleRun[]> {
  return tauriInvoke<LocalScheduleRun[]>('scheduler_list_runs', {
    taskId: taskId ?? null,
    limit,
  });
}

/** AGENT_PROMPT 跑完回写 run 结果（由 SchedulerAgentRunner 调用）。 */
export async function schedulerRecordRun(record: LocalScheduleRunRecordInput): Promise<void> {
  await tauriInvoke<void>('scheduler_record_run', { record });
}

/** 当前 ACTIVE 任务数（close 确认对话框用）。 */
export async function schedulerActiveCount(): Promise<number> {
  return tauriInvoke<number>('scheduler_active_count');
}

/** 是否有任务正在跑（close 确认对话框用）。 */
export async function schedulerHasRunning(): Promise<boolean> {
  return tauriInvoke<boolean>('scheduler_has_running');
}

/** 统一错误信息提取。 */
export { errorMessage };
