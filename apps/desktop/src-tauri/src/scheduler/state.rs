//! SchedulerState：内存状态 + 启动加载。
//!
//! 字段：
//! - `tasks`：所有任务的内存镜像（与磁盘 task.json 对齐）。启动时从存储加载。
//! - `due_queue`：到点待执行的任务 ID（FIFO）。
//! - `running`：当前在跑的任务 ID（最多 1 个，串行）。
//!
//! 锁策略：单个 Mutex 包住所有字段（操作粒度小，竞争极少）。并发由 executor 串行保序。
//! 不用 RwLock：写多读少，且 60s tick + 命令调用都是短临界区。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use super::storage::SchedulerStorage;
use super::types::LocalSchedule;

/// 全局状态（Tauri State）。
pub(crate) struct SchedulerState {
    inner: Mutex<Inner>,
    storage: SchedulerStorage,
}

struct Inner {
    /// task_id → 配置。
    tasks: HashMap<String, LocalSchedule>,
    /// 到点待执行的任务 ID。
    due_queue: VecDeque<String>,
    /// 当前在跑的任务 ID（None = 空闲）。
    running: Option<String>,
}

impl SchedulerState {
    /// 启动时从磁盘加载所有任务到内存。
    pub(crate) fn new(storage: SchedulerStorage) -> Self {
        let tasks_list = storage.list_tasks();
        let tasks: HashMap<String, LocalSchedule> = tasks_list
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        eprintln!("[scheduler] 已加载 {} 个本地定时任务", tasks.len());
        Self {
            inner: Mutex::new(Inner {
                tasks,
                due_queue: VecDeque::new(),
                running: None,
            }),
            storage,
        }
    }

    pub(crate) fn storage(&self) -> &SchedulerStorage {
        &self.storage
    }

    /// 拿一份所有任务的快照（命令返回用）。
    pub(crate) fn snapshot_tasks(&self) -> Vec<LocalSchedule> {
        let inner = self.inner.lock().expect("scheduler state lock poisoned");
        let mut tasks: Vec<LocalSchedule> = inner.tasks.values().cloned().collect();
        tasks.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        tasks
    }

    /// 取单个任务。
    pub(crate) fn get_task(&self, task_id: &str) -> Option<LocalSchedule> {
        let inner = self.inner.lock().expect("scheduler state lock poisoned");
        inner.tasks.get(task_id).cloned()
    }

    /// 插入/更新任务（写磁盘 + 刷内存）。
    pub(crate) fn upsert_task(&self, task: LocalSchedule) -> Result<(), String> {
        self.storage.write_task(&task)?;
        let mut inner = self.inner.lock().expect("scheduler state lock poisoned");
        inner.tasks.insert(task.id.clone(), task);
        Ok(())
    }

    /// 删除任务（删磁盘 + 刷内存）。
    pub(crate) fn delete_task(&self, task_id: &str) -> Result<(), String> {
        self.storage.delete_task(task_id)?;
        let mut inner = self.inner.lock().expect("scheduler state lock poisoned");
        inner.tasks.remove(task_id);
        // 清理队列与 running 状态（若该任务正好在跑，由 executor 单独处理；此处仅做内存清理的尽力而为）。
        inner.due_queue.retain(|id| id != task_id);
        if inner.running.as_deref() == Some(task_id) {
            inner.running = None;
        }
        Ok(())
    }

    /// 入队待执行任务（executor 调用）。
    pub(crate) fn enqueue(&self, task_id: &str) {
        let mut inner = self.inner.lock().expect("scheduler state lock poisoned");
        // 去重：同任务已在队列则不重复入队（避免堆积）。
        if !inner.due_queue.iter().any(|id| id == task_id) {
            inner.due_queue.push_back(task_id.to_string());
        }
    }

    /// 尝试取出下一个可执行任务（若无或当前在跑则返回 None）。
    /// 返回 (task_id, task) 或 None。
    pub(crate) fn try_claim_next(&self) -> Option<LocalSchedule> {
        let mut inner = self.inner.lock().expect("scheduler state lock poisoned");
        if inner.running.is_some() {
            return None;
        }
        let task_id = inner.due_queue.pop_front()?;
        if let Some(task) = inner.tasks.get(&task_id).cloned() {
            // 仅 ACTIVE 任务才真正执行；其他状态（被暂停/删除）跳过。
            if task.status == super::types::LocalScheduleStatus::Active {
                inner.running = Some(task_id);
                Some(task)
            } else {
                None
            }
        } else {
            None
        }
    }

    /// 当前有任务在跑时，把队列中所有待执行任务清空并返回（executor 据此记 SKIPPED）。
    /// PRD Q5.3 决策 (a)：前一个未跑完时新到任务直接跳过，不排队（防队列堆积）。
    /// 返回值：被跳过的 task_id 列表（可能为空）。
    pub(crate) fn drain_skipped(&self) -> Vec<String> {
        let mut inner = self.inner.lock().expect("scheduler state lock poisoned");
        if inner.running.is_none() {
            return Vec::new();
        }
        // 把队列里的任务全部弹出（但不去重 running；running 的任务自己跑自己的）。
        let skipped: Vec<String> = inner.due_queue.drain(..).collect();
        skipped
    }

    /// 标记当前任务完成（释放 running 槽位）。
    pub(crate) fn mark_done(&self) {
        let mut inner = self.inner.lock().expect("scheduler state lock poisoned");
        inner.running = None;
    }

    /// 当前是否有任务在跑（用于 close 确认对话框）。
    pub(crate) fn has_running(&self) -> bool {
        let inner = self.inner.lock().expect("scheduler state lock poisoned");
        inner.running.is_some()
    }

    /// 当前活跃任务数（ACTIVE 状态，用于 close 确认对话框）。
    pub(crate) fn active_count(&self) -> usize {
        let inner = self.inner.lock().expect("scheduler state lock poisoned");
        inner
            .tasks
            .values()
            .filter(|t| t.status == super::types::LocalScheduleStatus::Active)
            .count()
    }
}
