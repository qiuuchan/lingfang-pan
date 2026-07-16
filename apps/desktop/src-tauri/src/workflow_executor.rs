use std::collections::HashMap;
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

use crate::plugin_llm_bridge::{PluginBridgeEnv, PluginLlmBridge};
use crate::plugin_package_manager::{InstalledActionBinding, PluginPackageManager};
use crate::plugin_runner::{ensure_node_dependencies, ensure_python_venv, minimal_env};
use crate::process_util::{run_capture_with_env, run_capture_with_env_and_cancel, CapturedOutput};
use crate::runtime_resolver::RuntimeResolver;

#[derive(Default)]
pub(crate) struct WorkflowExecutorState {
    inner: Mutex<Option<ExecutorSession>>,
    leases: Mutex<HashMap<String, String>>,
    claimed: Mutex<HashMap<String, Value>>,
}

#[derive(Clone)]
struct ExecutorSession {
    id: String,
    token: String,
    api_base: String,
    auth_token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct PublicExecutorSession {
    pub id: String,
    pub device_id: String,
    pub inventory_sha256: String,
    pub status: String,
    pub expires_at: String,
    pub last_heartbeat_at: String,
}

#[derive(Deserialize)]
struct CreateResponse {
    session: PublicExecutorSession,
    token: String,
}

fn endpoint(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

async fn response_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("工作流执行器响应无效：{error}"))?;
    if !status.is_success() {
        return Err(value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("工作流执行器请求失败")
            .to_string());
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn workflow_executor_create_session(
    manager: tauri::State<'_, PluginPackageManager>,
    state: tauri::State<'_, WorkflowExecutorState>,
    api_base: String,
    auth_token: String,
) -> Result<PublicExecutorSession, String> {
    let previous = state
        .inner
        .lock()
        .map_err(|_| "工作流执行器状态锁损坏".to_string())?
        .take();
    if let Some(previous) = previous {
        let _ = reqwest::Client::new()
            .post(endpoint(
                &previous.api_base,
                &format!(
                    "/api/workflows/desktop-executor-sessions/{}/revoke",
                    previous.id
                ),
            ))
            .bearer_auth(previous.auth_token.trim())
            .header("x-workflow-executor-token", previous.token)
            .send()
            .await;
    }
    let inventory = manager.executor_inventory()?;
    let device_id = uuid::Uuid::new_v4().to_string();
    let response = reqwest::Client::new()
        .post(endpoint(
            &api_base,
            "/api/workflows/desktop-executor-sessions",
        ))
        .bearer_auth(auth_token.trim())
        .json(&json!({ "device_id": device_id, "inventory": inventory }))
        .send()
        .await
        .map_err(|error| format!("创建工作流执行器 session 失败：{error}"))?;
    let value = response_json(response).await?;
    let created: CreateResponse = serde_json::from_value(value)
        .map_err(|error| format!("工作流执行器 session 响应无效：{error}"))?;
    *state
        .inner
        .lock()
        .map_err(|_| "工作流执行器状态锁损坏".to_string())? = Some(ExecutorSession {
        id: created.session.id.clone(),
        token: created.token,
        api_base,
        auth_token,
    });
    Ok(created.session)
}

#[tauri::command]
pub(crate) async fn workflow_executor_heartbeat(
    manager: tauri::State<'_, PluginPackageManager>,
    state: tauri::State<'_, WorkflowExecutorState>,
) -> Result<PublicExecutorSession, String> {
    let session = state
        .inner
        .lock()
        .map_err(|_| "工作流执行器状态锁损坏".to_string())?
        .clone()
        .ok_or_else(|| "工作流执行器 session 尚未创建".to_string())?;
    let inventory = manager.executor_inventory()?;
    let response = reqwest::Client::new()
        .post(endpoint(
            &session.api_base,
            &format!(
                "/api/workflows/desktop-executor-sessions/{}/heartbeat",
                session.id
            ),
        ))
        .bearer_auth(session.auth_token.trim())
        .header("x-workflow-executor-token", &session.token)
        .json(&json!({ "inventory": inventory }))
        .send()
        .await
        .map_err(|error| format!("工作流执行器 heartbeat 失败：{error}"))?;
    let value = response_json(response).await?;
    serde_json::from_value(value.get("session").cloned().unwrap_or(Value::Null))
        .map_err(|error| format!("工作流执行器 heartbeat 响应无效：{error}"))
}

#[tauri::command]
pub(crate) async fn workflow_executor_revoke(
    state: tauri::State<'_, WorkflowExecutorState>,
) -> Result<(), String> {
    let session = state
        .inner
        .lock()
        .map_err(|_| "工作流执行器状态锁损坏".to_string())?
        .take();
    let Some(session) = session else {
        return Ok(());
    };
    let response = reqwest::Client::new()
        .post(endpoint(
            &session.api_base,
            &format!(
                "/api/workflows/desktop-executor-sessions/{}/revoke",
                session.id
            ),
        ))
        .bearer_auth(session.auth_token.trim())
        .header("x-workflow-executor-token", &session.token)
        .send()
        .await
        .map_err(|error| format!("撤销工作流执行器 session 失败：{error}"))?;
    response_json(response).await.map(|_| ())
}

#[tauri::command]
pub(crate) async fn workflow_executor_start_run(
    state: tauri::State<'_, WorkflowExecutorState>,
    request: Value,
) -> Result<Value, String> {
    let session = state
        .inner
        .lock()
        .map_err(|_| "工作流执行器状态锁损坏".to_string())?
        .clone()
        .ok_or_else(|| "工作流执行器 session 尚未创建".to_string())?;
    let mut body = request
        .as_object()
        .cloned()
        .ok_or_else(|| "工作流运行请求必须是对象".to_string())?;
    body.insert(
        "desktop_executor_session_id".to_string(),
        Value::String(session.id.clone()),
    );
    let response = reqwest::Client::new()
        .post(endpoint(&session.api_base, "/api/workflows/runs"))
        .bearer_auth(session.auth_token.trim())
        .header("x-workflow-executor-token", &session.token)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("启动工作流失败：{error}"))?;
    response_json(response).await
}

#[tauri::command]
pub(crate) async fn workflow_executor_preflight(
    state: tauri::State<'_, WorkflowExecutorState>,
    request: Value,
) -> Result<Value, String> {
    let session = state
        .inner
        .lock()
        .map_err(|_| "工作流执行器状态锁损坏".to_string())?
        .clone()
        .ok_or_else(|| "工作流执行器 session 尚未创建".to_string())?;
    let mut body = request
        .as_object()
        .cloned()
        .ok_or_else(|| "工作流预检请求必须是对象".to_string())?;
    body.insert(
        "desktop_executor_session_id".to_string(),
        Value::String(session.id.clone()),
    );
    let response = reqwest::Client::new()
        .post(endpoint(&session.api_base, "/api/workflows/runs/preflight"))
        .bearer_auth(session.auth_token.trim())
        .header("x-workflow-executor-token", &session.token)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("工作流预检失败：{error}"))?;
    response_json(response).await
}

#[tauri::command]
pub(crate) async fn workflow_executor_claim(
    state: tauri::State<'_, WorkflowExecutorState>,
    run_id: String,
) -> Result<Value, String> {
    let session = state
        .inner
        .lock()
        .map_err(|_| "工作流执行器状态锁损坏".to_string())?
        .clone()
        .ok_or_else(|| "工作流执行器 session 尚未创建".to_string())?;
    let response = reqwest::Client::new()
        .post(endpoint(&session.api_base, "/api/workflows/executor/claim"))
        .bearer_auth(session.auth_token.trim())
        .header("x-workflow-executor-token", &session.token)
        .json(&json!({ "run_id": run_id }))
        .send()
        .await
        .map_err(|error| format!("领取工作流步骤失败：{error}"))?;
    let mut value = response_json(response).await?;
    if let Some(attempt) = value.get_mut("attempt").and_then(Value::as_object_mut) {
        let claimed = Value::Object(attempt.clone());
        let id = attempt
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let token = attempt
            .remove("lease_token")
            .and_then(|value| value.as_str().map(str::to_string));
        if let (Some(id), Some(token)) = (id, token) {
            state
                .leases
                .lock()
                .map_err(|_| "工作流 lease 状态锁损坏".to_string())?
                .insert(id.clone(), token);
            state
                .claimed
                .lock()
                .map_err(|_| "工作流 claim 状态锁损坏".to_string())?
                .insert(id, claimed);
        }
    }
    Ok(value.get("attempt").and_then(Value::as_object).map(|attempt| json!({ "attempt": { "id": attempt.get("id"), "node_id": attempt.get("node_id"), "lease_expires_at": attempt.get("lease_expires_at") } })).unwrap_or_else(|| json!({ "attempt": null })))
}

async fn attempt_request(
    state: &WorkflowExecutorState,
    attempt_id: &str,
    action: &str,
    body: Value,
) -> Result<Value, String> {
    let session = state
        .inner
        .lock()
        .map_err(|_| "工作流执行器状态锁损坏".to_string())?
        .clone()
        .ok_or_else(|| "工作流执行器 session 尚未创建".to_string())?;
    let lease = state
        .leases
        .lock()
        .map_err(|_| "工作流 lease 状态锁损坏".to_string())?
        .get(attempt_id)
        .cloned()
        .ok_or_else(|| "工作流步骤 lease 不存在".to_string())?;
    let response = reqwest::Client::new()
        .post(endpoint(
            &session.api_base,
            &format!("/api/workflows/executor/attempts/{attempt_id}/{action}"),
        ))
        .bearer_auth(session.auth_token.trim())
        .header("x-workflow-executor-token", &session.token)
        .header("x-workflow-attempt-lease-token", lease)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("提交工作流步骤失败：{error}"))?;
    response_json(response).await
}

#[tauri::command]
pub(crate) async fn workflow_executor_attempt_heartbeat(
    state: tauri::State<'_, WorkflowExecutorState>,
    attempt_id: String,
) -> Result<Value, String> {
    attempt_request(state.inner(), &attempt_id, "heartbeat", json!({})).await
}

#[tauri::command]
pub(crate) async fn workflow_executor_complete_attempt(
    state: tauri::State<'_, WorkflowExecutorState>,
    attempt_id: String,
    output: Value,
) -> Result<Value, String> {
    let result = attempt_request(
        state.inner(),
        &attempt_id,
        "complete",
        json!({ "output": output }),
    )
    .await;
    if result.is_ok() {
        state
            .leases
            .lock()
            .map_err(|_| "工作流 lease 状态锁损坏".to_string())?
            .remove(&attempt_id);
    }
    result
}

#[tauri::command]
pub(crate) async fn workflow_executor_fail_attempt(
    state: tauri::State<'_, WorkflowExecutorState>,
    attempt_id: String,
    code: String,
    message: String,
) -> Result<Value, String> {
    let result = attempt_request(
        state.inner(),
        &attempt_id,
        "fail",
        json!({ "code": code, "message": message }),
    )
    .await;
    if result.is_ok() {
        state
            .leases
            .lock()
            .map_err(|_| "工作流 lease 状态锁损坏".to_string())?
            .remove(&attempt_id);
    }
    result
}

const RESULT_MARKER: &str = "__LINGFANG_ACTION_RESULT__";

struct ScratchDir(std::path::PathBuf);

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn capture_action_process(
    binary: &std::path::PathBuf,
    args: Vec<String>,
    workspace: &str,
    timeout_ms: u64,
    env: Vec<(OsString, OsString)>,
    cancel: Option<&AtomicBool>,
) -> Result<CapturedOutput, String> {
    match cancel {
        Some(cancel) => {
            run_capture_with_env_and_cancel(binary, args, Some(workspace), timeout_ms, env, cancel)
        }
        None => run_capture_with_env(binary, args, Some(workspace), timeout_ms, env),
    }
}

fn execute_installed_action_binding(
    resolver: &RuntimeResolver,
    binding: &InstalledActionBinding,
    input: &Value,
    scratch: &std::path::Path,
    bridge_env: Option<&PluginBridgeEnv>,
    cancel: Option<&AtomicBool>,
) -> Result<Value, String> {
    if !matches!(binding.runtime.as_str(), "nodejs" | "python") {
        return Err("action_runtime_unavailable".to_string());
    }
    if !input.is_object() {
        return Err("action_input_invalid:Action input 必须是 JSON 对象".to_string());
    }
    if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("action_cancelled".to_string());
    }

    let _ = std::fs::remove_dir_all(scratch);
    std::fs::create_dir_all(scratch).map_err(|error| error.to_string())?;
    let _scratch = ScratchDir(scratch.to_path_buf());
    let input_path = scratch.join("input.json");
    let input_bytes = serde_json::to_vec(input).map_err(|error| error.to_string())?;
    if input_bytes.len() > 256 * 1024 {
        return Err("action_input_invalid:输入超过 256 KiB".to_string());
    }
    std::fs::write(&input_path, input_bytes).map_err(|error| error.to_string())?;

    let mut process_env = resolver.env(minimal_env());
    if let Some(bridge) = bridge_env {
        process_env.push((
            OsString::from("LINGFANG_PLUGIN_BRIDGE_URL"),
            OsString::from(&bridge.url),
        ));
        process_env.push((
            OsString::from("LINGFANG_PLUGIN_BRIDGE_TOKEN"),
            OsString::from(&bridge.token),
        ));
    }
    let timeout_ms = binding.timeout_seconds.saturating_mul(1000);
    let workspace = binding.release_path.to_string_lossy().to_string();
    let captured = match binding.runtime.as_str() {
        "python" => {
            let wrapper = scratch.join("invoke.py");
            std::fs::write(
                &wrapper,
                r#"import asyncio, contextlib, importlib.util, inspect, json, pathlib, sys
entry, callable_name, input_path = sys.argv[1:4]
async def invoke():
    with contextlib.redirect_stdout(sys.stderr):
        sys.path.insert(0, str(pathlib.Path(entry).parent))
        spec = importlib.util.spec_from_file_location("lingfang_action", entry)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        target = module
        for part in callable_name.split('.'): target = getattr(target, part)
        with open(input_path, 'r', encoding='utf-8') as f: payload = json.load(f)
        result = target(payload)
        if inspect.isawaitable(result): result = await result
        return result
result = asyncio.run(invoke())
sys.stdout.write("__LINGFANG_ACTION_RESULT__" + json.dumps(result, ensure_ascii=False, separators=(',', ':')))
"#,
            )
            .map_err(|error| error.to_string())?;
            let python = ensure_python_venv(resolver, &binding.release_path, None)?;
            capture_action_process(
                &python,
                vec![
                    wrapper.to_string_lossy().to_string(),
                    binding
                        .release_path
                        .join(&binding.entry)
                        .to_string_lossy()
                        .to_string(),
                    binding.callable.clone(),
                    input_path.to_string_lossy().to_string(),
                ],
                &workspace,
                timeout_ms,
                process_env,
                cancel,
            )?
        }
        "nodejs" => {
            ensure_node_dependencies(resolver, &binding.release_path, None)?;
            let wrapper = scratch.join("invoke.mjs");
            std::fs::write(
                &wrapper,
                r#"import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
const [entry, exportName, inputPath] = process.argv.slice(2); console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
const mod = await import(pathToFileURL(entry).href); let target = mod; for (const part of exportName.split('.')) target = target[part];
const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8')); const result = await target(payload);
process.stdout.write('__LINGFANG_ACTION_RESULT__' + JSON.stringify(result));
"#,
            )
            .map_err(|error| error.to_string())?;
            let node = resolver
                .node()
                .ok_or_else(|| "软件内置 Node.js 不可用".to_string())?;
            capture_action_process(
                &node,
                vec![
                    wrapper.to_string_lossy().to_string(),
                    binding
                        .release_path
                        .join(&binding.entry)
                        .to_string_lossy()
                        .to_string(),
                    binding.callable.clone(),
                    input_path.to_string_lossy().to_string(),
                ],
                &workspace,
                timeout_ms,
                process_env,
                cancel,
            )?
        }
        _ => unreachable!("runtime checked before process setup"),
    };

    if captured.cancelled {
        return Err("action_cancelled".to_string());
    }
    if captured.timed_out {
        return Err("action_timeout".to_string());
    }
    if captured.stdout.len() > 256 * 1024 {
        return Err("action_output_invalid:输出超过 256 KiB".to_string());
    }
    if captured.stderr.len() > 1024 * 1024 {
        return Err("action_execution_failed:诊断输出超过 1 MiB".to_string());
    }
    if captured.exit_code != Some(0) {
        return Err(format!(
            "action_execution_failed:{}",
            captured.stderr.chars().take(1000).collect::<String>()
        ));
    }
    let json_text = captured
        .stdout
        .strip_prefix(RESULT_MARKER)
        .ok_or_else(|| "action_execution_failed:Action handler 未返回规范 JSON 结果".to_string())?;
    let output: Value = serde_json::from_str(json_text)
        .map_err(|error| format!("action_output_invalid:Action handler 输出不是 JSON：{error}"))?;
    if !output.is_object() {
        return Err("action_output_invalid:Action handler output 必须是 JSON 对象".to_string());
    }
    Ok(output)
}

pub(crate) fn execute_action_payload(
    app: &tauri::AppHandle,
    manager: &PluginPackageManager,
    target_value: &Value,
    input: &Value,
    execution_id: &str,
    bridge_env: Option<&PluginBridgeEnv>,
) -> Result<Value, String> {
    let target = target_value
        .as_object()
        .ok_or_else(|| "action_contract_mismatch:Action target 无效".to_string())?;
    let field = |name: &str| {
        target
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("工作流步骤 target.{name} 缺失"))
    };
    let binding = manager
        .resolve_action_binding(
            field("package_id")?,
            field("release_id")?,
            field("sha256")?,
            field("action_id")?,
            field("action_contract_version")?,
        )
        .map_err(|error| format!("action_runtime_unavailable:{error}"))?;
    let scratch = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("workflow-executor")
        .join(execution_id);
    let resolver = RuntimeResolver::resolve(app)?;
    execute_installed_action_binding(&resolver, &binding, input, &scratch, bridge_env, None)
}

/// Execute one already-authorized exact local Action for sdk.actions.call.
/// The command never resolves `latest`: PluginPackageManager requires the
/// package/release/sha/action/contract tuple to match the active ledger row.
#[tauri::command]
pub(crate) async fn workflow_executor_execute_action(
    app: tauri::AppHandle,
    manager: tauri::State<'_, PluginPackageManager>,
    bridge: tauri::State<'_, PluginLlmBridge>,
    target: Value,
    input: Value,
    invocation_id: String,
    api_base: String,
    auth_token: String,
) -> Result<Value, String> {
    if !input.is_object() {
        return Err("action_input_invalid:Action input 必须是 JSON 对象".to_string());
    }
    let manager = manager.inner().clone();
    let app_handle = app.clone();
    let execution_id = uuid::Uuid::new_v4().to_string();
    let package_id = target
        .get("package_id")
        .and_then(Value::as_str)
        .unwrap_or("action-plugin")
        .to_string();
    let release_id = target
        .get("release_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let sha256 = target
        .get("sha256")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let bridge_env = bridge.register_action_session(
        &package_id,
        api_base,
        auth_token,
        invocation_id,
        app.clone(),
        manager.clone(),
        package_id.clone(),
        release_id,
        sha256,
        Duration::from_secs(24 * 60 * 60 + 30),
    )?;
    let _bridge_guard = bridge.revoke_on_drop(Some(bridge_env.token.clone()));
    tauri::async_runtime::spawn_blocking(move || {
        execute_action_payload(
            &app_handle,
            &manager,
            &target,
            &input,
            &execution_id,
            Some(&bridge_env),
        )
    })
    .await
    .map_err(|error| format!("action_execution_failed:Action 执行任务异常退出：{error}"))?
}

/// Return the handler source for one exact installed client Action. The native
/// package manager rechecks the active release tuple and confines the handler
/// path before any source crosses into the opaque iframe adapter.
#[tauri::command]
pub(crate) async fn workflow_executor_read_client_action_handler(
    manager: tauri::State<'_, PluginPackageManager>,
    target: Value,
) -> Result<Value, String> {
    let target = target
        .as_object()
        .ok_or_else(|| "action_contract_mismatch:Action target 无效".to_string())?;
    let field = |name: &str| {
        target
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("action_contract_mismatch:Action target.{name} 缺失"))
    };
    let handler = manager
        .resolve_client_action_handler(
            field("package_id")?,
            field("release_id")?,
            field("sha256")?,
            field("action_id")?,
            field("action_contract_version")?,
        )
        .map_err(|error| format!("action_runtime_unavailable:{error}"))?;
    serde_json::to_value(handler).map_err(|error| {
        format!("action_runtime_unavailable:Client Action handler 响应无效：{error}")
    })
}

#[tauri::command]
pub(crate) async fn workflow_executor_execute_attempt(
    app: tauri::AppHandle,
    manager: tauri::State<'_, PluginPackageManager>,
    state: tauri::State<'_, WorkflowExecutorState>,
    bridge: tauri::State<'_, PluginLlmBridge>,
    attempt_id: String,
) -> Result<Value, String> {
    let attempt = state
        .claimed
        .lock()
        .map_err(|_| "工作流 claim 状态锁损坏".to_string())?
        .get(&attempt_id)
        .cloned()
        .ok_or_else(|| "工作流步骤尚未领取".to_string())?;
    let session = state
        .inner
        .lock()
        .map_err(|_| "工作流执行器状态锁损坏".to_string())?
        .clone()
        .ok_or_else(|| "工作流执行器 session 尚未创建".to_string())?;
    let lease = state
        .leases
        .lock()
        .map_err(|_| "工作流 lease 状态锁损坏".to_string())?
        .get(&attempt_id)
        .cloned()
        .ok_or_else(|| "工作流步骤 lease 不存在".to_string())?;
    let target = attempt
        .get("target")
        .cloned()
        .ok_or_else(|| "工作流步骤 target 无效".to_string())?;
    let input = attempt.get("input").cloned().unwrap_or_else(|| json!({}));
    let invocation_id = attempt
        .get("action_invocation_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "工作流步骤 action invocation 缺失".to_string())?
        .to_string();
    let package_id = target
        .get("package_id")
        .and_then(Value::as_str)
        .unwrap_or("action-plugin")
        .to_string();
    let release_id = target
        .get("release_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let sha256 = target
        .get("sha256")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let manager_value = manager.inner().clone();
    let bridge_env = bridge.register_action_session(
        &package_id,
        session.api_base.clone(),
        session.auth_token.clone(),
        invocation_id,
        app.clone(),
        manager_value.clone(),
        package_id.clone(),
        release_id,
        sha256,
        Duration::from_secs(24 * 60 * 60 + 30),
    )?;
    let _bridge_guard = bridge.revoke_on_drop(Some(bridge_env.token.clone()));
    let done = Arc::new(AtomicBool::new(false));
    let done_for_heartbeat = done.clone();
    let heartbeat_attempt = attempt_id.clone();
    let heartbeat = std::thread::spawn(move || {
        while !done_for_heartbeat.load(Ordering::Relaxed) {
            std::thread::park_timeout(Duration::from_secs(10));
            if done_for_heartbeat.load(Ordering::Relaxed) {
                break;
            }
            let _ = reqwest::blocking::Client::new()
                .post(endpoint(
                    &session.api_base,
                    &format!("/api/workflows/executor/attempts/{heartbeat_attempt}/heartbeat"),
                ))
                .bearer_auth(session.auth_token.trim())
                .header("x-workflow-executor-token", &session.token)
                .header("x-workflow-attempt-lease-token", &lease)
                .json(&json!({}))
                .send();
        }
    });
    let manager = manager_value;
    let app_handle = app.clone();
    let execution_id = attempt_id.clone();
    let executed = tauri::async_runtime::spawn_blocking(move || {
        execute_action_payload(
            &app_handle,
            &manager,
            &target,
            &input,
            &execution_id,
            Some(&bridge_env),
        )
    })
    .await
    .map_err(|error| format!("Action 执行任务异常退出：{error}"));
    done.store(true, Ordering::Relaxed);
    heartbeat.thread().unpark();
    let _ = heartbeat.join();
    let output = match executed {
        Err(error) => return Err(error),
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            let code = error
                .split(':')
                .next()
                .unwrap_or("action_execution_failed")
                .to_string();
            let _ = attempt_request(
                state.inner(),
                &attempt_id,
                "fail",
                json!({ "code": code, "message": error }),
            )
            .await;
            state
                .leases
                .lock()
                .map_err(|_| "工作流 lease 状态锁损坏".to_string())?
                .remove(&attempt_id);
            state
                .claimed
                .lock()
                .map_err(|_| "工作流 claim 状态锁损坏".to_string())?
                .remove(&attempt_id);
            return Err("Action 执行失败，工作流步骤已收口".to_string());
        }
    };
    let result = attempt_request(
        state.inner(),
        &attempt_id,
        "complete",
        json!({ "output": output }),
    )
    .await;
    if result.is_ok() {
        state
            .leases
            .lock()
            .map_err(|_| "工作流 lease 状态锁损坏".to_string())?
            .remove(&attempt_id);
        state
            .claimed
            .lock()
            .map_err(|_| "工作流 claim 状态锁损坏".to_string())?
            .remove(&attempt_id);
    }
    result
}

#[cfg(test)]
mod tests;
