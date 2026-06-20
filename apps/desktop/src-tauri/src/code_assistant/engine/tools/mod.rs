mod copy;
mod paths;
mod read;
mod schema;
mod shell;

use std::path::PathBuf;

use serde_json::{json, Value};

pub use schema::{anthropic_tool_definitions, openai_tool_definitions};

use self::copy::import_local_project;
use self::paths::{resolve_workspace_read_path, resolve_workspace_write_path};
use self::read::{list_directory, read_file, scan_workspace, search_local_files};
use self::shell::run_command;

pub struct LocalToolExecutor {
    workspace: PathBuf,
    runtime_root: Option<PathBuf>,
}

impl LocalToolExecutor {
    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace,
            runtime_root: None,
        }
    }

    pub fn with_runtime_root(workspace: PathBuf, runtime_root: Option<PathBuf>) -> Self {
        Self {
            workspace,
            runtime_root,
        }
    }

    pub fn list_directory(&self, path: &str) -> Result<Value, String> {
        list_directory(&resolve_workspace_read_path(&self.workspace, path)?, path)
    }

    pub fn read_file(&self, path: &str) -> Result<Value, String> {
        read_file(&resolve_workspace_read_path(&self.workspace, path)?, path)
    }

    pub fn write_file(&self, path: &str, content: &str) -> Result<(), String> {
        let target = resolve_workspace_write_path(&self.workspace, path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(target, content).map_err(|error| error.to_string())
    }

    pub fn scan_workspace(&self) -> Result<Value, String> {
        scan_workspace(&self.workspace)
    }

    pub fn execute(&self, name: &str, arguments: &Value) -> Value {
        match self.try_execute(name, arguments) {
            Ok(value) => json!({ "ok": true, "result": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        }
    }

    fn try_execute(&self, name: &str, arguments: &Value) -> Result<Value, String> {
        match name {
            "list_directory" => self.list_directory(string_arg(arguments, "path")?),
            "read_file" => self.read_file(string_arg(arguments, "path")?),
            "write_file" => {
                self.write_file(
                    string_arg(arguments, "path")?,
                    string_arg(arguments, "content")?,
                )?;
                Ok(json!({ "written": true }))
            }
            "scan_workspace" => self.scan_workspace(),
            "list_local_directory" => read::list_local_directory(string_arg(arguments, "path")?),
            "read_local_file" => read::read_local_file(
                string_arg(arguments, "path")?,
                optional_u64_arg(arguments, "max_bytes")?,
            ),
            "search_local_files" => search_local_files(
                string_arg(arguments, "path")?,
                string_arg(arguments, "query")?,
            ),
            "import_local_project" => import_local_project(
                &self.workspace,
                string_arg(arguments, "source_path")?,
                optional_string_arg(arguments, "destination"),
            ),
            "run_command" => run_command(
                &self.workspace,
                self.runtime_root.as_deref(),
                string_arg(arguments, "command")?,
                string_array_arg(arguments, "args")?,
                optional_string_arg(arguments, "cwd"),
            ),
            other => Err(format!("未知本地工具：{other}")),
        }
    }
}

fn string_arg<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, String> {
    arguments
        .get(key)
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("工具参数缺少 {key}"))
}

fn optional_string_arg<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments.get(key).and_then(|value| value.as_str())
}

fn optional_u64_arg(arguments: &Value, key: &str) -> Result<Option<u64>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("工具参数 {key} 必须是正整数")),
    }
}

fn string_array_arg(arguments: &Value, key: &str) -> Result<Vec<String>, String> {
    let Some(value) = arguments.get(key) else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err(format!("工具参数 {key} 必须是字符串数组"));
    };
    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(ToString::to_string)
                .ok_or_else(|| format!("工具参数 {key} 只能包含字符串"))
        })
        .collect()
}

#[cfg(test)]
mod tests;
