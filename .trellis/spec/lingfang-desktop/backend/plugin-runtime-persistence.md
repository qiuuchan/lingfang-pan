# Plugin Runtime & Persistence

插件持久化运行架构（task 06-16-plugin-system-rebuild 重构成果）。与 [plugin-loading.md](./plugin-loading.md) 区分：后者讲**内置插件**加载（builtin-plugins 目录 + manifest 解析 + capability 注册），本篇讲**用户/AI 创建的插件**的持久化目录、运行时（venv/pnpm）、进程管理与命名链路。

## 持久化目录布局

每个插件独立文件夹，根目录可配置（默认 `app_data/plugins/`）：

```
<plugins_root>/
├── .lingfang/config.json        # plugins_root 路径配置（锚点，改根目录后仍可定位 config）
├── <plugin_id>/                  # 单个插件（plugin_id 经 sanitize_plugin_id 白名单校验）
│   ├── manifest.json             # { id, name, title(用户命名), runtime_type, entry, ... }
│   ├── main.py / index.js / ui/index.html   # 入口（按 runtime_type 分流）
│   ├── data/                     # 运行数据持久化子目录（框架 ensure_plugin_dir 自动创建）
│   ├── .venv/                    # 非 Windows Python 插件 venv；Windows venv 在短路径缓存
│   └── node_modules/             # 仅 Node 插件（pnpm install 产物）
```

- `plugin_id` 仅允许 `[A-Za-z0-9_-]`（`sanitize_plugin_id`），防 `../` 越出 plugins_root、防隐藏段、防中文目录名。中文用户名经前端 `safePluginId` 转 base36 ASCII 后才作 plugin_id。
- `ensure_plugin_dir` 建插件目录时**一并创建 `data/` 子目录**（不依赖插件作者自觉 mkdir），子进程 cwd = 插件目录，插件可经相对路径 `data/xxx` 读写。

Reference files:
- `apps/desktop/src-tauri/src/plugin_store.rs`（`plugin_dir` / `ensure_plugin_dir` / `sanitize_plugin_id` / `plugins_root` / `set_plugins_root`）
- `apps/desktop/src/pages/settings/PluginsTab.tsx`（设置页路径配置 UI）

## 三种运行时分流

| runtime_type | 入口 | 运行方式 | UI |
|---|---|---|---|
| `client`（HTML） | `ui/index.html` | 软件内 iframe（opaque origin 沙盒） | 「打开」按钮 |
| `python` | `main.py` | 软件内置 Python 创建的独立 venv 进程（GUI 自弹窗口） | 「运行」/「停止」+ 状态 |
| `nodejs` | `package.json` scripts.start | 软件内置 pnpm/npm start 独立进程 | 「运行」/「停止」+ 状态 |

- 前端运行分流必须通过共享解析器读取运行时，优先级为 `plugin.manifest.runtime_type/runtimeType` → `plugin.files[].manifest.json` → `plugin.runtime_type` → `client`。不要让列表层的旧默认值 `client` 覆盖 manifest 里的 `python`/`nodejs`。
- **Python**：`ensure_python_venv` 检测 `python_venv_dir(plugin_dir)` → 不存在则用软件内置 `runtimes/python` 创建 venv（300s）→ 有 `requirements.txt` 则 `venv/.../pip install -r`（600s，幂等，清华 PyPI 镜像）→ `venv` 内 Python `-u main.py`。Windows 的 venv 不放插件目录，改放 `%LOCALAPPDATA%/LingFang/python-venvs/venv-<stable_path_hash>`，避免 PySide6 等深层 wheel 在默认 Roaming 插件目录下触发 260 字符路径限制。
- **Node**：`ensure_node_dependencies` 有 `package.json` + 非空依赖 + `node_modules` 缺失 → 软件内置 `runtimes/nodejs` 下的 `pnpm install`，缺 pnpm 时回退内置 `npm install`（600s，npmmirror）→ 内置 `pnpm start` / `npm start`，无 package 脚本时内置 `node entry`。
- **HTML**：`read_local_plugin_file` 读取 entry HTML → iframe srcDoc 渲染。iframe 去 `allow-same-origin` 形成 opaque origin，防越权访问 parent.__TAURI__/localStorage。

### Scenario: Builtin Script Plugins Use Manifest Runtime And Dedicated Start Command

#### 1. Scope / Trigger
- Trigger: changing builtin plugin manifest parsing, `LoadedPlugin` serialization, team plugin runtime dispatch, `ScriptPreviewPanel`, or Tauri `start_plugin` command wrappers.

#### 2. Signatures
- Rust loaded plugin field: `plugins::LoadedPlugin.runtime_type: String`
- Tauri command: `start_builtin_plugin(plugin_id, api_base?, auth_token?) -> StartPluginResult`
- Shared frontend resolver: `resolvePluginRuntime(plugin) -> 'client' | 'nodejs' | 'python' | 'cloud'`
- Local plugin command remains: `start_plugin(plugin_id, api_base?, auth_token?) -> StartPluginResult`

#### 3. Contracts
- `plugins::parse_manifest` must export `manifest.runtime_type` for builtin plugins; missing runtime defaults to `client`.
- Frontend runtime dispatch must call `resolvePluginRuntime(plugin)` rather than reading `plugin.runtime_type || 'client'` inline.
- `resolvePluginRuntime` priority is manifest object, then `files` manifest.json, then top-level `runtime_type`, then `client`.
- Python/Node builtin plugins must render `ScriptPreviewPanel` and start through `start_builtin_plugin`; HTML/client plugins render iframe.
- `start_builtin_plugin` locates the directory from `AppState.plugins` and then reuses the same `start_plugin_from_dir` spawn/dependency/bridge path as local plugins.
- Builtin ids may contain dots, such as `builtin.ai-python-example`; they must not be routed through `PluginStore::plugin_dir` or `sanitize_plugin_id`.

#### 4. Validation & Error Matrix
- builtin plugin id not found in `AppState.plugins` -> `内置插件不存在: <id>`.
- builtin plugin dir cannot canonicalize -> `内置插件目录不可用：...`.
- builtin manifest has `runtime_type=client` but caller invokes script start -> `manifest runtime_type 不支持独立进程运行`.
- database/team script plugin has no package files and is not builtin -> frontend shows install/run guidance instead of rendering source text.

#### 5. Good/Base/Bad Cases
- Good: builtin manifest `{ runtime_type: "python", entry: "main.py" }` shows the script launch panel and starts via `start_builtin_plugin`.
- Base: builtin manifest without `runtime_type` is treated as `client` and opens iframe.
- Bad: top-level `runtime_type: "client"` from a stale list payload overrides `files/manifest.json` with `runtime_type: "python"`; this renders `main.py` source in an iframe.
- Bad: builtin script id `builtin.foo` is passed to `start_plugin`, fails local id validation, or points at `plugins_root/builtin.foo` instead of `builtin-plugins/foo`.

#### 6. Tests Required
- Rust unit: `plugins::tests::parse_manifest_exports_runtime_type`.
- Frontend unit: `resolvePluginRuntime` keeps manifest object/files ahead of stale top-level `runtime_type`.
- Full checks when this path changes: `cargo test -p lingfang-desktop`, `pnpm -C apps/desktop test`, `pnpm -C apps/desktop typecheck`, `pnpm -C apps/desktop vite:build`.

#### 7. Wrong vs Correct

Wrong:
```typescript
const runtime = plugin.runtime_type || 'client';
await startPlugin(plugin.id);
```

Correct:
```typescript
const runtime = resolvePluginRuntime(plugin);
const start = plugin.builtin ? startBuiltinPlugin : startPlugin;
```

### Scenario: Bundled-Only Windows Runtime Boundary

#### 1. Scope / Trigger
- Trigger: changing `runtime_resolver`, runtime status, plugin preview/start/shell, dependency installation, Playwright support, runtime assets, or Tauri bundle resources.

#### 2. Signatures
- `RuntimeResolver::resolve(app) -> Result<RuntimeResolver, String>`
- `probe_script_runtime(app, runtime: ScriptRuntime) -> Result<ProbeResult, String>`
- `run_plugin_script(app, input) -> Result<RunResult, String>`
- `start_plugin(app, store, process_table, plugin_id) -> Result<StartPluginResult, String>`
- `run_plugin_shell(app, store, input) -> Result<ShellResult, String>`
- `get_runtime_status(app) -> Result<{python,node,ffmpeg,chromium}, String>`

#### 3. Contracts
- Windows x64 runtime assets are ordinary Git files under `apps/desktop/runtimes/`; do not use Git LFS or build-time downloads. Files above Gitee's 100 MB object limit are committed as fixed parts under `apps/desktop/runtime-parts/` and materialized atomically before development or packaging; installers must not copy the parts directory.
- Tauri resources and the custom SFX both map that exact directory to installed `runtimes/`.
- Layout: `python/python.exe`, `python/Scripts/pip.cmd`, `nodejs/node.exe`, `nodejs/npm.cmd`, `nodejs/pnpm.cmd`, `ffmpeg/{ffmpeg,ffprobe}.exe`, and `chromium/ms-playwright/{chromium,chromium_headless_shell}-1228/...`.
- `runtime-lock.json` owns versions, key-file sizes, SHA256, and any `materializedFiles` part lists. `scripts/materialize-bundled-runtimes.mjs` reconstructs those files offline; `scripts/verify-bundled-runtimes.mjs` verifies the result and the installed Playwright package version/revision before every release build.
- Resolver priority is `LINGFANG_EMBEDDED_RUNTIME_DIR` (tests) -> exe sibling -> Tauri resource dir -> debug repository dir. No user config, downloaded runtime directory, or system PATH participates.
- Preview, persistent start, builtin script start, creator execution, dependency installation, and Agent shell all use `RuntimeResolver`.
- `python_venv_dir(plugin_dir)` must return `<plugin_dir>/.venv` on non-Windows and `%LOCALAPPDATA%/LingFang/python-venvs/venv-<stable_path_hash>` on Windows; the hash is derived from the normalized plugin path so the same plugin reuses the same short venv.
- Python venv creation must verify pip after `python -m venv`; if standard `venv`/`ensurepip` fails or leaves no pip, retry with embedded `python -m venv --without-pip` and bootstrap pip via embedded `python -m pip --python <venv-python> install --no-index --find-links <embedded-pip-wheel-dir> --upgrade pip`.
- Embedded pip wheel discovery must prefer `runtimes/python/Lib/ensurepip/_bundled/pip-*.whl` and may fall back to `runtimes/python/pip-*.whl` for older packaged layouts; it must not download pip or use host Python.
- `resolve_runtime_command` maps Python/pip/uv, Node/npm/pnpm, FFmpeg, and `chrome|chromium` to bundled absolute paths only.
- Child env replaces host PATH with bundled runtime/plugin-local directories plus required Windows system directories and injects `PLAYWRIGHT_BROWSERS_PATH=<bundled>/chromium/ms-playwright` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.
- `ensure_playwright_browsers` validates both full Chromium and headless shell at revision 1228; it never invokes Playwright install. Agent shell rejects commands containing `playwright install`.

#### 4. Validation & Error Matrix
- missing/modified key file -> runtime verifier fails the build with the relative path.
- missing Python/Node -> status is unavailable and preview/start says the installation is incomplete; host installations remain ignored.
- missing full Chromium or headless shell revision -> Playwright plugin start fails with a reinstall/incompatible revision error; never download a replacement.
- Playwright package version/revision differs from `runtime-lock.json` -> verifier fails before frontend/release build.
- Agent shell requests `playwright install ...` -> reject before starting a shell process.
- embedded Python `ensurepip` fails while creating venv -> remove the partial venv directory, create a `--without-pip` venv, install pip from bundled wheel with embedded `pip --python`, then continue requirements install through the venv Python.
- Windows plugin path is deep and `requirements.txt` contains PySide6 -> venv path must stay under `%LOCALAPPDATA%/LingFang/python-venvs/...`; do not require users to enable system Long Path support.
- embedded Python cannot find any bundled `pip-*.whl` during fallback -> fail explicitly with a packaging error; do not fetch pip from the network.
- dependency install needs network -> pip/npm/pnpm use fixed application child-process mirrors; browser binaries are never dependency downloads.

#### 5. Good/Base/Bad Cases
- Good: a clean Windows machine runs Python, Node, FFmpeg, and Playwright Chromium from installed `runtimes/` while offline.
- Base: a Node plugin without package dependencies runs embedded `node entry`.
- Bad: settings offers download/system probe/custom path controls, creating a second runtime truth source.
- Bad: code assistant runs `playwright install chromium`, writing a user-cache or mutating installed browser payload.
- Bad: venv creation retries with host `python -m ensurepip` or downloads pip from PyPI; this breaks the embedded runtime boundary and China mirror contract.

#### 6. Tests Required
- `runtime_resolver::tests::runtime_commands_are_detected_by_name`
- `runtime_resolver::tests::chromium_command_and_playwright_env_use_bundled_root`
- `runtime_commands::tests::missing_runtime_is_read_only_packaging_error`
- `plugin_runner::tests::bundled_pip_wheel_dir_prefers_ensurepip_bundled`
- `plugin_runner::tests::bundled_pip_wheel_dir_falls_back_to_python_root`
- `plugin_runner::tests::playwright_requires_bundled_full_and_headless_revision`
- `plugin_shell::tests::blocks_playwright_browser_install_commands`
- `plugin_script::tests::install_hint_covers_both_runtimes`
- `pnpm -C apps/desktop runtime:verify`, Rust tests, frontend tests/typecheck/build.

#### 7. Wrong vs Correct

Wrong:
```rust
Command::new("python").args(args).spawn()?;
Command::new("playwright").args(["install", "chromium"]).spawn()?;
```

Correct:
```rust
let runtime = RuntimeResolver::resolve(&app)?;
let binary = runtime.require_runtime_command("python")?;
run_capture_with_env(&binary, args, None, 5_000, runtime.env(minimal_env()))?;
```

Reference files:
- `apps/desktop/src-tauri/src/plugin_runner.rs`（`start_plugin` / `stop_plugin` / `ensure_python_venv` / `ensure_node_dependencies`）
- `apps/desktop/src/pages/Plugins.tsx`（runtime 分流 + RunnerBody iframe）

## 独立进程管理

`start_plugin` detached spawn（`Stdio::null` 不捕获 stdout 进 UI；GUI 插件自弹窗口）：
- Unix：`pre_exec` 调 `setsid()` 建独立进程组。
- Windows：`CREATE_NEW_PROCESS_GROUP`。
- `env_clear()` + 白名单 env（防泄漏宿主 token/密钥到插件进程）。
- 子进程 cwd = 插件目录（让插件能读写自身 `data/` 相对路径）。

进程表 `PluginProcessTable`（`Arc<Mutex<HashMap<plugin_id, Child>>>`）记录 Child 句柄 + pid + started_at。**不落 DB**——重启后所有插件从文件系统重判 ready。`stop_plugin` 取出 Child → `kill_child_tree`（进程组/树 kill）→ `wait` 回收。

### Scenario: Windows Process Tree Stop Uses Win32 APIs

#### 1. Scope / Trigger
- Trigger: changing `kill_child_tree`, `stop_plugin`, preview execution timeout cleanup, or tests that assert plugin process cleanup speed.

#### 2. Signatures
- `kill_child_tree(child: &std::process::Child)`
- `stop_plugin(process_table, plugin_id) -> Result<(), String>`
- `run_captured_inner(..., timeout_ms, ...) -> Result<CapturedOutput, String>`

#### 3. Contracts
- Windows process cleanup must not shell out to `taskkill`; it must enumerate child processes with ToolHelp and terminate via Win32 `TerminateProcess`.
- Child processes must be terminated before the root process so inherited stdout/stderr pipe handles close promptly.
- Unix keeps process-group semantics via `setsid` + `kill -TERM/-KILL -<pgid>`.

#### 4. Validation & Error Matrix
- direct child still alive after stop -> `process_table_stop_plugin_kills_running_process` must fail under the time assertion.
- grandchild keeps stdout/stderr pipe open after preview timeout -> `timeout_kills_grandchild_process_tree` must fail or exceed 5 seconds.
- missing process handle / already exited process -> best-effort terminate returns; caller `wait` remains the observable cleanup point.

#### 5. Good/Base/Bad Cases
- Good: Windows Node plugin `node -e "setInterval(...)"` stops in under 3 seconds.
- Base: Unix long-running `sleep` process stops through the process group and `wait` returns.
- Bad: `taskkill /F /PID <pid> /T` can block for roughly 60 seconds on Windows console-process chains, making tests and plugin stop sluggish.

#### 6. Tests Required
- `plugin_runner::tests::process_table_stop_plugin_kills_running_process` asserts stop latency under 3 seconds.
- `plugin_script::tests::timeout_kills_infinite_loop` asserts preview timeout returns promptly.
- `plugin_script::tests::timeout_kills_grandchild_process_tree` asserts grandchildren holding inherited pipes are terminated.

#### 7. Wrong vs Correct

Wrong:
```rust
Command::new("taskkill").args(["/F", "/PID", &pid.to_string(), "/T"]).status();
```

Correct:
```rust
let child_pids = windows_child_pids(pid);
for child_pid in child_pids {
    kill_process_tree_windows(child_pid);
}
terminate_windows_process(pid);
```

启动阶段事件：`start_plugin` 在 `checking → deps_installing（按需）→ starting` 三阶段 emit `plugin:start-progress` 事件（`PluginStartProgress` payload），前端据此渲染分阶段进度动画。`needs_python_venv` / `needs_node_install` 探测是否真需装依赖，仅首次慢启动发安装阶段。

Reference files:
- `apps/desktop/src-tauri/src/plugin_runner.rs`
- `apps/desktop/src/lib/plugin-status.ts`（`startPlugin` 的 `onProgress` 回调订阅事件）
- `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx`（`StartProgressView` 分阶段动画）

## 状态动态判定（不存 DB）

`scan_plugin_status` 命令扫文件系统 + 合并进程表：

| 状态 | 判定 |
|---|---|
| `ready` | manifest 合法 + 入口文件存在 |
| `incomplete` | 缺 manifest 或入口文件 |
| `error` | manifest JSON 非法 / 缺 id/name |
| `running` | 进程表命中（`try_wait` 未退出） |
| `stopped` | 进程已退出（表项清除，重启后回 ready） |

`scan_one_plugin` 是纯文件系统逻辑（便于单测），`scan_plugin_status` 命令层合并 `process_table.is_running` 叠加 running 态。

Reference files:
- `apps/desktop/src-tauri/src/plugin_store.rs`（`scan_one_plugin` / `list_plugins` / `scan_plugin_status`）

### Scenario: Local Plugin Identity Uses Directory Name

#### 1. Scope / Trigger
- Trigger: changing `scan_one_plugin`, local plugin deletion/start/read commands, or upload rename behavior.

#### 2. Signatures
- `scan_one_plugin(dir: &Path, plugin_id: &str) -> PluginMeta`
- `PluginMeta.id: String`
- Local file-system commands take `plugin_id` and resolve `plugins_root/<plugin_id>/`.

#### 3. Contracts
- `PluginMeta.id` must be the directory name passed as `plugin_id`, not `manifest.json.id`.
- `manifest.json.id` remains required for manifest validity, but it is a declaration field only.
- User upload rename can make directory `plugin_id` differ from manifest `id`; this is valid.

#### 4. Validation & Error Matrix
- manifest missing `id` or `name` -> `PluginStatus::Error`, but returned `PluginMeta.id` still equals directory `plugin_id`.
- manifest `id` differs from directory name -> `PluginStatus::Ready` if entry exists, returned `PluginMeta.id` equals directory name.
- invalid directory name -> skipped before `scan_one_plugin` via `sanitize_plugin_id`.

#### 5. Good/Base/Bad Cases
- Good: directory `ai-image`, manifest `id=ai-image-studio` -> UI actions use `ai-image`.
- Base: directory and manifest id both `my-clock` -> UI actions use `my-clock`.
- Bad: returning manifest `id` makes local delete/read/start target the wrong directory and can look successful while leaving files behind.

#### 6. Tests Required
- `plugin_store::tests::scan_id_uses_dir_name_not_manifest_id`
- `plugin_store::tests::rename_and_title_writes_title_and_renames_dir`

#### 7. Wrong vs Correct

Wrong:
```rust
PluginMeta { id: manifest_id.to_string(), ... }
```

Correct:
```rust
PluginMeta { id: plugin_id.to_string(), ... }
```

## 用户命名链路（AC1）

插件名由用户在上传时命名（不自动取 manifest.name）：

1. 创建期：`startNewSession` 从 Rust 返回的 `workspaceDir`（`plugins_root/<temp_id>/`）提取 plugin_id。
2. 上传时：`doUpload` 弹命名 Dialog → `safePluginId(name)` 转正式目录名 → `rename_plugin_dir(oldId, newId, title=name)` 改目录名 + 把用户名写入 `manifest.title`。
3. rename 成功后必须同步两处引用：
   - 当前草稿 `plugin_id = renamedId`，并立即 `code_assistant_save_draft` 落盘；
   - 当前会话 `SessionRecord.workspaceDir = plugins_root/<renamedId>`，经 `code_assistant_update_workspace` 写回 `sessions.json`。
4. 展示：`scan_one_plugin` 的 `name = title ?? name_field ?? plugin_id`（title 优先）。
5. 草稿携带 `plugin_id` 落盘，切历史会话据此恢复 pluginId（状态走文件系统扫描）。

`rename_and_title`（`plugin_store.rs`）是 `rename_plugin_dir` 命令的底层方法（抽出为方法便于单测）：rename 目录 + 解析 manifest JSON 写入 title 字段（保留其他字段）。

Reference files:
- `apps/desktop/src-tauri/src/plugin_store.rs`（`rename_and_title`）
- `apps/desktop/src-tauri/src/code_assistant/store.rs`（`update_session_workspace_dir`）
- `apps/desktop/src/pages/PluginCreatorHome.tsx`（`doUpload` / `startNewSession`）
- `apps/desktop/src/pages/plugin-creator/hooks.ts`（rename 后同步草稿与会话 workspace）
- `apps/desktop/src/lib/plugin-draft.ts`（`parseManifest` 解析 title / `defaultEntryForRuntime`）

### Scenario: Upload Rename Must Update Draft And Workspace

#### 1. Scope / Trigger
- Trigger: changing upload naming, `rename_plugin_dir`, creator draft persistence, `code_assistant_send_input`, or session workspace storage.

#### 2. Signatures
- Tauri command: `rename_plugin_dir(old_id, new_id, title?) -> renamedId`
- Tauri command: `code_assistant_update_workspace({ sessionId, workspaceDir }) -> Result<(), String>`
- Store method: `AssistantStore::update_session_workspace_dir(session_id, workspace_dir)`
- Frontend helpers: `draftWithPluginId(draft, pluginId)`, `pluginWorkspaceDir(pluginsRoot, pluginId)`

#### 3. Contracts
- Directory rename changes the canonical local plugin identity. All future local actions must use the renamed directory id.
- After rename succeeds, frontend must update current draft `plugin_id` and save it before considering upload synchronized.
- After rename succeeds, frontend must update the Rust session `workspaceDir`; `send_input` uses `SessionRecord.workspace_dir` for the next SDK turn's tool workspace.
- If active session or current draft is missing after a successful rename, fail the upload path explicitly instead of continuing with stale references.

#### 4. Validation & Error Matrix
- `rename_plugin_dir` succeeds but `code_assistant_save_draft` fails -> upload fails; stale draft is not accepted.
- `rename_plugin_dir` succeeds but `code_assistant_update_workspace` fails -> upload fails; follow-up AI writes must not continue to the old temp directory.
- missing active session id after rename -> error `当前会话不存在`.
- missing current draft after rename -> error `当前草稿不存在`.

#### 5. Good/Base/Bad Cases
- Good: temp directory `temp-1` renamed to `timer`; draft `plugin_id` becomes `timer`; session `workspaceDir` becomes `plugins_root/timer`; follow-up AI edits `timer`.
- Base: safe plugin id equals old id; no rename occurs, so no reference rewrite is required.
- Bad: only `pluginIdRef.current` is changed in memory; saved draft still has `temp-1`, and `send_input` still writes to the old workspace path.

#### 6. Tests Required
- Frontend unit: `upload-sync.spec.ts` asserts renamed draft id and workspace path construction.
- Rust unit: `update_session_workspace_dir_persists_new_path` asserts `sessions.json` workspace path updates.
- Full checks: `pnpm -C apps/desktop test`, `pnpm -C apps/desktop typecheck`, `cargo test -p lingfang-desktop`.

#### 7. Wrong vs Correct
Wrong:
```typescript
const renamed = await tauriInvoke<string>('rename_plugin_dir', { oldId, newId, title });
pluginIdRef.current = renamed;
```

Correct:
```typescript
const renamed = await tauriInvoke<string>('rename_plugin_dir', { oldId, newId, title });
const draft = requireRenamedDraft(currentDraft, renamed);
await saveDraft(activeSessionId, JSON.stringify(draft));
await updateConversationWorkspace(activeSessionId, pluginWorkspaceDir(await getPluginsRoot(), renamed));
```

## 入口按 runtime_type 分流

manifest 的 `entry` 字段缺失时，按 `runtime_type` 回退（**不写死 `ui/index.html`**）：

- `python` → `main.py`
- `nodejs` → `index.js`
- `client` / 未知 → `ui/index.html`

`defaultEntryForRuntime` + `buildFallbackEntryFile`（生成对应骨架：python main.py / nodejs index.js / client HTML）。5 处 entry 回退（`buildLocalDraft` / `finalizeFromSandbox` / `mergeFollowup` / `mergeFollowupFromSandbox` / `parseManifest`）统一走此分流。

Reference file:
- `apps/desktop/src/lib/plugin-draft.ts`

## AI 生成写入持久化目录（AC10）

`code_assistant_start_session`（`main.rs`）把 workspace 强制落到插件持久化目录：
- 有 `plugin_id` → `plugin_store.ensure_plugin_dir` → 注入 `input.workspace_dir`。
- 无 `plugin_id` → 用 `temp-<timestamp>-<nanos>` 作临时 plugin_id → `ensure_plugin_dir` → 持久化目录（不再是 `claude-sandbox` 临时目录）。

AI（ClaudeCode/Codex SDK Runtime）只能通过本地工具写文件。`write_file` 的 workspace = `plugins_root/<id>/`，产出直接落持久化目录；工具拒绝绝对路径、`..`、空段和隐藏段。

## system-prompt 传递（SDK Runtime）

`start_session` / `send_input` 仍接收 `system_prompt`，但不再拼命令行参数。ClaudeCodeEngine 把它放进 Anthropic Messages API 的 `system` 字段；CodexEngine 把它作为 OpenAI-compatible Chat Completions 的首条 `system` message。追问不再依赖 CLI resume id，统一从 transcript/history 重建上下文。

Reference files:
- `apps/desktop/src-tauri/src/code_assistant/engine/runtime.rs`（`claude_messages` / `openai_messages`）
- `apps/desktop/src-tauri/src/code_assistant/engine/anthropic.rs` / `openai.rs`（SDK request body）
- `apps/desktop/src/lib/plugin-creator-protocol.ts`（`DEFAULT_CONVERSATION_SYSTEM_PROMPT` 三种 runtime 开发规范）

## 预览执行 vs 持久化运行

两条运行通道：
- **`run_plugin_script`（预览执行）**：创建期一次性 sandbox 执行，软件内置 `node <entry>` / `python <entry>`，捕获 stdout 进 UI，15s 超时。适合验证简单脚本。**对需专属运行时的插件（如 Electron，`scripts.start=electron .`）不适用**——`needs_runtime_start` 预检拦截并提示用持久化运行。
- **`start_plugin`（持久化运行）**：detached 独立进程，内置 `pnpm/npm install` + `pnpm/npm start`，不捕获 stdout。创建器的 `ScriptPreviewPanel` 透传 `pluginId` 后走此通道（`usePersistent = Boolean(pluginId)`），让 Electron 等框架插件在创建期也能拉起。

Reference files:
- `apps/desktop/src-tauri/src/plugin_script.rs`（`run_plugin_script` / `needs_runtime_start`）
- `apps/desktop/src/components/creator/PreviewDrawer.tsx` / `PreviewPanel.tsx`（透传 pluginId）

## 安全边界

持久化运行通道是**不受控执行通道**，绕过 capability 网关（`capability.rs` 的声明式白名单面向「插件运行态受控能力调用」，与「开发者主动运行自己刚生成的脚本」语义不同）：
- 软隔离：`sanitize_plugin_id` 段级白名单、路径不穿越 plugins_root、env 白名单、超时 kill（仅预览）、stdin=null。
- 可逃逸：用户权限运行的脚本可执行 `fs.writeFile` / `child_process` / 网络请求（与本地直接 `node main.js` 等价风险）。
- 后续独立大任务（TODO）：OS 级硬隔离（Windows AppContainer / Linux bubblewrap / macOS sandbox-exec）+ 新增 `script.node` / `script.python` capability kind，让本通道也走声明式授权。

## temp 目录残留清理 + manifest 缺失友好处理（2026-06-17）

创建期无 plugin_id 时用 `temp-<secs>-<nanos>` 建目录（main.rs），AI 会话失败/中断会留下空 temp 目录（无 manifest）。重启后草稿恢复 pluginId=temp-xxx 指向空目录，点运行报 os error 2「预览执行无法启动」。三层兜底：

1. **启动清理空 temp 目录**（`plugin_store.rs` `PluginStore::new` 调 `cleanup_empty_temp_dirs`）：扫 `plugins_root/temp-*`，`read_dir().count()==0` 的用 `remove_dir`（非 `remove_dir_all`，只删空目录）删，错误忽略。files≥1 无 manifest 的 temp 保留（可能有产出，由前端引导）。
2. **manifest 缺失友好错误**（`plugin_runner.rs` `parse_manifest`）：读 manifest 文件 `NotFound` 时返回 `manifest_missing:<引导文案>` 前缀（与 `interpreter_missing:` 同款前缀约定），前端 `ScriptPreviewPanel.handleStart` catch 该前缀 → `toCreatorError('manifest_missing')` 显示「插件未生成完成，继续对话补全」，而非裸 os error 2。
3. **前端草稿恢复预防**（`ScriptPreviewPanel.syncRunState`）：持久化模式下 scan_plugin_status 返回 `incomplete`/`error` → `pluginIncomplete=true` → 禁用运行按钮 + ErrorBubble 引导。复用 PluginCreatorHome 已有的 scan useEffect（pluginId 变化即扫文件系统状态）。

前缀约定：Rust 错误字符串用 `<code>:<人类可读>` 前缀（`interpreter_missing:` / `manifest_missing:`），前端 `startsWith` 识别后映射到 CreatorErrorKind，与 `creator-error.ts` 的 kind 表对齐。

Reference files:
- `apps/desktop/src-tauri/src/plugin_store.rs`（`cleanup_empty_temp_dirs`）
- `apps/desktop/src-tauri/src/plugin_runner.rs`（`parse_manifest` 的 `manifest_missing:` 分支）
- `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx`（`pluginIncomplete` + `manifest_missing:` catch）
- `apps/desktop/src/lib/creator-error.ts`（`manifest_missing` kind）

## 插件删除（本地 + 云端分层，2026-06-17）

删除插件分本地与云端两层，分层治理（保护已购买/安装用户）：

- **本地删除**（`plugin_runner.rs` `delete_plugin` 命令，纯逻辑 `delete_plugin_dir` 便于单测）：`sanitize_plugin_id` 防穿越 → 若进程表在运行先 take+kill_child_tree+wait（防文件占用）→ `remove_dir_all(plugin_dir)`。仅删 `plugins_root/<id>/`，不删 builtin（builtin-plugins 不在 plugins_root）、不删云端记录。目录不存在幂等 Ok。
- **作者删云端**（`DELETE /api/plugins/:id`，`plugin.service.deleteByAuthor`）：`ensurePluginManager` 作者校验 + **仅 marketplace=false 可删**（已上架抛 conflict「先联系管理员下架」）。级联删 PluginInstallation（onDelete: Cascade 自动）。
- **admin 删云端**（`DELETE /api/admin/plugins/:id`，`admin.service.adminDeletePlugin`）：ensurePlatformAdmin + 删任意（含已上架）+ 级联删 Installation + Purchase + Review（Cascade）+ 审计 `admin.plugin.deleted`。

**治理边界**：作者只能删未上架的（草稿/驳回/团队内），已上架的走 admin 下架（delist，软退市）后 admin 删。admin 可物理删任意（兜底，二次确认 + 审计，级联清购买记录——已确认接受）。

**前端入口**：
- 桌面 Plugins.tsx 本地插件项「删除」按钮 → deletePlugin（本地）。
- 桌面 PluginList.tsx 作者插件（source==='team'）「删除」按钮 → DELETE /api/plugins/:id → 成功后 deletePlugin 清本地。
- admin plugins-view「删除插件」按钮 → DELETE /api/admin/plugins/:id。

Reference files:
- `apps/desktop/src-tauri/src/plugin_runner.rs`（`delete_plugin` / `delete_plugin_dir`）
- `apps/desktop/src/lib/plugin-status.ts`（`deletePlugin` 封装）
- `apps/collab-api/src/modules/plugin.service.ts`（`deleteByAuthor`）
- `apps/collab-api/src/modules/admin.service.ts`（`adminDeletePlugin`）
- `apps/collab-api/src/modules/plugins.controller.ts` + `admin.controller.ts`（DELETE 端点）

## 修改已有插件 + 聊天引用插件（2026-06-17）

### A 修改已有插件：落盘云端 files 后进创建器

`editInGenerator`（Plugins.tsx）「继续修改」时，先把云端 `plugin.files` 落盘到 `plugins_root/<plugin.id>/`（`write_plugin_files` 命令），再 `setCurrentDraft` + `setView('home')` 跳创建器。AI 进 `start_session` 时 workspace=该目录（已落盘 files），用 Read 工具看到现有代码并改（而非重新生成）。改完走已有 `edit-draft` 端点覆盖。

`write_plugin_files`（`plugin_store.rs`，与 `read_local_plugin_file` 对称的写操作）：
- `write_files` 方法：`ensure_plugin_dir` → 逐文件 path 白名单（拒 `..`/绝对路径/盘符 `:`）→ `fs::write` + 建子目录。
- 幂等覆盖同名文件。`PluginFileInput { path, content }` 入参。
- 安全：path 段级白名单防穿越（写时文件不存在，不能用 read 的 canonicalize+starts_with，改校验段不含 `..` + 非绝对 + join 后父目录 canonicalize 校验）。

### B 聊天引用插件：@触发 + manifest 摘要拼 prompt

创建器 Composer Textarea 输入 `@` 触发下拉（mentionablePlugins：team + 本地插件合并），选中后：
- input 插入 `@<name>` 标记 + `attachedPlugins` 加该插件（id/name/summary）。
- Textarea 上方 chip 展示已引用（可移除）。
- send 时 attachedPlugins 非空 → prompt 前拼 `[引用插件参考] - name（manifest 摘要） [/引用插件参考]`，让 AI 参考被引用插件。限 5 个，每轮独立（send 后清空）。

manifest 摘要（`pluginManifestSummary`）：从 plugin.files 找 manifest.json 解析 `runtime_type/entry/capabilities`。team 从 files 解析，本地从 scan 的 manifest 字段。

Reference files:
- `apps/desktop/src-tauri/src/plugin_store.rs`（`write_files` / `write_plugin_files` / `PluginFileInput`）
- `apps/desktop/src/lib/plugin-status.ts`（`writePluginFiles` 封装）
- `apps/desktop/src/pages/Plugins.tsx`（`editInGenerator` 落盘）
- `apps/desktop/src/components/creator/Composer.tsx`（@触发 + chip + `MentionPlugin` 类型）
- `apps/desktop/src/pages/PluginCreatorHome.tsx`（`attachedPlugins`/`mentionablePlugins` state + `pluginManifestSummary` + send 拼接）

## 已安装云端插件包必须本地物化（2026-06-19）

### 1. Scope / Trigger
- Trigger: changing marketplace install flow, `/api/plugins/available` package projection, cloud plugin run/edit entrypoints, or `write_plugin_files` local materialization.

### 2. Signatures
- Frontend install: `installMarketplacePluginPackage(pluginId: string) -> Promise<LoadedPlugin>`
- Frontend persistence: `ensurePluginPackagePersisted(plugin: LoadedPlugin) -> Promise<void>`
- Frontend package builder: `pluginPackageFiles(plugin: LoadedPlugin) -> DraftFile[]`
- Tauri write command: `write_plugin_files(plugin_id, files: PluginFileInput[])`
- Tauri open command: `open_plugins_root() -> Result<(), String>`
- Backend availability: `GET /api/plugins/available -> { plugins: LoadedPlugin[] }`

### 3. Contracts
- Marketplace install only creates/enables the backend `PluginInstallation`; it does not make the plugin runnable on the desktop by itself.
- After `/api/marketplace/install`, desktop must call `/api/plugins/available`, find the installed plugin, and write the package to `plugins_root/<pluginId>/` before reporting install success.
- Running a cloud/team plugin whose `runtime_type` is not `cloud` must first call `ensurePluginPackagePersisted(plugin)`, so `start_plugin(plugin.id)` reads real local files instead of an empty directory.
- Local package materialization writes both `plugin.manifest` and `plugin.files[]`; if `plugin.manifest` is present it generates or overwrites `manifest.json` ahead of file entries.
- A plugin package without non-manifest files or without any `manifest.json` source is invalid for local runtime and must fail explicitly.
- `open_plugins_root` must create the root directory if missing and open it with the OS file manager; failures surface as returned errors.

### 4. Validation & Error Matrix
- `/api/plugins/available` does not contain installed `pluginId` -> error `安装已记录，但 /api/plugins/available 未返回该插件。`
- available plugin has no `files` or empty `files` -> error `后端未返回插件文件，无法写入本地插件目录。`
- available plugin has only `manifest.json` and no entry/source files -> error `后端未返回插件入口文件，无法写入本地插件目录。`
- `files[]` lacks `manifest.json` and `plugin.manifest` is missing -> error `后端未返回 manifest.json，无法写入本地插件目录。`
- `write_plugin_files` rejects absolute path / `..` / hidden segments -> propagate the Rust error; do not show install success.
- OS file manager spawn fails in `open_plugins_root` -> return `打开插件目录失败：...`.

### 5. Good/Base/Bad Cases
- Good: install market plugin -> backend install succeeds -> available returns `manifest + files[]` -> desktop writes `manifest.json`, entry file, requirements/package files -> Plugins page can run it.
- Base: available `files[]` already contains `manifest.json`; desktop writes it unchanged unless `plugin.manifest` is present.
- Bad: POST `/api/marketplace/install` returns `installed` and UI toasts success without writing package files; later local scan reports incomplete or `pip install` fails in an empty directory.

### 6. Tests Required
- Frontend unit: `plugin-installation.spec.ts` asserts install fetches available package and writes local files.
- Frontend unit: same spec asserts missing files, missing entry files, and missing manifest source fail explicitly.
- Backend unit: `plugin-available.spec.ts` asserts marketplace package files are hidden before install and returned after install.
- Rust/desktop checks: `cargo test -p lingfang-desktop`, `pnpm -C apps/desktop test`, `pnpm -C apps/desktop typecheck`, and desktop build when packaging.

### 7. Wrong vs Correct
Wrong:
```typescript
await api('/api/marketplace/install', { method: 'POST', body: { plugin_id: pluginId } });
toast.success('已安装');
```

Correct:
```typescript
await api('/api/marketplace/install', { method: 'POST', body: { plugin_id: pluginId } });
const { plugins } = await api<{ plugins: LoadedPlugin[] }>('/api/plugins/available');
const plugin = plugins.find((item) => item.id === pluginId);
if (!plugin) throw new Error('安装已记录，但 /api/plugins/available 未返回该插件。');
await ensurePluginPackagePersisted(plugin);
```

## 插件崩溃展示 stderr + 一键 AI 修复（2026-06-17）

插件运行（start_plugin）崩溃时，原 `Stdio::null` 丢弃 stderr，用户只看到「无法启动」看不到 Python/Node 异常。改进：

### stderr 捕获 + 秒退判定（Rust）
- `start_plugin` 的 stderr 改 `Stdio::piped`（stdout 保持 null，PRD 需求 9 不嵌终端）。
- spawn 后 `wait_for_crash(child, 800ms)`（纯函数便于单测）轮询 `try_wait`：
  - 退出 = 崩溃：读 stderr 全部内容，返回 `plugin_crashed:<status>\n<stderr 摘要>` 前缀错误（与 `manifest_missing:`/`interpreter_missing:` 同款前缀约定）。stderr 超 2000 字符截断（`truncate_stderr`）。
  - 存活 = 正常：stderr pipe 交后台线程排空（防 pipe 满阻塞），读后丢弃不进 UI，register 进程表返回 pid。

### 前端展示 + 一键修复
- `ScriptPreviewPanel.handleStart` catch `plugin_crashed:` 前缀 → `toCreatorError('plugin_crashed')` 展示「插件启动后立即退出」+ stderr 原文。
- 错误卡片加「让 AI 修复」按钮（仅 plugin_crashed + 有 onRequestFix 时）：调 `onRequestFix(stderr)`。
- `Plugins.tsx handleAutoFix`：落盘 files + 跳创建器 + 设 `pendingAutoFixPrompt`（AppContext 跨页传递）。
- `PluginCreatorHome` 挂载 effect 检测 `pendingAutoFixPrompt` + `currentDraft.plugin_id` 就绪 → 自动 `send(prompt)`（prompt = stderr + 修复引导语），用完即清。AI 在原上下文（落盘的 files）修代码、重写文件，用户再运行验证。

前缀约定：Rust 错误字符串用 `<code>:<人类可读>` 前缀（`interpreter_missing:` / `manifest_missing:` / `plugin_crashed:`），前端 `startsWith` 识别后映射到 CreatorErrorKind。

Reference files:
- `apps/desktop/src-tauri/src/plugin_runner.rs`（`wait_for_crash` / `truncate_stderr` + start_plugin stderr piped）
- `apps/desktop/src/lib/creator-error.ts`（`plugin_crashed` kind）
- `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx`（`plugin_crashed:` catch + 「让 AI 修复」按钮）
- `apps/desktop/src/App.tsx`（`pendingAutoFixPrompt` 跨页 state）
- `apps/desktop/src/pages/Plugins.tsx`（`handleAutoFix`）+ `PluginCreatorHome.tsx`（effect 自动 send）

## 插件进程启动：直接 spawn + stderr piped（2026-07-09，PS launcher 方案已回退）

**当前实现**（跨平台统一）：`start_plugin_from_dir` 直接 spawn 入口进程（python/node），`stdin=null`、`stdout=Stdio::piped()`、`stderr=Stdio::piped()`（**两者都 piped 逐行流**），800ms 秒退判定 try_wait 判退出 + 从 stderr 缓冲读全文做崩溃诊断。Unix 用 `setsid` 进程组分离，Windows 用 `CREATE_NEW_PROCESS_GROUP`（不加 `CREATE_NEW_CONSOLE`，不弹 cmd 窗口）。

### 全阶段输出实时流 `plugin:output`（2026-07-09 新增）
**推翻 PRD 需求 5/9「不在 UI 内嵌终端」**：现在全阶段（venv 创建 / pip install / python 运行）的 stdout+stderr 逐行实时流到 app 内日志面板。
- `plugin:output` 事件 payload：`{ plugin_id, stream: "stdout"|"stderr", line }`，逐行 emit。
- **命名陷阱（2026-07-09 实测修复）**：`PluginOutput` / `PluginStartProgress` struct **必须** `#[serde(rename_all = "camelCase")]`。Tauri `emit` 的事件 payload 不像命令返回值那样自动转驼峰，seria 默认是 snake_case（`plugin_id`）；而前端按 `event.payload.pluginId === pluginId` 过滤。漏加会导致前端 onOutput/onProgress 回调因字段恒 undefined 而全部静默失效——面板永远显示「（等待输出…）」。
- **流式运行函数** `run_streamed_with_env(binary, args, cwd, timeout, env, on_line)`（`process_util/capture.rs`）：spawn stdout+stderr piped，开两个后台线程逐行读，每行调 `on_line(line, is_stderr)` 回调（调用方据此 emit plugin:output）；主线程 try_wait 轮询 + 超时 kill；返回 CapturedOutput 供错误诊断。
- **StreamCtx**（`plugin_runner.rs`）：携带 `app: AppHandle` + `plugin_id`，`make_line_callback()` 返回 emit plugin:output 的闭包。持久化运行传 Some，创建期预览传 None（不流式）。
- **run_with_optional_stream**：Some(ctx) → 流式；None → 静默捕获（run_capture_with_env）。
- venv/pip/node/playwright 各阶段（create_python_venv / install_and_smoke / smoke_test_venv / ensure_node_dependencies / ensure_playwright_browsers）都接收 `stream: Option<&StreamCtx>`，Some 时输出实时流到前端。
- **spawn 入口进程**：stdout+stderr 各开一个 reader 线程逐行 emit；stderr 同时累积到共享缓冲（Arc<Mutex<String>>），供 800ms 秒退时读全文做崩溃诊断。
- **PYTHONIOENCODING=utf-8**：spawn env 注入（Windows 中文系统默认 GBK，不设逐行读会乱码）。

### 前端日志面板
- `PluginLogPanel`（`components/plugins/PluginLogPanel.tsx`）：深色终端风格（`bg-[#0d1117] text-[#e6edf3] font-mono`），行缓冲 + 自动滚到底 + stderr 红色 + 复制按钮。
- `useLogBuffer` hook：累积 `PluginOutputEvent[]` → `LogLine[]`。
- `ScriptPreviewPanel` 在 starting/running/error 三阶段都渲染 `<PluginLogPanel>`（starting 看 pip install 进度，running 看应用日志，error 保留 traceback）。`handleStart` 传 `onOutput` 回调 + 存 `unlistenOutput`（停止/卸载时解绑）。
- `startPlugin`/`startBuiltinPlugin` 增加可选 `onOutput?: (e: PluginOutputEvent) => void`，返回值含 `unlistenOutput`（进程活着期间持续流，startPlugin resolve 后仍保留监听）。

**已回退的 PS launcher 方案**（曾尝试，已删除）：曾用 PowerShell launcher + `CREATE_NEW_CONSOLE` 弹独立 cmd 窗口 + `Tee-Object` 落 `.launcher.log` + 后台 `spawn_exit_watcher` 轮询退出 emit `plugin:exited`。但故障面太多（stdio 继承空 stdin 致 PS Read-Host EOF 秒退、Tee-Object 默认 UTF-16LE 致 read 乱码、verbatim 路径致 PS 解析异常），远程排查不动，回退到最简单的直接 spawn + stderr piped。已删除：`write_launcher_ps1` / `spawn_windows_console` / `spawn_exit_watcher` / `parse_exit_code_from_log` / `wait_for_crash_with_log*` / `PluginExited` / `PluginProcessTable::clone_handle` / `read_log_tail` / `decode_log_bytes` / `launcher_log_path`。

**前端兼容**：`plugin:exited` 事件不再触发（监听器无害保留）；2.5s 轮询 `getPluginStatus`（`is_running` try_wait）兜底，进程退出后 UI 自动回 idle + toast。800ms 内秒退仍由同步 `plugin_crashed:` 前缀路径完整覆盖（含 stderr + ErrorBubble + AI 修复）。唯一回归：800ms 后才退出的插件看不到 stderr 错误卡片（只有通用 toast）。

### 启动流水线日志 `data/.launch.log`（保留）
- `append_launch_log(plugin_dir, msg)` 追加带时间戳的一行到 `<plugin_dir>/data/.launch.log`（best-effort）。
- `start_plugin_from_dir` 各节点记录：启动开始、manifest/runtime 解析、venv/依赖就绪、spawn 命令、秒退诊断、启动成功 pid。

### 崩溃转储 `data/.crash.log`（保留）
800ms 秒退时写完整崩溃转储到 `<plugin_dir>/data/.crash.log`（覆盖式）：
- `write_crash_dump(plugin_dir, cmdline, cwd, env_dump, crash_err, output)` 写入：时间戳、完整复现命令、cwd、环境变量（脱敏）、平台诊断串、piped stderr 全文。
- env_dump 在 env move 进 spawn 之前捕获，`start_plugin_from_dir` 在 spawn 前构造 `cmdline_str` / `cwd_str` / `env_dump` 快照。
- `wait_for_crash_with_diagnostics_capturing`（跨平台）秒退时把 piped stderr 回传 out_capture -> 写转储。
- 崩溃错误信息追加手动复现段（完整命令 + cwd + `.crash.log` 路径）。

### Tests Required
- Rust: `strip_verbatim_prefix`（去前缀/无前缀不变）、`append_launch_log`（追加 + 时间戳）、`write_crash_dump`（含命令/env/输出）、venv 自愈冒烟（9 个）、`wait_for_crash`（秒退/存活）。
- Full check: `cargo test --bin lingfang-desktop`。

Reference files:
- `apps/desktop/src-tauri/src/plugin_runner.rs`（`start_plugin_from_dir` / `wait_for_crash_with_diagnostics_capturing` / `write_crash_dump` / `append_launch_log` / `strip_verbatim_prefix`）

## Python venv 依赖损坏自愈（2026-07-09）

**问题**：pip 装出的包可能被杀软（Windows Defender 在解压 wheel 时锁文件）/磁盘残缺写坏——典型表现：streamlit 的某个 `.py` 混入 NUL 字节 → `python -m streamlit run` 在 runpy 解析阶段抛 `SyntaxError: source code string cannot contain null bytes`，退出码 1。但平台的 venv 逻辑（`ensure_python_venv`）只看 `python.exe` 是否存在 + `pip install -r` 是否幂等成功（exit 0），**永远检测不到这种落盘后损坏**，且 pip install 幂等（已装跳过）不会重装坏包 → 死锁：用户只能手动删 `%LOCALAPPDATA%\LingFang\python-venvs\venv-<hash>` 目录。

### 自愈流程（`ensure_python_venv`，Rust）
1. 原有：venv 不存在/home 不匹配 → `create_python_venv`。
2. **新增快路径**：读 `requirements.txt` 内容算指纹（哈希 + salt），与 venv 目录下 `.lfdeps-verified` 标记比对——命中且 venv python 存在 → 直接返回（冷启动秒过，不跑 pip 也不跑冒烟）。
3. 标记未命中 → `install_and_smoke`（单次尝试）：
   - `pip install -r requirements.txt`（幂等，600s 超时）。
   - **import 冒烟**（`smoke_test_venv`）：用 venv python 跑生成的 `.lf-smoke.py`，逐个 `importlib.import_module` requirements.txt 里的关键依赖。
   - 冒烟脚本异常分类：只把 **文件损坏类**（`SyntaxError`/`ValueError` null bytes/`OSError`/`UnicodeDecodeError` + 部分 `ImportError` 链含 OSError）当损坏信号 → exit 2；`ModuleNotFoundError`（包名≠import名/可选依赖缺失）和其它运行期异常放过；超时（卡网络/重初始化）不当坏。
   - 冒烟通过 → 写 `.lfdeps-verified` 标记。
4. `install_and_smoke` 返回损坏错误 → **删整个 venv**（`remove_dir_all_with_retry`，带 AV 锁重试 + Windows rmdir 降级）→ `create_python_venv` 重建 → `install_and_smoke` 再试一次。仍失败 → 返回友好错误（前端展示「pip install 失败」类，不崩）。

### 包名 → import 名映射
- requirements.txt 里是 PyPI distribution 名，冒烟需要真正的 import 名。
- `dist_to_import_name`：已知不一致的硬编码表（`pillow→PIL`、`opencv-python→cv2`、`pyyaml→yaml`、`beautifulsoup4→bs4`、`python-magic→magic`、`scikit-learn→sklearn` 等）。
- 未列出的用 `normalize_import_name` 兜底：去版本约束（`>=`/`==`/`<`）、去 extras（`[x]`）、去 environment marker（`;`）、`-`/`.` → `_`。
- `parse_requirements_dist_names`：跳过注释/空行/`-r`/`-e`/`--option`/URL（含 `://`）/路径行。

### Tests Required
- Rust: `parse_requirements_dist_names`（基础/跳 option+URL/空）、`dist_to_import_name`（已知映射/未知 None）、`normalize_import_name`（去版本+分隔符替换）、`smoke_import_names`（映射优先+标准化兜底/dedup+sorted）、`deps_fingerprint`（确定性+内容敏感）、`deps_verified_marker` round-trip、`build_smoke_script`（含 import 名 + exit 码 0/2）。
- Full check: `cargo test --bin lingfang-desktop`。

Reference files:
- `apps/desktop/src-tauri/src/plugin_runner.rs`（`ensure_python_venv` / `install_and_smoke` / `smoke_test_venv` / `build_smoke_script` / `parse_requirements_dist_names` / `dist_to_import_name` / `normalize_import_name` / `smoke_import_names` / `deps_fingerprint` / `deps_verified_matches` / `write_deps_verified` / `deps_verified_marker` / `DEPS_VERIFIED_SALT`）

## Legacy: 本地/草稿插件 ZIP 导入导出（`.lfplugin` v3，2026-07-08）

> **Superseded**：本节记录已移除的前端 JSZip v2/v3 路径，仅供历史迁移排查。当前生产格式、安装/草稿导入和发布一律使用 Rust `.lfplugin` v4，契约见 [plugin-package-manager.md](./plugin-package-manager.md)。不得恢复 `plugin-package-zip.ts` 或让 WebView 缓冲制品。

旧 `.lfplugin` v3 是 ZIP 压缩包（v3 支持二进制；v2 纯文本向后兼容）。以下内容不是当前实现契约。

### 1. Scope / Trigger
- Trigger: changing `plugin-package-zip.ts`（`exportPluginToZip`/`parsePluginZip`/`materializeZipPlugin`）、`LocalPluginsSection` 的「导入」按钮、`LocalPluginRow` 的「导出」按钮、`DraftPluginsSection` 的导入/导出，或 `.lfplugin` 包格式。

### 2. Signatures
- 导出: `exportPluginToZip(pluginId: string, source: 'local'|'draft') -> Promise<{ name, fileCount, skipped }>`
- 解析（不落盘）: `parsePluginZip(file: File) -> Promise<ZipImportResult>`
- 物化（落盘）: `materializeZipPlugin(result: ZipImportResult, existingIds: string[]) -> Promise<{ id, source }>`
- 前端 hook: `useLocalImport(existingIds, onDone) -> { inputRef, importing, preview, editingName, setEditingName, pickFile, onFilePicked, confirmImport, cancelImport }`
- Tauri 命令: `list_plugin_files` / `read_local_plugin_file` / `read_local_plugin_file_bytes`（v3 新增，读二进制 base64）/ `write_plugin_files`（文本批量）/ `write_plugin_file_bytes`（v3 新增，写二进制 base64）/ `set_plugin_draft_flag`。
- 复用: `saveDraftPlugin`（draft 落点）/ `dedupeImportId`（id 去重）/ `safePluginId`（合法化）。

### 3. Contracts — `.lfplugin` ZIP 包结构（v3）
```
<id>.lfplugin  (ZIP, DEFLATE)
├── _meta.json       { "format": "lingfang-plugin", "version": 3, "source": "local"|"draft", "exportedAt": ISO, "name": 展示名, "binaryFiles": ["icon.png", "vendor/x/font.ttf"] }
├── manifest.json    磁盘原始 manifest（含 capabilities/visibility/runtime_type 等全部字段，非重新生成）
├── <文本源文件>      main.py / index.js / ui/index.html / requirements.txt / ...（UTF-8 直存）
└── <二进制源文件>    字体/图片/音频（base64 编码存，路径列入 _meta.binaryFiles）
```
- `version`: 3（当前写入）。读取接受 v2（纯文本，无 binaryFiles 字段，按文本处理）与 v3；v1（旧 JSON 单文件 `lingfang-plugin-bundle`）报「旧版 JSON 格式，请重新导出」。
- `binaryFiles`（v3 新增）：列出 ZIP 内以 base64 存的二进制文件路径。导入时这些 entry 用 `async('base64')` 读 + `write_plugin_file_bytes` 写真实字节；文本 entry 仍用 `async('string')` + `write_plugin_files`。
- `source`：导出时按来源记（本地→`local`，草稿→`draft`），导入时据此决定落点（见下）。

### 3a. Contracts — 导出（v3）
- `exportPluginToZip`：`list_plugin_files(pluginId)` 取源文件 → 逐个 `read_local_plugin_file` → `isBinaryPlaceholder` 判定：
  - **文本**：直存 `zip.file(path, content)`。
  - **二进制**（v3）：改读 `read_local_plugin_file_bytes`（base64）→ `zip.file(path, base64, {base64:true})`，路径记入 `binaryFiles`（**不再跳过**）。
  manifest.json 用磁盘原文件（保留全部字段）+ `_meta.json`（version:3 + binaryFiles）→ JSZip `generateAsync({type:'blob',compression:'DEFLATE'})` → 浏览器下载 `<id>.lfplugin`。缺失 manifest.json → 报「插件缺少 manifest.json，无法导出」。
- 二进制读路径：`read_local_plugin_file` 对非 UTF-8 返回占位字符串（向后兼容旧消费者）；`read_local_plugin_file_bytes` 返回真实字节的 base64（v3 导出专用）。

### 3b. Contracts — 导入落点（按来源保持 + 二进制分流）
- `parsePluginZip`：`file.arrayBuffer()` → `JSZip.loadAsync` → 校验 `_meta.json`（format/version∈{2,3}/source）→ 读 `binaryFiles`（v3；v2 为空集）→ 读 `manifest.json` 取 id/name → 收集其余源文件：`binaryFiles` 名单内用 `async('base64')` + 标 `binary:true`，其余 `async('string')`（跳过 `_meta.json`/`manifest.json`/`__MACOSX/`/`.DS_Store`）。
- **非 ZIP** → `rejectLegacyJsonOrInvalid`：尝试按 JSON 解析，命中旧 v1 给重新导出引导，否则报「不是有效的 ZIP 包」。
- `materializeZipPlugin`：拆分文本/二进制 → 文本走批量写，二进制逐个 `writePluginFileBytes`（base64 解码写字节）。`finalId = dedupeImportId(safePluginId(result.id), existingIds)`（冲突追加 -2/-3，**绝不覆盖**；版本升级见下）。
  - **source==='draft'** → `saveDraftPlugin`（文本 files）+ 二进制逐个 `writePluginFileBytes`（saveDraftPlugin 走文本路径，二进制需单独写）。
  - **source==='local'/缺失** → `writePluginFiles`（manifest + 文本 files）+ 二进制逐个 `writePluginFileBytes`。
  - 用户改名写入 `manifest.title`（保留原 name），使导入后列表展示用新名。
- 导入前弹确认对话框（`ImportConfirmDialog`）：展示 runtime/entry/文件数 + 草稿来源提示（source=draft 时黄色提示「将出现在我的草稿」），允许改名 → 改名影响最终 plugin_id 与 manifest.title。

### 3c. Contracts — 版本感知覆盖（manifest.id 同一性）
- `materializeZipPlugin(result, existingIds, existingVersions?)`：`existingVersions` 是 id→version 映射。
- `isUpgrade = existingVersions[baseId] && isVersionNewer(incomingVersion, existingVersion)`。
- 升级 → `finalId = baseId`（覆盖，不 dedupe），`upgraded: true`；非升级 → `finalId = dedupeImportId(baseId, existingIds)`，`upgraded: false`。

### 4. Validation & Error Matrix
- 文件非 ZIP 且非旧 JSON → `parsePluginZip` 抛「文件不是有效的 ZIP 包」。
- 旧 JSON v1 → 抛「这是旧版 JSON 格式的 .lfplugin（v1），请用当前版本重新导出后再导入」。
- `_meta.json` format 不符 → 抛「文件不是灵坊插件包（_meta.json format 不符）」。
- version 不为 2 或 3 → 抛「插件包版本 vN 不受支持，请用当前版本重新导出（支持 v2/v3）」。
- 缺 `_meta.json`（ZIP 内）→ 抛「文件不是有效的灵坊插件包（缺少 _meta.json）」。
- 缺 `manifest.json` → 抛「插件包缺少 manifest.json」。
- manifest 缺 id → 抛「manifest.json 缺少 id 字段」。
- 无源文件 → 抛「插件包没有可导入的源文件」。
- 导入确认时名称为空 → toast「插件名称不能为空」，不落盘。
- `write_plugin_files`/`write_plugin_file_bytes`/`saveDraftPlugin` 失败（非法路径/IO）→ toast 透传错误，不显示导入成功。

### 5. Good/Base/Bad Cases
- Good: 本地插件 videodl 点「导出」→ 下载 `videodl.lfplugin`（v3 ZIP，含 _meta(version:3,binaryFiles)/manifest/main.py/requirements.txt，二进制以 base64 进包）→ 本地 tab「导入」选该包 → 确认 → 本地列表出现 videodl 可运行，二进制字节一致。
- Good: 含 vendored 源码（字体/音频二进制）的插件（如 moneyprinter-turbo）导出 → 导入 → 字体/音频文件字节完整还原（经 write_plugin_file_bytes）。
- Good: 草稿点「导出」（source=draft）→ 草稿 tab「导入」→ 落「我的草稿」（draft:true）。
- Good: 本地导出包在草稿 tab 导入 → source=local 仍落本地（按来源保持，不因导入入口变草稿）。
- Good: 旧 v2 包（无 binaryFiles）导入 → 按纯文本处理，向后兼容不报错。
- Base: 包内无 _meta.json.source（旧导出工具）→ 兜底按 local（更安全：至少能运行）。
- Bad: 二进制文件走 writePluginFiles（文本路径）→ base64 字符串当文本写入，字节损坏；正确做法 writePluginFileBytes 解码后写字节。
- Bad: 导入时 id 冲突直接 write_plugin_files → 覆盖现有插件；正确做法 dedupeImportId 追加 -2（或版本升级覆盖）。
- Bad: source=draft 走 writePluginFiles → manifest 无 draft 标记，出现在本地而非草稿；正确做法 source=draft 走 saveDraftPlugin。

### 6. Tests Required
- 前端单测: `plugin-package-zip.spec.ts` 覆盖：导出→解析往返（v3，含二进制 base64 + binaryFiles + binary:true 标记）、物化分流（文本 writePluginFiles + 二进制 writePluginFileBytes）、source=draft 走 saveDraftPlugin / source=local 走 writePluginFiles、id 冲突 dedupe、版本升级覆盖、v2 包向后兼容、旧 JSON v1 报错、非 ZIP 报错、缺 _meta/缺 manifest/version 不符报错。
- 前端单测: `use-local-import.spec.ts::dedupeImportId`（纯函数，保留）。
- 后端单测: `plugin-package.spec.ts` 覆盖 binary base64 大小计量、单文件超限、点开头文件名放行、.. 仍拒。
- Rust 单测: `plugin_store/tests.rs` 覆盖 write_file_bytes（写二进制/建子目录/拒穿越/拒绝对路径）、read_plugin_file_bytes（base64 往返/拒穿越）。
- Full checks: `pnpm -C apps/desktop test`, `pnpm -C apps/desktop typecheck`, `pnpm -C apps/collab-api test`, `cargo test -p lingfang-desktop`。

### 7. Wrong vs Correct

Wrong:
```typescript
// v1 单文件 JSON（已废弃）：
exportDraftPlugin(id); parseDraftBundle(file); importDraftBundle(bundle);
// 导入时 source 无关一律落草稿，或 id 冲突覆盖
await writePluginFiles(result.id, result.files);
```

Correct:
```typescript
const result = await parsePluginZip(file);            // ZIP v2
const { id, source } = await materializeZipPlugin(result, existingIds); // source 决定落点 + dedupe
// source='local' → writePluginFiles（非草稿）；source='draft' → saveDraftPlugin（draft:true）
```

Reference files:
- `apps/desktop/src/lib/plugin-package-zip.ts`（`exportPluginToZip` / `parsePluginZip` / `materializeZipPlugin` / `rejectLegacyJsonOrInvalid`）
- `apps/desktop/src/pages/plugins/use-local-import.ts`（`useLocalImport` / `dedupeImportId`）
- `apps/desktop/src/pages/plugins/LocalPluginsSection.tsx`（「导入」按钮 + 隐藏 `<input accept=".lfplugin">` + `ImportConfirmDialog`）
- `apps/desktop/src/pages/plugins/LocalPluginRow.tsx`（「导出」按钮 + `useLocalExportState`）
- `apps/desktop/src/pages/plugins/DraftPluginsSection.tsx`（草稿导入/导出走 ZIP）
- `apps/desktop/src/lib/draft-plugin.ts`（旧 JSON 函数已删，注释指向 zip 模块）

## 本地插件上传到团队空间（2026-07-07）

### 1. Scope / Trigger
- Trigger: 在「本地插件」行点「发布」按钮（RocketIcon），或修改 `loadLocalPluginAsStaged` / `LocalPluginRow` 发布流程。

### 2. Signatures
- 前端组装: `loadLocalPluginAsStaged(pluginId: string) -> Promise<StagedPlugin>`
- 前端上传（已有）: `submitStagedPlugin(StagedPlugin) -> Promise<{ ok: true; name } | { ok: false; message }>`
- 复用 Tauri 读命令: `read_local_plugin_file(plugin_id, file) -> Result<String, String>` / `list_plugin_files(plugin_id) -> Result<Vec<String>, String>`
- 前端封装: `readLocalPluginFile` / `listPluginFiles`（`@/lib/plugin-status`）

### 3. Contracts
- 「发布到团队」= 读磁盘 manifest.json（取 capabilities/visibility 等列表层 LocalPluginStatus 没有的字段）+ `list_plugin_files` 枚举源文件 + 逐个 `read_local_plugin_file` 读内容 → 组装 `StagedPlugin` → `submitStagedPlugin` → `POST /api/plugins/upload`。
- manifest.json **不**进 `files[]`（由 `submitStagedPlugin` 内的 `buildStagedManifest` 重新生成），避免旧 manifest 脏字段污染上传包。
- 二进制占位文件（`read_local_plugin_file` 对非 UTF-8 返回 `[binary file, ...]` 占位）用 `isBinaryPlaceholder` 判定后**跳过**，不作为文本上传。
- 组装字段优先级：`id` ← manifest.id > plugin_id；`name` ← manifest.title > manifest.name > plugin_id（与 `scan_one_plugin` 展示一致）；`runtime_type`/`entry`/`visibility`/`capabilities` ← manifest，缺失走默认（runtime=client、entry 按 runtime 默认、visibility=tenant、capabilities=[ui.view]）。
- **两种发布目标（RocketIcon 下拉菜单）**：
  - 「发布到团队」：`/api/plugins/upload` → 团队插件（reviewStatus=DRAFT），后续可在团队行点 RocketIcon 提交市场审核。
  - 「发布到市场」：先 `/api/plugins/upload`（拿返回 `plugin.id`）→ 再 `POST /api/plugins/:id/submit-marketplace`（带 priceCents）一步进入审核队列（PENDING）。`submitStagedPlugin` 返回类型含 `id` 供此第二步使用。
- 本地行「发布」按钮仅对**非草稿**（`!item.draft`）插件显示——草稿在「我的草稿」tab 有自己的 `handlePublish`（DraftPluginsSection）。
- **发布成功后刷新本地 + 团队列表**：`PluginCenterBody` 传 `onPublished={() => { local.reload(); team.refresh(); }}`（此前只刷新本地，导致切到「团队插件」看不到刚发布的插件——团队列表缓存陈旧）。

### 4. Validation & Error Matrix
- manifest.json 读取失败（os error / JSON 非法）→ 抛 `读取 manifest.json 失败：...`，toast 展示，不发起上传。
- 插件目录无源文件（全是二进制占位）→ 抛 `插件没有可上传的源文件（可能全是二进制）`。
- `submitStagedPlugin` 内 `validateStagedCompleteness` 校验失败（python 缺 requirements.txt / nodejs 缺 package.json / client 入口非 .html）→ 返回 `{ ok:false, message }`，toast 展示其 message，不发起上传。
- 后端 `/api/plugins/upload` 失败（权限/超限）→ `submitStagedPlugin` catch ApiError 返回 message，toast 展示。

### 5. Good/Base/Bad Cases
- Good: 本地 videodl 插件行 RocketIcon → 选「发布到市场」→ 填定价（或留空=免费）→ 一步上传 + 提交审核 → toast「已发布并提交市场审核」，团队列表刷新出现该插件（reviewStatus=PENDING）。
- Good: 本地 videodl 行选「发布到团队」→ 上传成功 → 团队 tab 出现（reviewStatus=DRAFT）→ 团队行点 RocketIcon 提交市场审核（两步路径仍保留）。
- Base: 本地插件无 capabilities 字段 → loadLocalPluginAsStaged 兜底 `[ui.view]` → 上传成功。
- Bad: 发布成功后只刷新本地列表，不刷新团队列表 → 用户切到「团队插件」看不到刚发布的插件；正确做法是 `onPublished` 同时调 `local.reload()` + `team.refresh()`。
- Bad: 把 manifest.json 原样塞进 files[] → 上传后后端 manifest 与 files 里的 manifest.json 冲突/重复；正确做法是 manifest 由 buildStagedManifest 重新生成。

### 6. Tests Required
- 前端单测: `local-upload.spec.ts` 覆盖 python 插件组装完整 StagedPlugin（title 优先、保留 capabilities/visibility、跳过 manifest.json）、二进制占位跳过、缺 capabilities/visibility 走默认、manifest 读取失败抛错、无可上传源文件抛错。
- 前端单测（已有）: `creator-tools.spec.ts` 覆盖 `submitStagedPlugin` / `validateStagedCompleteness`。
- Full checks: `pnpm -C apps/desktop test`, `pnpm -C apps/desktop typecheck`, `pnpm -C apps/desktop vite:build`。

### 7. Wrong vs Correct

Wrong:
```typescript
// 列表层 LocalPluginStatus 没有 capabilities，直接拼会丢字段
await submitStagedPlugin({ id: item.id, name: item.name, /* capabilities 缺失 */ ... });
```

Correct:
```typescript
const staged = await loadLocalPluginAsStaged(item.id); // 从磁盘 manifest 读 capabilities/visibility
const result = await submitStagedPlugin(staged);        // 返回 { ok, name, id, upgraded }
if (!result.ok) toast.error(result.message);
// 「发布到市场」：拿到 result.id 后调 submit-marketplace
await api(`/api/plugins/${result.id}/submit-marketplace`, { method: 'POST', body: { priceCents } });
```

Reference files:
- `apps/desktop/src/lib/plugin-creator/local-upload.ts`（`loadLocalPluginAsStaged`）
- `apps/desktop/src/pages/plugins/LocalPluginRow.tsx`（`useLocalPublishState`：RocketIcon Popover 菜单「发布到团队」/「发布到市场」+ `PublishToMarketDialog` 定价弹窗）
- `apps/desktop/src/pages/plugins/LocalPluginsSection.tsx`（透传 `onPublished` 回调）
- `apps/desktop/src/pages/plugins/PluginCenterBody.tsx`（`onPublished` 同时刷新本地 + 团队列表）
- `apps/desktop/src/lib/plugin-status.ts`（`listPluginFiles` / `readLocalPluginFile` 封装）
- `apps/desktop/src/lib/plugin-creator/creator-tools.ts`（`submitStagedPlugin` 透传 `id`/`upgraded` / `validateStagedCompleteness`）

## 后台直接审核草稿插件（DRAFT → APPROVED，2026-07-07）

管理员可在后台插件详情直接把草稿(DRAFT)插件审核通过/驳回，无需作者先提交市场审核。

### 1. Scope / Trigger
- Trigger: 在 `apps/collab-admin` 插件详情面板对一个 DRAFT 插件点「通过审核」/「驳回」，或修改 `adminApprovePlugin` / `adminRejectPlugin` 守卫、`plugins-view.tsx` 审核按钮渲染条件。

### 2. Signatures
- 后端：`AdminService.adminApprovePlugin(actorId, id) -> { plugin }`（守卫放宽：DRAFT/PENDING 均可）
- 后端：`AdminService.adminRejectPlugin(actorId, id, reason?) -> { plugin }`（守卫同上）

### 3. Contracts
- `adminApprovePlugin` / `adminRejectPlugin` 守卫从 `!== 'PENDING'` 放宽为 `!== 'PENDING' && !== 'DRAFT'`：DRAFT 插件可直接审核，跳过作者主动提交步骤。
- 对 DRAFT 审核通过/驳回的副作用与 PENDING 完全一致：写 `PluginReview`（status APPROVED/REJECTED）、审计日志、通知作者、（审核通过）marketplace=true/visibility=PUBLIC/新版本通知已安装用户。
- APPROVED/REJECTED 等终态仍抛 conflict「插件不在审核中且非草稿，无法直接审核」。
- 后台 UI（`plugins-view.tsx`）审核按钮渲染条件：`reviewStatus === 'PENDING' || reviewStatus === 'DRAFT'`。
- 桌面端 `Review.tsx` 审核**队列**（`GET /api/admin/plugins/review-pending`）仍只列 PENDING（队列=作者主动提交的待办）；后台插件详情面板才是对任意状态审核的入口。

### 4. Validation & Error Matrix
- DRAFT → approve → APPROVED + marketplace + PUBLIC（成功）。
- DRAFT → reject → REJECTED + 通知作者附原因（成功）。
- APPROVED → approve → 409 conflict（不能重复审核）。
- REJECTED → reject → 409 conflict（不能重复驳回）。
- PENDING → approve/reject → 与原逻辑一致（回归用例覆盖）。

### 5. Good/Base/Bad Cases
- Good: 作者上传插件后未提交审核（DRAFT），管理员在后台插件列表筛选看到 → 详情面板点「通过审核」→ 直接上架市场。
- Base: DRAFT 插件无 authorUserId → 审核通过但不触发作者通知（与 PENDING 路径一致）。
- Bad: 对已 APPROVED 插件再点通过 → 后端 409，前端按 toast 展示；不重复写 PluginReview。

### 6. Tests Required
- 后端单测: `admin.service.spec.ts` 覆盖 DRAFT → approve（APPROVED + marketplace + 通知）、DRAFT → reject（REJECTED + 通知附原因）、APPROVED/REJECTED 终态抛 conflict。
- Full checks: `pnpm -C apps/collab-api test`, `pnpm -C apps/collab-admin build`。

### 7. Wrong vs Correct

Wrong:
```typescript
// 守卫只允许 PENDING，DRAFT 被挡在 409
if (plugin.reviewStatus !== 'PENDING') throw conflict('插件不在审核中');
// 后台 UI 只对 PENDING 显示审核按钮，DRAFT 连按钮都看不到
{plugin.reviewStatus === 'PENDING' ? <Button>通过审核</Button> : null}
```

Correct:
```typescript
// 守卫允许 DRAFT/PENDING；终态（APPROVED/REJECTED）抛 conflict
if (plugin.reviewStatus !== 'PENDING' && plugin.reviewStatus !== 'DRAFT')
  throw conflict('插件不在审核中且非草稿，无法直接审核');
// 后台 UI 对 PENDING/DRAFT 都显示审核按钮
{plugin.reviewStatus === 'PENDING' || plugin.reviewStatus === 'DRAFT' ? <Button>通过审核</Button> : null}
```

Reference files:
- `apps/collab-api/src/modules/admin.service.ts`（`adminApprovePlugin` / `adminRejectPlugin` 守卫放宽）
- `apps/collab-api/src/modules/admin.service.spec.ts`（DRAFT 审核 + 终态 conflict 用例）
- `apps/collab-admin/src/components/plugins-view.tsx`（审核按钮对 DRAFT 渲染）

## 插件版本升级覆盖（manifest.id 同一性，2026-07-07）

支持「同一插件的不同版本」：上传/导入时按 `manifest.id` 识别同插件，新版本覆盖旧版本（in-place 升级），而非创建无关联的新记录/目录。覆盖团队上传、本地上传、本地包导入三条路径。

### 1. Scope / Trigger
- Trigger: changing `uploadPlugin`（后端）、`editPluginDraft`（后端）、`publicAvailablePlugin`（后端）、`submitStagedPlugin`（前端）、`materializeZipPlugin`（前端）、`TeamPluginRow` 更新按钮、或插件版本升级流程。

### 2. Signatures
- 后端：`PluginService.uploadPlugin(userId, input) -> { plugin, deduplicated?, upgraded? }`
- 后端：`PluginService.editPluginDraft(userId, id, input) -> { plugin }`（已上架强制 semver 严格递增 + 通知已安装用户）
- 后端：`publicAvailablePlugin(plugin, currentTeamId)` 现在对本团队插件也注入 `installedVersion`
- 前端：`submitStagedPlugin(draft) -> { ok, name, upgraded? } | { ok:false, message }`
- 前端：`materializeZipPlugin(result, existingIds, existingVersions?) -> { id, source, upgraded }`
- 前端：`isVersionNewer(newVer, oldVer) -> boolean`（共享工具 `@/lib/version`）

### 3. Contracts — 同一性识别
- **团队/云端**：`manifest.id`（+ 团队）唯一标识一个插件。`uploadPlugin` 先 contentHash 去重；再按 `manifest.id` 查同团队已有插件（`findFirst` where `manifest.path['id']`）；命中 → 委托 `editPluginDraft(id, input)` in-place 升级，返回 `{ upgraded: true }`；否则新建。
- **本地**：插件目录名 = 身份（不变）。`.lfplugin` 包导入时，若现有同 id 插件且包版本更高（`isVersionNewer`）→ 用原 id 覆盖（不 dedupe 改名）；否则走 dedupe 改名逻辑。

### 3a. Contracts — 后端 uploadPlugin 升级委托
- `editPluginDraft` 复用：含权限校验（`ensurePluginManager`）、PENDING 检查、已上架 semver 严格递增、未上架 in-place 更新（打回 DRAFT）、`notifyNewVersion` 推送。
- 未上架插件（DRAFT/REJECTED）升级：in-place 更新不校验版本（允许 0.0.1→0.0.2），打回 DRAFT 重审。
- 已上架插件（APPROVED+marketplace）升级：强制 `isVersionNewer(newVersion, oldVersion)`，否则抛「版本号必须大于当前」。
- 返回 `{ plugin, upgraded: true }`；contentHash 相同 → `{ deduplicated: true }`；全新 → `{ deduplicated: false }`。

### 3b. Contracts — 前端本地包导入版本感知
- `materializeZipPlugin(result, existingIds, existingVersions)`：`existingVersions` 是 id→version 映射（调用方从 `scanPluginStatus` 的 items 构造）。
- `isUpgrade = existingVersions[baseId] && isVersionNewer(incomingVersion, existingVersion)`。
- 升级 → `finalId = baseId`（覆盖，不 dedupe），`upgraded: true`；非升级 → `finalId = dedupeImportId(baseId, existingIds)`，`upgraded: false`。

### 3c. Contracts — 本团队插件「更新」可见
- `publicAvailablePlugin` 原先对本团队插件（`isOwnTeam`）早返回不注入 `installedVersion` → 本团队插件看不到「更新」按钮。现改为本团队已安装插件也注入 `installedVersion`（从 `installations[0].version`）。
- `TeamPluginRow.hasUpdate = installedVersion && isVersionNewer(version, installedVersion)` 现对本团队作者/成员安装的旧版也成立。

### 4. Validation & Error Matrix
- 上传同 manifest.id 不同版本（未上架）→ in-place 升级，返回 `upgraded:true`，不新建。
- 上传同 manifest.id 已上架插件低版本 → 抛「版本号必须大于当前 X」。
- 上传同 contentHash → 返回 `deduplicated:true`，不新建不升级。
- 上传无同 manifest.id → 新建，返回 `deduplicated:false`。
- 本地导入包版本更高 → 覆盖原 id，`upgraded:true`；同版本/低版本 → dedupe 改名 `-2`，`upgraded:false`。
- `editPluginDraft` 命中 PENDING 插件 → 抛「审核中不能编辑」。

### 5. Good/Base/Bad Cases
- Good: 本地 videodl v0.1.0「发布到团队」→ 团队出现 v0.1.0；本地改代码升 version 到 v0.2.0 再「发布」→ 同一团队插件行 version 变 v0.2.0（不新增行），toast「已升级到 v0.2.0」。
- Good: 本地导入 videodl v0.2.0 包（现有 v0.1.0）→ 覆盖 `plugins_root/videodl/`，toast「已升级覆盖旧版本」，不改名。
- Base: 团队成员安装了作者的 v0.1.0，作者升 v0.2.0 → 团队列表该插件显示「更新 v0.2.0」按钮（`installedVersion=0.1.0 < version=0.2.0`）。
- Bad: 上传同 manifest.id 不同内容创建新 UUID 行（旧行为）→ 团队出现两条同名插件，无关联；正确做法是 uploadPlugin 委托 editPluginDraft。
- Bad: 本地导入高版本包走 dedupe 改名 → 出现 `videodl-2` 旧版残留；正确做法是版本感知覆盖原 id。

### 6. Tests Required
- 后端单测: `plugin.service.spec.ts` 覆盖同 manifest.id 升级（upgraded:true，走 update 不 create）、无同 id 新建、contentHash 去重。
- 前端单测: `plugin-package-zip.spec.ts` 覆盖高版本覆盖升级（upgraded:true，不 dedupe）、同版本/低版本 dedupe、`version.spec.ts` 覆盖 isVersionNewer。
- Full checks: `pnpm -C apps/collab-api test`, `pnpm -C apps/desktop test`, `pnpm -C apps/desktop typecheck`, `pnpm -C apps/desktop vite:build`。

### 7. Wrong vs Correct

Wrong:
```typescript
// 后端：上传同 id 不同版本创建新行
const plugin = await prisma.plugin.create({ ... }); // 新 UUID，与旧版无关联
```

Correct:
```typescript
// 后端：同 manifest.id 委托 editPluginDraft in-place 升级
const sameLogical = await prisma.plugin.findFirst({ where: { teamId, manifest: { path: ['id'], equals: manifestId } } });
if (sameLogical) {
  const { plugin } = await this.editPluginDraft(userId, sameLogical.id, input);
  return { plugin, upgraded: true };
}
```

Reference files:
- `apps/collab-api/src/modules/plugin.service.ts`（`uploadPlugin` manifest.id 匹配 + 委托 `editPluginDraft`）
- `apps/collab-api/src/modules/plugin-package.ts`（`publicAvailablePlugin` 本团队注入 `installedVersion`）
- `apps/desktop/src/lib/version.ts`（`isVersionNewer` / `parseVersion` 共享工具）
- `apps/desktop/src/lib/plugin-creator/creator-tools.ts`（`submitStagedPlugin` 透传 `upgraded`）
- `apps/desktop/src/lib/plugin-package-zip.ts`（`materializeZipPlugin` 版本感知覆盖）
- `apps/desktop/src/pages/plugins/use-local-import.ts`（`existingVersions` + 升级 toast）
- `apps/desktop/src/pages/plugins/LocalPluginsSection.tsx`（构造 `existingVersions` 传入）
- `apps/desktop/src/pages/plugins/TeamPluginRow.tsx`（`hasUpdate` 用共享 `isVersionNewer`）
