use super::*;
use super::history::tail;

#[derive(Clone)]
struct NoopEventSink;

impl AssistantEventSink for NoopEventSink {
    fn emit_json(&self, _event: &'static str, _payload: serde_json::Value) {}
}

fn temp_assistant_store(name: &str) -> AssistantStore {
    let root = std::env::temp_dir().join(format!(
        "lingfang-code-assistant-test-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    AssistantStore::new(root).expect("assistant store should initialize")
}

mod core;
mod process;
mod scan;
mod summary;
