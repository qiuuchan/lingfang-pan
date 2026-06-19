use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
// 安全修复 H2：file_lock 是 code-assistant 子系统的会话存储串行化锁，
// poison 后所有 upsert_session/append_transcript/update_session_exit 均会 panic，
// 会话永久卡死。容忍 poison（与 code_assistant.rs 同模式），数据仍有效。
// 注：let _guard = ... 模式下 guard 生命周期到当前块末尾，转换不影响释放语义。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::lock_or_recover;

use super::types::CodeAssistantTool;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CodeAssistantConfig {
    #[serde(alias = "defaultTool", rename = "defaultTool")]
    pub default_tool: Option<CodeAssistantTool>,
    #[serde(alias = "defaultModel", rename = "defaultModel")]
    pub default_model: Option<String>,
    #[serde(alias = "workspaceDir", rename = "workspaceDir")]
    pub workspace_dir: Option<String>,
}

impl Default for CodeAssistantConfig {
    fn default() -> Self {
        Self {
            default_tool: None,
            default_model: None,
            workspace_dir: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionRecord {
    #[serde(alias = "sessionId", rename = "sessionId")]
    pub session_id: String,
    pub tool: CodeAssistantTool,
    pub model: Option<String>,
    #[serde(alias = "workspaceDir", rename = "workspaceDir")]
    pub workspace_dir: String,
    pub status: String,
    #[serde(alias = "transcriptPath", rename = "transcriptPath")]
    pub transcript_path: String,
    #[serde(alias = "commandPreview", rename = "commandPreview")]
    pub command_preview: Vec<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(alias = "startedAt", rename = "startedAt")]
    pub started_at: String,
    #[serde(alias = "endedAt", rename = "endedAt")]
    pub ended_at: Option<String>,
    #[serde(alias = "exitCode", rename = "exitCode")]
    pub exit_code: Option<i32>,
    // 旧 CLI 侧会话 id。SDK runtime 不再写入，仅保留字段保证旧 sessions.json 可读。
    #[serde(default, alias = "cliSessionId", rename = "cliSessionId")]
    pub cli_session_id: Option<String>,
    // 会话展示标题（design §3.2.1）：首启可从 transcript 首 input 懒回填；用户重命名时落盘。
    // 本地落盘字段，default 保证旧 sessions.json 可读。
    #[serde(default, alias = "title", rename = "title")]
    pub title: Option<String>,
    // 归档/软删标记（design §3.2.1）：会话栏折叠归档区，不参与默认列表。
    // 本地落盘字段，default 保证旧 sessions.json 可读。
    #[serde(default, alias = "archived", rename = "archived")]
    pub archived: Option<bool>,
    // 草稿最后更新时间（design §3.2.1）：会话栏排序依据，ISO 字符串。
    // 本地落盘字段，default 保证旧 sessions.json 可读。
    #[serde(default, alias = "draftUpdatedAt", rename = "draftUpdatedAt")]
    pub draft_updated_at: Option<String>,
    // 本地账号隔离字段。旧 sessions.json 无字段时为 None，前端会隐藏无 owner 的旧记录，
    // 避免同机切换账号后继续看到上一账号的创建器聊天。
    #[serde(default, alias = "ownerUserId", rename = "ownerUserId")]
    pub owner_user_id: Option<String>,
    #[serde(default, alias = "ownerTenantId", rename = "ownerTenantId")]
    pub owner_tenant_id: Option<String>,
}

// 修复 RUSTSHIM-01 / RUSTSHIM-03 / SPAWN-03 / RUST-STREAM-03（并发根因）：
// 此前 AssistantStore 仅是 root: PathBuf 的 Clone 包装，无任何锁。upsert_session /
// update_session_exit / rename_session / touch_draft_updated_at / append_transcript
// 全是非原子 read-modify-write（write_json 裸 fs::write 覆盖）。
// 多线程并发写同一 sessions.json / {id}.jsonl 会丢失更新甚至撕裂 JSONL 行。
// 修复策略：AssistantStore 内嵌 Mutex<()> 序列化所有 sessions.json 的读-改-写，
// 并对 transcript 追加也走该锁（per-store 单写）；write_json 改为 tmp+rename 原子替换。
// 因 AssistantStore 需 Clone（CodeAssistantState 持有副本语义），用 Arc<Mutex<()>> 共享。
#[derive(Clone, Debug)]
pub struct AssistantStore {
    root: PathBuf,
    file_lock: Arc<Mutex<()>>,
}

impl AssistantStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(root.join("transcripts")).map_err(|error| error.to_string())?;
        // design §3.2.2：草稿分文件存（drafts/{id}.json），与 transcripts 同级。
        fs::create_dir_all(root.join("drafts")).map_err(|error| error.to_string())?;
        Ok(Self {
            root,
            file_lock: Arc::new(Mutex::new(())),
        })
    }

    fn config_path(&self) -> PathBuf {
        self.root.join("config.json")
    }

    /// 数据根目录（app_data_dir/code-assistant），供 sandbox 等派生路径使用。
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    fn sessions_path(&self) -> PathBuf {
        self.root.join("sessions.json")
    }

    pub fn transcript_path(&self, session_id: &str) -> PathBuf {
        self.root
            .join("transcripts")
            .join(format!("{session_id}.jsonl"))
    }

    pub fn read_config(&self) -> CodeAssistantConfig {
        read_json(&self.config_path()).unwrap_or_default()
    }

    pub fn write_config(&self, config: &CodeAssistantConfig) -> Result<(), String> {
        write_json(&self.config_path(), config)
    }

    pub fn list_sessions(&self) -> Vec<SessionRecord> {
        read_json(&self.sessions_path()).unwrap_or_default()
    }

    pub fn upsert_session(&self, record: SessionRecord) -> Result<(), String> {
        // 修复 RUSTSHIM-01 / RUST-STREAM-03：sessions.json 的读-改-写必须串行化，
        // 否则 waiter 写 exit 状态会被 send_input 的 upsert(status=running) 覆盖，
        // 导致会话卡 running、前端 activeExited 守卫据此阻止追问，多轮锁死。
        let _guard = lock_or_recover(&self.file_lock);
        let mut sessions = self.list_sessions();
        if let Some(existing) = sessions
            .iter_mut()
            .find(|item| item.session_id == record.session_id)
        {
            *existing = record;
        } else {
            sessions.push(record);
        }
        sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        write_json(&self.sessions_path(), &sessions)
    }

    pub fn update_session_exit(
        &self,
        session_id: &str,
        status: &str,
        exit_code: Option<i32>,
        ended_at: String,
    ) -> Result<(), String> {
        // 修复 RUSTSHIM-01 / RUST-STREAM-03：update_session_exit 是退出终态，
        // 必须在 file_lock 内执行，避免并发写覆盖。
        let _guard = lock_or_recover(&self.file_lock);
        let mut sessions = self.list_sessions();
        if let Some(record) = sessions
            .iter_mut()
            .find(|item| item.session_id == session_id)
        {
            record.status = status.to_string();
            record.exit_code = exit_code;
            record.ended_at = Some(ended_at);
        }
        write_json(&self.sessions_path(), &sessions)
    }

    pub fn update_session_workspace_dir(
        &self,
        session_id: &str,
        workspace_dir: &str,
    ) -> Result<(), String> {
        let _guard = lock_or_recover(&self.file_lock);
        let mut sessions = self.list_sessions();
        let record = sessions
            .iter_mut()
            .find(|item| item.session_id == session_id)
            .ok_or_else(|| format!("session 不存在：{session_id}"))?;
        record.workspace_dir = workspace_dir.to_string();
        write_json(&self.sessions_path(), &sessions)
    }

    /// 重命名会话标题（design §3.2.3）并同步刷新草稿更新时间（会话栏排序依据）。
    /// 复用「定位 record 改字段再写」模式；未找到记录返回错误，不静默吞掉。
    pub fn rename_session(
        &self,
        session_id: &str,
        title: &str,
        draft_updated_at: String,
    ) -> Result<SessionRecord, String> {
        // 修复 RUSTSHIM-01：rename_session 也是 sessions.json 的 RMW，必须串行化。
        let _guard = lock_or_recover(&self.file_lock);
        let mut sessions = self.list_sessions();
        let record = sessions
            .iter_mut()
            .find(|item| item.session_id == session_id)
            .ok_or_else(|| format!("session 不存在：{session_id}"))?;
        record.title = Some(title.to_string());
        record.draft_updated_at = Some(draft_updated_at);
        let updated = record.clone();
        write_json(&self.sessions_path(), &sessions)?;
        Ok(updated)
    }

    /// 仅更新草稿更新时间（design §3.2.3 save_draft 调用）。
    /// 复用「定位 record 改字段再写」模式；未找到记录返回错误。
    pub fn touch_draft_updated_at(
        &self,
        session_id: &str,
        draft_updated_at: String,
    ) -> Result<(), String> {
        // 修复 RUSTSHIM-01：touch_draft_updated_at 也是 sessions.json 的 RMW，必须串行化。
        let _guard = lock_or_recover(&self.file_lock);
        let mut sessions = self.list_sessions();
        let record = sessions
            .iter_mut()
            .find(|item| item.session_id == session_id)
            .ok_or_else(|| format!("session 不存在：{session_id}"))?;
        record.draft_updated_at = Some(draft_updated_at);
        write_json(&self.sessions_path(), &sessions)
    }

    pub fn append_transcript(
        &self,
        session_id: &str,
        event: &str,
        payload: Value,
    ) -> Result<PathBuf, String> {
        // 修复 SPAWN-03：append_transcript 用 OpenOptions::append + writeln! 写一行，无锁。
        // spawn_and_attach 对同一 session 启动 stdout + stderr 两个 reader 线程，
        // 并发写同一 {id}.jsonl，writeln! 经 write_all 拆多次 write() 会撕裂 JSONL 行。
        // 用 file_lock 序列化追加（per-store 单写），与 sessions.json 共用同一把锁
        // （粒度足够：写盘是微秒级，reader 主瓶颈是 read_line 解析）。
        let _guard = lock_or_recover(&self.file_lock);
        let path = self.transcript_path(session_id);
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        let line = json!({
            "at": now_string(),
            "event": event,
            "payload": payload,
        });
        writeln!(file, "{line}").map_err(|error| error.to_string())?;
        Ok(path)
    }

    pub fn read_transcript(&self, session_id: &str) -> Result<String, String> {
        fs::read_to_string(self.transcript_path(session_id)).map_err(|error| error.to_string())
    }

    // === design §3.2.2：草稿分文件存取 + 会话删除 ===

    /// 草稿目录：root/drafts（AssistantStore::new 时已建）。
    fn drafts_dir(&self) -> PathBuf {
        self.root.join("drafts")
    }

    /// 草稿文件路径：drafts/{session_id}.json。
    /// draft 以 serde_json::Value 透传（前后端约定 PluginDraft 形态，Rust 不解析其定义），
    /// 与 append_transcript 的 payload: Value 同模式，保持前后端 schema 解耦。
    fn draft_path(&self, session_id: &str) -> PathBuf {
        self.drafts_dir().join(format!("{session_id}.json"))
    }

    /// 读取草稿原文（design §3.2.2）。文件不存在返回 Ok(None)，读失败映射错误字符串。
    pub fn read_draft(&self, session_id: &str) -> Result<Option<Value>, String> {
        let path = self.draft_path(session_id);
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        serde_json::from_str::<Value>(&raw)
            .map(Some)
            .map_err(|error| error.to_string())
    }

    /// 写草稿（design §3.2.2）。复用 write_json 同款「建父目录 + 写」模式，
    /// 但写的是前端传入的 Value（保持前后端 PluginDraft schema 解耦）。
    pub fn write_draft(&self, session_id: &str, draft: &Value) -> Result<(), String> {
        // 修复 RUSTSHIM-01：drafts/{id}.json 单文件写入用原子 tmp+rename（write_json_atomically）。
        let path = self.draft_path(session_id);
        write_json_atomically(&path, draft)
    }

    /// 删除单个草稿文件（design §3.2.2）。文件不存在视为已删，忽略错误（幂等）。
    pub fn delete_draft(&self, session_id: &str) -> Result<(), String> {
        let _ = fs::remove_file(self.draft_path(session_id));
        Ok(())
    }

    /// 删除会话（design §3.2.2，清三处）：
    /// sessions.json 记录 + transcripts/{id}.jsonl + drafts/{id}.json。
    /// 后两处不存在不报错（幂等，允许半删状态收尾）。
    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        // 修复 RUSTSHIM-01：delete_session 也是 sessions.json 的 RMW，必须串行化。
        let _guard = lock_or_recover(&self.file_lock);
        let mut sessions = self.list_sessions();
        sessions.retain(|item| item.session_id != session_id);
        sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        write_json(&self.sessions_path(), &sessions)?;
        let _ = fs::remove_file(self.transcript_path(session_id));
        // 复用 delete_draft（幂等删草稿文件），避免重复内联删除逻辑（DRY）。
        self.delete_draft(session_id)?;
        Ok(())
    }
}

pub fn now_string() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}Z", now.as_secs(), now.subsec_millis())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

// 修复 RUSTSHIM-01：write_json 用裸 fs::write(path, raw)（open+truncate+write），
// 并发交叉下读到半截内容会损坏 JSON。改成 tmp 文件全量写完后 rename 原子替换：
// rename 在同文件系统内是 POSIX 原子语义，Windows MoveFileEx 也是原子替换。
// 所有 write_json 调用都在 file_lock 内，原子替换是第二道防线（双保险）。
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    write_json_atomically(path, value)
}

/// 原子写 JSON：写到同目录临时文件，再 rename 替换目标。
/// 同目录保证 tmp 与目标在同文件系统（rename 原子语义的前提）。
/// tmp 文件名带 pid + 纳秒时间戳，避免并发写者互相覆盖 tmp。
fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "目标路径无父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let raw = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let tmp_name = format!(
        ".tmp-{}-{}-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    let tmp_path = parent.join(&tmp_name);
    // 写 tmp 文件：失败则清理 tmp 避免残留。
    if let Err(error) = fs::write(&tmp_path, &raw) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error.to_string());
    }
    // 原子替换：rename 在 Unix 同文件系统内是原子操作；Windows 上 persist(true) 走 MoveFileEx。
    if let Err(error) = persist_rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    Ok(())
}

/// 跨平台原子 rename（覆盖目标），返回字符串错误便于上层透传。
/// Unix：fs::rename 在同文件系统内是 POSIX 原子语义，已覆盖目标。
/// Windows：fs::rename 不覆盖已存在目标，需 MoveFileExW 带 MOVEFILE_REPLACE_EXISTING。
fn persist_rename(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::rename(from, to).map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        // MoveFileExW 带 MOVEFILE_REPLACE_EXISTING (0x1) + MOVEFILE_WRITE_THROUGH (0x8)。
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
        let from_wide: Vec<u16> = from
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let to_wide: Vec<u16> = to
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        extern "system" {
            fn MoveFileExW(
                lpexistingfilename: *const u16,
                lpnewfilename: *const u16,
                dwflags: u32,
            ) -> i32;
        }
        unsafe {
            let ok = MoveFileExW(
                from_wide.as_ptr(),
                to_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            );
            if ok == 0 {
                Err(std::io::Error::last_os_error().to_string())
            } else {
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(name: &str) -> AssistantStore {
        let root = std::env::temp_dir().join(format!(
            "lingfang-assistant-store-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        AssistantStore::new(root).unwrap()
    }

    #[test]
    fn config_roundtrip() {
        let store = temp_store("config");
        let config = CodeAssistantConfig {
            default_tool: Some(CodeAssistantTool::Claude),
            default_model: Some("sonnet".into()),
            workspace_dir: Some("/tmp".into()),
        };
        store.write_config(&config).unwrap();
        assert_eq!(store.read_config().default_model.as_deref(), Some("sonnet"));
    }

    // === SDK 迁移：cli_session_id 字段只作旧 sessions.json 兼容读取 ===

    // === design §3.2.1/§3.2.2/§8.1：新字段向后兼容 + 草稿存取 + 会话删除 ===

    fn sample_session(session_id: &str) -> SessionRecord {
        SessionRecord {
            session_id: session_id.into(),
            tool: CodeAssistantTool::Claude,
            model: Some("sonnet".into()),
            workspace_dir: "/tmp".into(),
            status: "running".into(),
            transcript_path: "/tmp/t.jsonl".into(),
            command_preview: vec!["claude".into()],
            pid: None,
            started_at: "1".into(),
            ended_at: None,
            exit_code: None,
            cli_session_id: None,
            title: None,
            archived: None,
            draft_updated_at: None,
            owner_user_id: None,
            owner_tenant_id: None,
        }
    }

    #[test]
    fn session_record_new_fields_default_none() {
        // design §6.1：旧 sessions.json 无 title/archived/draftUpdatedAt 字段时反序列化为 None，保证向后兼容。
        let legacy = r#"{
            "sessionId": "legacy-1",
            "tool": "claude",
            "workspaceDir": "/tmp",
            "status": "exited",
            "transcriptPath": "/tmp/legacy.jsonl",
            "commandPreview": ["claude"],
            "startedAt": "1"
        }"#;
        let record: SessionRecord =
            serde_json::from_str(legacy).expect("旧 sessions.json 应可反序列化");
        assert_eq!(record.session_id, "legacy-1");
        assert_eq!(record.title, None);
        assert_eq!(record.archived, None);
        assert_eq!(record.draft_updated_at, None);
        assert_eq!(record.cli_session_id, None);
        assert_eq!(record.owner_user_id, None);
        assert_eq!(record.owner_tenant_id, None);
    }

    #[test]
    fn session_record_owner_fields_roundtrip() {
        let mut session = sample_session("owner-1");
        session.owner_user_id = Some("user-1".into());
        session.owner_tenant_id = Some("team-1".into());

        let raw = serde_json::to_string(&session).unwrap();
        assert!(raw.contains("ownerUserId"));
        assert!(raw.contains("ownerTenantId"));
        let parsed: SessionRecord = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.owner_user_id.as_deref(), Some("user-1"));
        assert_eq!(parsed.owner_tenant_id.as_deref(), Some("team-1"));
    }

    #[test]
    fn update_session_workspace_dir_persists_new_path() {
        let store = temp_store("workspace-update");
        store.upsert_session(sample_session("workspace-1")).unwrap();

        store
            .update_session_workspace_dir("workspace-1", "O:/plugins/final-plugin")
            .unwrap();

        let record = store
            .list_sessions()
            .into_iter()
            .find(|item| item.session_id == "workspace-1")
            .unwrap();
        assert_eq!(record.workspace_dir, "O:/plugins/final-plugin");
    }

    #[test]
    fn session_record_title_roundtrip() {
        // 新字段写入再读出保持一致（含 alias/ rename 序列化名 title）。
        let store = temp_store("title-roundtrip");
        let mut record = sample_session("title-1");
        record.title = Some("番茄钟插件".into());
        record.archived = Some(false);
        record.draft_updated_at = Some("123.456Z".into());
        store.upsert_session(record).unwrap();
        let raw = fs::read_to_string(store.sessions_path()).unwrap();
        assert!(
            raw.contains("\"title\""),
            "sessions.json 应含 title 字段: {raw}"
        );
        let record = store
            .list_sessions()
            .into_iter()
            .find(|r| r.session_id == "title-1")
            .unwrap();
        assert_eq!(record.title.as_deref(), Some("番茄钟插件"));
        assert_eq!(record.archived, Some(false));
        assert_eq!(record.draft_updated_at.as_deref(), Some("123.456Z"));
    }

    #[test]
    fn draft_write_read_roundtrip() {
        // design §3.2.2：write_draft → read_draft 内容一致；不存在返回 None。
        let store = temp_store("draft-roundtrip");
        // 不存在时返回 None。
        assert!(store.read_draft("none-1").unwrap().is_none());
        // 写入后读出一致（透传 Value，Rust 不感知 PluginDraft 内部结构）。
        let draft = json!({
            "id": "d1",
            "files": [{ "path": "manifest.json", "content": "{}" }],
            "turns": [{ "role": "user", "content": "你好" }],
            "status": "ready"
        });
        store.write_draft("d1", &draft).unwrap();
        let got = store.read_draft("d1").unwrap().expect("草稿应存在");
        assert_eq!(got, draft);
    }

    #[test]
    fn draft_overwrite_and_delete() {
        // design §3.2.2：覆盖写 + delete_draft 幂等（不存在不报错）。
        let store = temp_store("draft-overwrite");
        store.write_draft("d2", &json!({ "v": 1 })).unwrap();
        store.write_draft("d2", &json!({ "v": 2 })).unwrap();
        let got = store.read_draft("d2").unwrap().expect("草稿应存在");
        assert_eq!(got["v"], json!(2));
        store.delete_draft("d2").unwrap();
        assert!(store.read_draft("d2").unwrap().is_none());
        // 再次删除不报错（幂等）。
        store.delete_draft("d2").unwrap();
    }

    #[test]
    fn delete_session_removes_all_three() {
        // design §3.2.2 + 硬性要求：delete_session 清 sessions 记录 + transcript + draft 三处。
        let store = temp_store("delete-session");
        store.upsert_session(sample_session("del-1")).unwrap();
        // transcript 文件需真实存在以验证被删（upsert 的 transcript_path 是占位路径，这里用真实路径写一条事件）。
        store
            .append_transcript("del-1", "input", json!({ "prompt": "你好" }))
            .unwrap();
        store.write_draft("del-1", &json!({ "files": [] })).unwrap();
        // 三个产物都存在。
        assert!(store.transcript_path("del-1").exists());
        assert!(store.draft_path("del-1").exists());
        assert!(store
            .list_sessions()
            .iter()
            .any(|r| r.session_id == "del-1"));
        // 删除。
        store.delete_session("del-1").unwrap();
        // sessions 记录已移除。
        assert!(!store
            .list_sessions()
            .iter()
            .any(|r| r.session_id == "del-1"));
        // transcript + draft 文件已删（幂等：不存在不报错）。
        assert!(!store.transcript_path("del-1").exists());
        assert!(!store.draft_path("del-1").exists());
    }

    #[test]
    fn delete_session_idempotent_for_missing_artifacts() {
        // design §3.2.2：transcript/draft 不存在时 delete_session 不报错（半删状态可收尾）。
        let store = temp_store("delete-session-missing");
        store.upsert_session(sample_session("del-2")).unwrap();
        // 未写 transcript/draft，直接删 sessions 记录。
        store.delete_session("del-2").unwrap();
        assert!(!store
            .list_sessions()
            .iter()
            .any(|r| r.session_id == "del-2"));
    }
}
