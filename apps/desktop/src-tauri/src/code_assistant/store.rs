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
}
