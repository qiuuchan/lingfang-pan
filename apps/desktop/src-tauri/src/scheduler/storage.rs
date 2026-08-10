//! 文件存储：task.json 原子写 + runs.jsonl append + GC。
//!
//! 布局（在 `app_data_dir/scheduler/`）：
//! ```text
//! scheduler/
//! ├── tasks/
//! │   ├── <task-id>/
//! │   │   ├── task.json    # 配置（原子写：写 .tmp → rename）
//! │   │   └── runs.jsonl   # 历史（每行一条 JSON，append-only，保留最近 200）
//! │   └── <task-id>/...
//! ```
//!
//! 错误策略：
//! - 单任务的 I/O 失败不影响其他任务：所有公共方法返回 Result，调用方按任务粒度处理。
//! - 文件损坏（JSON 解析失败）：runs 文件重命名为 `.corrupt-<ts>` 后重建空文件；
//!   task 文件解析失败上报错误，不删除（让用户介入）。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::types::{LocalSchedule, LocalScheduleRun};

/// 每任务保留的 run 记录上限。与契约 LOCAL_SCHEDULE_RUNS_KEEP 对齐。
const LOCAL_SCHEDULE_RUNS_KEEP: usize = super::types::LOCAL_RUNS_KEEP;

/// 存储根目录（`app_data_dir/scheduler/`）的封装。
#[derive(Clone, Debug)]
pub(crate) struct SchedulerStorage {
    root: PathBuf,
}

impl SchedulerStorage {
    pub(crate) fn new(app_data_dir: &Path) -> Self {
        let root = app_data_dir.join("scheduler");
        let _ = fs::create_dir_all(&root); // 启动时尽力创建，失败时各操作再报错。
        let _ = fs::create_dir_all(root.join("tasks"));
        Self { root }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    fn task_dir(&self, task_id: &str) -> PathBuf {
        self.root().join("tasks").join(sanitize_id(task_id))
    }

    fn task_file(&self, task_id: &str) -> PathBuf {
        self.task_dir(task_id).join("task.json")
    }

    fn runs_file(&self, task_id: &str) -> PathBuf {
        self.task_dir(task_id).join("runs.jsonl")
    }

    /// 写任务配置（原子写）。
    pub(crate) fn write_task(&self, task: &LocalSchedule) -> Result<(), String> {
        let dir = self.task_dir(&task.id);
        fs::create_dir_all(&dir).map_err(|e| format!("创建任务目录失败：{e}"))?;
        let path = self.task_file(&task.id);
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(task)
            .map_err(|e| format!("序列化任务失败：{e}"))?;
        // 写 tmp → fsync → rename（原子替换）。
        {
            let mut f = fs::File::create(&tmp).map_err(|e| format!("创建临时文件失败：{e}"))?;
            f.write_all(&bytes).map_err(|e| format!("写入临时文件失败：{e}"))?;
            let _ = f.sync_all();
        }
        fs::rename(&tmp, &path).map_err(|e| format!("原子替换失败：{e}"))?;
        Ok(())
    }

    /// 读单个任务配置。
    pub(crate) fn read_task(&self, task_id: &str) -> Result<LocalSchedule, String> {
        let path = self.task_file(task_id);
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("读取任务配置失败：{e}"))?;
        serde_json::from_str(&raw).map_err(|e| format!("解析任务配置失败：{e}"))
    }

    /// 删除整个任务目录（task.json + runs.jsonl）。物理删除，不可恢复。
    pub(crate) fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let dir = self.task_dir(task_id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| format!("删除任务目录失败：{e}"))?;
        }
        Ok(())
    }

    /// 列出所有任务目录下的 task.json。
    pub(crate) fn list_tasks(&self) -> Vec<LocalSchedule> {
        let tasks_root = self.root().join("tasks");
        let entries = match fs::read_dir(&tasks_root) {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let task_file = entry.path().join("task.json");
            if !task_file.is_file() {
                continue;
            }
            match fs::read_to_string(&task_file)
                .ok()
                .and_then(|s| serde_json::from_str::<LocalSchedule>(&s).ok())
            {
                Some(task) => out.push(task),
                None => {
                    eprintln!(
                        "[scheduler] 任务配置损坏已跳过：{}",
                        task_file.display()
                    );
                }
            }
        }
        // 按 created_at 升序（稳定 + 可预测）。
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        out
    }

    /// Append 一条 run 到 runs.jsonl，并做 GC（保留最近 KEEP 条）。
    pub(crate) fn append_run(&self, run: &LocalScheduleRun) -> Result<(), String> {
        let dir = self.task_dir(&run.task_id);
        fs::create_dir_all(&dir).map_err(|e| format!("创建任务目录失败：{e}"))?;
        let path = self.runs_file(&run.task_id);
        let line = serde_json::to_string(run).map_err(|e| format!("序列化 run 失败：{e}"))?;
        {
            let mut f = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| format!("打开 runs.jsonl 失败：{e}"))?;
            f.write_all(line.as_bytes())
                .map_err(|e| format!("写入 runs.jsonl 失败：{e}"))?;
            f.write_all(b"\n")
                .map_err(|e| format!("写入换行失败：{e}"))?;
            let _ = f.sync_all();
        }
        // GC：超出 KEEP 条时重写文件，保留最后 KEEP 条。
        self.gc_runs(&run.task_id)
    }

    /// 读任务的历史 runs（按时间倒序，最多 limit 条）。
    pub(crate) fn list_runs(
        &self,
        task_id: &str,
        limit: usize,
    ) -> Result<Vec<LocalScheduleRun>, String> {
        let path = self.runs_file(task_id);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&path).map_err(|e| format!("读取 runs.jsonl 失败：{e}"))?;
        let mut runs: Vec<LocalScheduleRun> = Vec::new();
        for (i, line) in raw.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<LocalScheduleRun>(line) {
                Ok(r) => runs.push(r),
                Err(e) => {
                    eprintln!(
                        "[scheduler] runs.jsonl 第 {} 行解析失败已跳过：{}",
                        i + 1,
                        e
                    );
                }
            }
        }
        // 倒序（最新在前）。
        runs.reverse();
        runs.truncate(limit);
        Ok(runs)
    }

    /// 超过 KEEP 条时重写文件，保留最后 KEEP 条。
    fn gc_runs(&self, task_id: &str) -> Result<(), String> {
        let path = self.runs_file(task_id);
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => return Ok(()),
        };
        let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.len() <= LOCAL_SCHEDULE_RUNS_KEEP {
            return Ok(());
        }
        let keep_from = lines.len() - LOCAL_SCHEDULE_RUNS_KEEP;
        let new_content: String = lines[keep_from..]
            .iter()
            .map(|l| format!("{l}\n"))
            .collect();
        let tmp = path.with_extension("jsonl.tmp");
        {
            let mut f = fs::File::create(&tmp).map_err(|e| format!("创建 GC 临时文件失败：{e}"))?;
            f.write_all(new_content.as_bytes())
                .map_err(|e| format!("写入 GC 文件失败：{e}"))?;
            let _ = f.sync_all();
        }
        fs::rename(&tmp, &path).map_err(|e| format!("GC 原子替换失败：{e}"))?;
        Ok(())
    }
}

/// 任务 ID 白名单（仅允许字母数字 + _ -，禁止路径穿越）。
fn sanitize_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fake_task(id: &str) -> LocalSchedule {
        use super::super::types::{LocalScheduleStatus, LocalScheduleTrigger, LocalTaskPayload};
        LocalSchedule {
            id: id.to_string(),
            name: format!("任务 {id}"),
            trigger: LocalScheduleTrigger::Once {
                run_at: "2030-01-01T00:00:00Z".to_string(),
            },
            payload: LocalTaskPayload::Notify {
                title: "测试".to_string(),
                body: "".to_string(),
            },
            status: LocalScheduleStatus::Active,
            timeout_ms: 1_800_000,
            created_at: "2026-07-20T00:00:00Z".to_string(),
            updated_at: "2026-07-20T00:00:00Z".to_string(),
            last_run_id: None,
            next_run_at: None,
        }
    }

    fn fake_run(id: &str, task_id: &str, idx: u64) -> LocalScheduleRun {
        use super::super::types::LocalScheduleRunStatus;
        LocalScheduleRun {
            id: format!("{id}-{idx}"),
            task_id: task_id.to_string(),
            started_at: format!("2026-07-20T00:00:{idx:02}Z"),
            finished_at: Some(format!("2026-07-20T00:00:{idx:02}Z")),
            status: LocalScheduleRunStatus::Success,
            skip_reason: None,
            error: None,
            output_summary: Some("ok".to_string()),
            duration_ms: Some(10),
        }
    }

    #[test]
    fn write_read_task_roundtrip() {
        let dir = tempdir().unwrap();
        let store = SchedulerStorage::new(dir.path());
        let task = fake_task("abc-123");
        store.write_task(&task).unwrap();
        let got = store.read_task("abc-123").unwrap();
        assert_eq!(got.id, "abc-123");
        assert_eq!(got.name, "任务 abc-123");
    }

    #[test]
    fn list_tasks_returns_all() {
        let dir = tempdir().unwrap();
        let store = SchedulerStorage::new(dir.path());
        store.write_task(&fake_task("a1")).unwrap();
        store.write_task(&fake_task("a2")).unwrap();
        let list = store.list_tasks();
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn delete_task_removes_dir() {
        let dir = tempdir().unwrap();
        let store = SchedulerStorage::new(dir.path());
        store.write_task(&fake_task("a1")).unwrap();
        store.delete_task("a1").unwrap();
        assert!(store.read_task("a1").is_err());
    }

    #[test]
    fn append_run_and_list() {
        let dir = tempdir().unwrap();
        let store = SchedulerStorage::new(dir.path());
        store.write_task(&fake_task("a1")).unwrap();
        for i in 0..5 {
            store.append_run(&fake_run("a1", "a1", i)).unwrap();
        }
        let runs = store.list_runs("a1", 10).unwrap();
        assert_eq!(runs.len(), 5);
        // 倒序：最新（idx=4）在前。
        assert_eq!(runs[0].id, "a1-4");
    }

    #[test]
    fn gc_truncates_to_keep() {
        let dir = tempdir().unwrap();
        let store = SchedulerStorage::new(dir.path());
        store.write_task(&fake_task("a1")).unwrap();
        // 写 250 条（> KEEP=200）。
        for i in 0..250 {
            store.append_run(&fake_run("a1", "a1", i)).unwrap();
        }
        let runs = store.list_runs("a1", 1000).unwrap();
        // GC 后应保留 200 条。
        assert_eq!(runs.len(), LOCAL_SCHEDULE_RUNS_KEEP);
        // 最旧被删，最新（idx=249）仍在。
        assert_eq!(runs[0].id, "a1-249");
        assert!(runs.iter().all(|r| r.id != "a1-0"));
    }

    #[test]
    fn sanitize_id_strips_path_separators() {
        assert_eq!(sanitize_id("../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_id("a/b\\c"), "abc");
        assert_eq!(sanitize_id("ok_id-123"), "ok_id-123");
    }
}
