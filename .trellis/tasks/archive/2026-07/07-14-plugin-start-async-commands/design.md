# Design: 插件启动命令改 async

## 核心思路

把三个同步启动命令改成 `async fn`，命令体内在调用 `start_plugin_from_dir` 时用 `tauri::async_runtime::spawn_blocking` 把整个阻塞流程丢到 tokio 阻塞线程池。`start_plugin_from_dir` 内部已有的 `app.emit(...)`（`plugin:output` / `plugin:start-progress`）从 worker 线程发起，主线程空闲，事件即可实时投递到 webview。

## 为什么只 offload `start_plugin_from_dir`

`start_installed_plugin` 命令体的其它步骤（`selected_release`、`mark_dependency_status`、`activate_pending` / `discard_pending`）都是毫秒级 JSON 文件读写，留在 async 命令体内直接跑即可，不影响响应性。唯一的长时间阻塞点就是 `start_plugin_from_dir`（venv/pip/pnpm/spawn）。

## 改动点

### 1. `PluginProcessTable` 加 `Clone`（`plugin_runner.rs:1064`）

当前只 derive `Default`。内部唯一字段 `inner: Arc<Mutex<...>>`，加 `Clone` 语义正确（clone 共享同一张表，仅 bump Arc 计数）。`spawn_blocking` 需要 `'static + Send`，无法借用 `tauri::State`，必须 clone 出 owned 值 move 进闭包。

```rust
#[derive(Clone, Default)]
pub struct PluginProcessTable { inner: Arc<Mutex<...>> }
```

`PluginLlmBridge` 已 derive `Clone`（`plugin_llm_bridge.rs:50`），无需改动。两者都已在 `std::thread::spawn`（`spawn_exit_watcher`）中使用，故已是 `Send + 'static`，满足 `spawn_blocking` 约束。

### 2. `start_installed_plugin` 改 async（`plugin_package_manager/commands.rs:93`）

```rust
#[tauri::command]
pub(crate) async fn start_installed_plugin(
    app: tauri::AppHandle,
    manager: tauri::State<'_, PluginPackageManager>,
    process_table: tauri::State<'_, PluginProcessTable>,
    bridge: tauri::State<'_, PluginLlmBridge>,
    installation_id: String,
    registry_access_granted: Option<bool>,
    api_base: Option<String>,
    auth_token: Option<String>,
) -> Result<StartPluginResult, String> {
    let (installation, release, is_pending) = manager.selected_release(&installation_id)?;
    // … 访问权校验不变 …
    manager.mark_dependency_status(&installation_id, &release.release_id, DependencyStatus::Preparing)?;

    let app_handle = app.clone();
    let process_table = process_table.inner().clone();
    let bridge = bridge.inner().clone();
    let release_path = PathBuf::from(&release.path);
    let installation_id_for_runner = installation_id.clone();
    let started = tauri::async_runtime::spawn_blocking(move || {
        plugin_runner::start_plugin_from_dir(
            &app_handle, &process_table, &bridge,
            &installation_id_for_runner, release_path, api_base, auth_token,
        )
    })
    .await
    .map_err(|join_err| format!("插件启动任务异常退出：{join_err}"))?;

    match started {
        Ok(result) => { /* mark Ready + activate_pending，与原逻辑一致 */ }
        Err(error) => { /* mark Failed + discard_pending，与原逻辑一致 */ }
    }
}
```

要点：
- `app.clone()`：`AppHandle` 是 cheap clone（内部 Arc），`Send + Sync`。
- `process_table.inner().clone()` / `bridge.inner().clone()`：拿 owned 值，满足闭包 `'static`。
- `spawn_blocking` 返回 `Result<Result<StartPluginResult, String>, JoinError>`：外层 `.await?` 处理 panic/取消，内层再 `match`。
- `manager`（`PluginPackageManager`）不进闭包（只在前置/后置步骤用），避免额外 clone；保持 `tauri::State` 借用即可。

### 3. `start_plugin` 改 async（`plugin_runner.rs:1355`）

同法：`resolve_plugin_dir` 留体内（快），clone `store`/`process_table`/`bridge`，`spawn_blocking` 包 `start_plugin_from_dir`。

注：`start_plugin` 当前从 `store: tauri::State<PluginStore>` 经 `resolve_plugin_dir` 拿 `plugin_dir: PathBuf`（owned），把它 move 进闭包即可；`PluginStore` 本身不需进闭包。

### 4. `start_builtin_plugin` 改 async（`main.rs:54`）

同法：插件目录查找（`state.plugins.iter().find` + `canonicalize`）留体内，clone `process_table`/`bridge`，`spawn_blocking` 包 `start_plugin_from_dir`。

## 前端契约

无需改动。`@tauri-apps/api` 的 `invoke()` 对 sync / async 命令都返回 `Promise<T>`；事件监听（`plugin:output` / `plugin:start-progress` / `plugin:exited`）不变，订阅时机不变（`startPluginCommand` 先 listen 再 invoke）。

## 不改 `start_plugin_from_dir` 本身

该函数签名 `fn start_plugin_from_dir(app: &AppHandle, process_table: &PluginProcessTable, bridge: &PluginLlmBridge, ...)` 保持不变——它本来就是普通同步函数，在 `spawn_blocking` 闭包里调用天然合适。内部 `app.emit` 走 `Emitter` trait（线程安全），从 worker 线程 emit 没问题。reader 线程 / exit watcher 线程也照常 spawn。

## 风险与回滚

- **风险**：`spawn_blocking` 在 tokio 默认阻塞池（上限 512 线程）跑，并发启动多个插件也安全（每个独立线程）。panic 时外层 `.await?` 转 `Err(String)`，不会崩主进程。
- **风险**：`PluginProcessTable` 加 `Clone` 是 ABI 级改动但纯增量（字段未变），无破坏性。
- **回滚**：三处 `async fn` + `spawn_blocking` 包裹可整体 revert 回同步 `fn` 直接调用；`Clone` derive 留着无害。
