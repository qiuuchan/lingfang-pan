use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::adapters::CodeAssistantTool;

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
    // CLI 侧会话 id（仅 claude 真 resume 用到；design §3.3.2）。
    // 本地落盘字段，非云端契约：default 保证旧 sessions.json 可读。
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegisteredAgentProcess {
    pub pid: u32,
    #[serde(alias = "sessionId", rename = "sessionId")]
    pub session_id: String,
    pub tool: CodeAssistantTool,
    pub model: Option<String>,
    #[serde(alias = "workspaceDir", rename = "workspaceDir")]
    pub workspace_dir: String,
    #[serde(alias = "commandPreview", rename = "commandPreview")]
    pub command_preview: Vec<String>,
    #[serde(alias = "registeredAtMs", rename = "registeredAtMs")]
    pub registered_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AgentProcessRegistry {
    version: u8,
    processes: Vec<RegisteredAgentProcess>,
}

impl Default for AgentProcessRegistry {
    fn default() -> Self {
        Self {
            version: 1,
            processes: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegistryCleanupRecord {
    #[serde(alias = "sessionId", rename = "sessionId")]
    pub session_id: String,
    pub pid: u32,
    pub tool: CodeAssistantTool,
    pub killed: bool,
    #[serde(alias = "stillAlive", rename = "stillAlive")]
    pub still_alive: bool,
    #[serde(alias = "commandPreview", rename = "commandPreview")]
    pub command_preview: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct AssistantStore {
    root: PathBuf,
}

impl AssistantStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(root.join("transcripts")).map_err(|error| error.to_string())?;
        // design §3.2.2：草稿分文件存（drafts/{id}.json），与 transcripts 同级。
        fs::create_dir_all(root.join("drafts")).map_err(|error| error.to_string())?;
        Ok(Self { root })
    }

    fn config_path(&self) -> PathBuf {
        self.root.join("config.json")
    }

    fn sessions_path(&self) -> PathBuf {
        self.root.join("sessions.json")
    }

    pub fn registry_path(&self) -> PathBuf {
        self.root
            .join("runtime")
            .join("agent-process-registry.json")
    }

    fn read_registry(&self) -> AgentProcessRegistry {
        read_json(&self.registry_path()).unwrap_or_default()
    }

    fn write_registry(&self, registry: &AgentProcessRegistry) -> Result<(), String> {
        write_json(&self.registry_path(), registry)
    }

    pub fn list_registered_processes(&self) -> Vec<RegisteredAgentProcess> {
        self.read_registry().processes
    }

    pub fn register_process(&self, process: RegisteredAgentProcess) -> Result<(), String> {
        let mut registry = self.read_registry();
        registry
            .processes
            .retain(|item| item.session_id != process.session_id);
        registry.processes.push(process);
        registry
            .processes
            .sort_by(|a, b| b.registered_at_ms.cmp(&a.registered_at_ms));
        self.write_registry(&registry)
    }

    pub fn unregister_process(&self, session_id: &str) -> Result<(), String> {
        let mut registry = self.read_registry();
        registry
            .processes
            .retain(|item| item.session_id != session_id);
        self.write_registry(&registry)
    }

    pub fn cleanup_registered_processes(&self) -> Result<Vec<RegistryCleanupRecord>, String> {
        let processes = self.list_registered_processes();
        if processes.is_empty() {
            return Ok(Vec::new());
        }

        let mut records = Vec::new();
        for process in &processes {
            let killed = kill_process(process.pid, false);
            records.push(RegistryCleanupRecord {
                session_id: process.session_id.clone(),
                pid: process.pid,
                tool: process.tool,
                killed,
                still_alive: process_alive(process.pid),
                command_preview: process.command_preview.clone(),
            });
        }

        thread::sleep(Duration::from_millis(1_000));

        for record in &mut records {
            if process_alive(record.pid) {
                let killed = kill_process(record.pid, true);
                record.killed = record.killed || killed;
                record.still_alive = process_alive(record.pid);
            } else {
                record.still_alive = false;
            }
        }

        let survivors: Vec<RegisteredAgentProcess> = processes
            .into_iter()
            .filter(|process| process_alive(process.pid))
            .collect();
        self.write_registry(&AgentProcessRegistry {
            version: 1,
            processes: survivors,
        })?;
        Ok(records)
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

    /// 捕获到 CLI 侧会话 id（claude stream-json 的 session_id）后回写（design §3.3.2）。
    /// 复用 update_session_exit 的「定位 record 改字段再写」模式；只写非空 id（首轮可能未捕获）。
    pub fn set_cli_session_id(
        &self,
        session_id: &str,
        cli_session_id: &str,
    ) -> Result<(), String> {
        if cli_session_id.trim().is_empty() {
            return Ok(());
        }
        let mut sessions = self.list_sessions();
        if let Some(record) = sessions
            .iter_mut()
            .find(|item| item.session_id == session_id)
        {
            record.cli_session_id = Some(cli_session_id.to_string());
        }
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
        serde_json::from_str::<Value>(&raw).map(Some).map_err(|error| error.to_string())
    }

    /// 写草稿（design §3.2.2）。复用 write_json 同款「建父目录 + 写」模式，
    /// 但写的是前端传入的 Value（保持前后端 PluginDraft schema 解耦）。
    pub fn write_draft(&self, session_id: &str, draft: &Value) -> Result<(), String> {
        let path = self.draft_path(session_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let raw = serde_json::to_string_pretty(draft).map_err(|error| error.to_string())?;
        fs::write(path, raw).map_err(|error| error.to_string())
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

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let group = format!("-{pid}");
        Command::new("kill")
            .arg("-0")
            .arg("--")
            .arg(&group)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
            || Command::new("kill")
                .arg("-0")
                .arg(pid.to_string())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

fn kill_process(pid: u32, force: bool) -> bool {
    #[cfg(unix)]
    {
        let signal = if force { "-KILL" } else { "-TERM" };
        let group = format!("-{pid}");
        let group_killed = Command::new("kill")
            .arg(signal)
            .arg("--")
            .arg(&group)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        let pid_killed = Command::new("kill")
            .arg(signal)
            .arg(pid.to_string())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        group_killed || pid_killed
    }
    #[cfg(windows)]
    {
        let mut args = vec!["/PID".to_string(), pid.to_string(), "/T".to_string()];
        if force {
            args.insert(0, "/F".to_string());
        }
        Command::new("taskkill")
            .args(args)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())
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

    #[test]
    fn registry_registers_and_unregisters_processes() {
        let store = temp_store("registry");
        store
            .register_process(RegisteredAgentProcess {
                pid: 12345,
                session_id: "s1".into(),
                tool: CodeAssistantTool::Codex,
                model: Some("default".into()),
                workspace_dir: "/tmp".into(),
                command_preview: vec!["codex".into(), "exec".into()],
                registered_at_ms: 42,
            })
            .unwrap();
        assert_eq!(store.list_registered_processes().len(), 1);
        assert_eq!(store.list_registered_processes()[0].session_id, "s1");

        store.unregister_process("s1").unwrap();
        assert!(store.list_registered_processes().is_empty());
    }

    // === design §3.3.2：cli_session_id 回写 + 向后兼容 ===

    #[test]
    fn cli_session_id_roundtrip() {
        // 写 sessions → set cli id → 读出字段。
        let store = temp_store("cli-id");
        store
            .upsert_session(SessionRecord {
                session_id: "s1".into(),
                tool: CodeAssistantTool::Claude,
                model: Some("sonnet".into()),
                workspace_dir: "/tmp".into(),
                status: "running".into(),
                transcript_path: "/tmp/t.jsonl".into(),
                command_preview: vec!["claude".into()],
                pid: Some(123),
                started_at: "1".into(),
                ended_at: None,
                exit_code: None,
                cli_session_id: None,
                title: None,
                archived: None,
                draft_updated_at: None,
            })
            .unwrap();
        store.set_cli_session_id("s1", "claude-sid-abc").unwrap();
        let record = store
            .list_sessions()
            .into_iter()
            .find(|r| r.session_id == "s1")
            .unwrap();
        assert_eq!(record.cli_session_id.as_deref(), Some("claude-sid-abc"));
    }

    #[test]
    fn cli_session_id_empty_is_noop() {
        // 空字符串不写（防误覆盖）。
        let store = temp_store("cli-id-empty");
        store
            .upsert_session(SessionRecord {
                session_id: "s2".into(),
                tool: CodeAssistantTool::Claude,
                model: None,
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
            })
            .unwrap();
        store.set_cli_session_id("s2", "  ").unwrap();
        let record = store
            .list_sessions()
            .into_iter()
            .find(|r| r.session_id == "s2")
            .unwrap();
        assert_eq!(record.cli_session_id, None);
    }

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
        let record: SessionRecord = serde_json::from_str(legacy).expect("旧 sessions.json 应可反序列化");
        assert_eq!(record.session_id, "legacy-1");
        assert_eq!(record.title, None);
        assert_eq!(record.archived, None);
        assert_eq!(record.draft_updated_at, None);
        assert_eq!(record.cli_session_id, None);
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
        store
            .write_draft("del-1", &json!({ "files": [] }))
            .unwrap();
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
