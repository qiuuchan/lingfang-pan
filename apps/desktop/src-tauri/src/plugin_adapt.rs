//! 适配引擎宿主命令（P1-b）。
//!
//! 桌面端 webview 跑在浏览器上下文，用不了 node:fs / node:child_process，
//! 所以适配引擎打成单文件 [`adapt.mjs`](packages/plugin-sdk) 随安装包分发，由本命令用**内置 Node.js**
//! 拉起，把插件目录交给确定性适配引擎做校验 / 改造，并把单行 JSON 报告回传前端。
//!
//! 协议（与 `packages/plugin-sdk/src/adapt/bin.ts` 对齐）：
//! - stdin  ← 一个 JSON 请求（`{ mode, pluginDir, inPlace, execute, repack, outDir, runtime }`）
//! - stdout → 一行 JSON 响应（`{ ok, report? , error? }`），任何情况都可解析
//! - 诊断信息走 stderr，不污染 stdout
//!
//! 安全边界：
//! - `adapt.mjs` 是随应用分发的可信单文件产物，但 `execute` 模式会实际跑**用户插件代码**做运行时确证，
//!   故用 `Builtin` 档位套 Job Object 围栏（进程树隔离 + 资源配额 + UI 限制）；沙箱不可用时降级放行，
//!   不阻断发布流程。
//! - 环境走 `RuntimeResolver::env`：清空宿主 PATH + 注入内置运行时 PATH + 镜像源，
//!   并把解析到的 node/python 绝对路径经协议传给引擎（`runtime` 字段），供 `execute` 确证使用。

use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::process_util::{kill_child_tree, GuardedChild, GuardedCommand, SandboxPolicy, SandboxTier};
use crate::runtime_resolver::RuntimeResolver;

/// adapt.mjs 在 Tauri 资源目录中的固定相对位置（与 `tauri.conf.json` bundle.resources 映射一致）。
fn adapt_script_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法定位应用资源目录：{e}"))?;
    let path = resource_dir.join("adapt").join("adapt.mjs");
    if !path.is_file() {
        return Err(format!(
            "未找到内置适配引擎 adapt.mjs（{}）。安装包可能不完整，请重新安装灵坊工作台。",
            path.display()
        ));
    }
    Ok(path)
}

/// 前端调用参数（camelCase 与 TS 侧一致）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPluginAdaptRequest {
    /// 插件目录（绝对路径）。
    pub plugin_dir: String,
    /// `validate` = 纯静态校验；`adapt` = 跑完整改造流水线。默认 `adapt`。
    #[serde(default = "default_mode")]
    pub mode: String,
    /// 直接改造源目录（默认 false，拷到临时工作区，绝不动用户源码）。
    #[serde(default)]
    pub in_place: bool,
    /// 是否做运行时确证（短跑/冒烟）。
    #[serde(default)]
    pub execute: bool,
    /// 是否改造后重新打包成 .lfplugin。
    #[serde(default)]
    pub repack: bool,
    /// 改造产物输出目录（repack / inPlace 时用）。
    #[serde(default)]
    pub out_dir: Option<String>,
}

fn default_mode() -> String {
    "adapt".to_string()
}

/// 回传前端的适配结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPluginAdaptResponse {
    /// 引擎是否成功产出报告（注意：引擎自身逻辑判定为「需人工」等也属 ok=true）。
    pub ok: bool,
    /// 成功时的 `AdaptationReport`（或 `AdaptResult`）；失败时 None。
    pub report: Option<serde_json::Value>,
    /// 失败时的可读错误（ok=false 时必有）。
    pub error: Option<String>,
}

#[tauri::command]
pub async fn run_plugin_adapt(
    app: tauri::AppHandle,
    request: RunPluginAdaptRequest,
) -> Result<RunPluginAdaptResponse, String> {
    // 适配引擎可能跑数秒到数十秒（execute 确证），offload 到阻塞线程避免卡主线程。
    tauri::async_runtime::spawn_blocking(move || run_plugin_adapt_blocking(&app, &request))
        .await
        .map_err(|join_error| format!("适配任务异常退出：{join_error}"))?
}

fn run_plugin_adapt_blocking(
    app: &tauri::AppHandle,
    request: &RunPluginAdaptRequest,
) -> Result<RunPluginAdaptResponse, String> {
    let resolver = RuntimeResolver::resolve(app)?;
    let node = resolver
        .require_runtime_command("node")
        .map_err(|e| format!("适配引擎需要内置 Node.js：{e}"))?;
    let script = adapt_script_path(app)?;

    let mode = if request.mode == "validate" {
        "validate"
    } else {
        "adapt"
    };

    // 把解析到的内置运行时绝对路径经协议传给引擎，供 `execute` 确证使用。
    let mut runtime = serde_json::Map::new();
    if let Some(node_exe) = resolver.node() {
        runtime.insert(
            "nodeExe".to_string(),
            serde_json::Value::String(node_exe.to_string_lossy().to_string()),
        );
    }
    if let Some(python_exe) = resolver.python() {
        runtime.insert(
            "pythonExe".to_string(),
            serde_json::Value::String(python_exe.to_string_lossy().to_string()),
        );
    }

    let payload = serde_json::json!({
        "mode": mode,
        "pluginDir": request.plugin_dir,
        "inPlace": request.in_place,
        "execute": request.execute,
        "repack": request.repack,
        "outDir": request.out_dir,
        "runtime": serde_json::Value::Object(runtime),
    });

    // Builtin 档位：套 Job Object 围栏；沙箱不可用降级放行（不阻断发布）。
    let GuardedChild { mut child, sandbox } = GuardedCommand::new(
        &node,
        vec![script.to_string_lossy().to_string()],
        SandboxPolicy::plugin_entry(SandboxTier::Builtin),
    )
    .env_exact(resolver.env(vec![]))
    .stdin(Stdio::piped())
    .spawn(|message| eprintln!("[plugin-adapt] {message}"))
    .map_err(|e| format!("启动适配引擎失败：{e}"))?;

    // 进程已 resume（spawn 内部入 Job 后放行），会消费 stdin 管道。请求体很小，同步写不会死锁；
    // 写后 drop stdin 关闭管道，引擎读到 EOF 即开始执行。
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "适配引擎 stdin 不可用".to_string())?;
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|e| format!("写入适配请求失败：{e}"))?;
    }

    let output = wait_with_timeout(child, Duration::from_secs(180))?;
    drop(sandbox);

    let stdout_text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // bin.ts 协议：stdout 只有一行 JSON，且任何情况都输出可解析 JSON（含失败）。
    let line = stdout_text.lines().next().ok_or_else(|| {
        format!(
            "适配引擎未返回任何输出；stderr: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })?;
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|e| format!("解析适配引擎输出失败：{e}；原始输出：{stdout_text}"))?;

    if value.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(RunPluginAdaptResponse {
            ok: true,
            report: value.get("report").cloned(),
            error: None,
        })
    } else {
        let message = value
            .get("error")
            .and_then(|v| v.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("适配失败（无详细错误）")
            .to_string();
        Ok(RunPluginAdaptResponse {
            ok: false,
            report: None,
            error: Some(message),
        })
    }
}

/// 带超时地等待子进程收敛；超时则杀整棵进程树（Job Object 内可能派生出 npm/插件进程）。
/// 直接接收 `child` 所有权：`wait_with_output` 需要 move 出去，超时时也直接对之 kill。
fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let started = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|e| format!("轮询适配引擎状态失败：{e}"))?
        {
            Some(_) => {
                return child
                    .wait_with_output()
                    .map_err(|e| format!("读取适配引擎输出失败：{e}"));
            }
            None => {
                if started.elapsed() > timeout {
                    kill_child_tree(&child);
                    return Err("适配引擎超时（默认 180s），已终止进程树。".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}
