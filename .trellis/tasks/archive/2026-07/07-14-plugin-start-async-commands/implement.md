# Implement: 插件启动命令改 async

## 执行清单

### Step 1 — `PluginProcessTable` 加 Clone

- [ ] `apps/desktop/src-tauri/src/plugin_runner.rs:1064`：`#[derive(Default)]` → `#[derive(Clone, Default)]`
- 验证：字段 `inner: Arc<Mutex<...>>`，Clone 纯 Arc bump，语义正确。

### Step 2 — `start_installed_plugin` 改 async

- [ ] `apps/desktop/src-tauri/src/plugin_package_manager/commands.rs:93`：
  - `pub(crate) fn start_installed_plugin(...)` → `pub(crate) async fn start_installed_plugin(...)`
  - 前置步骤不变（`selected_release`、访问权校验、`mark_dependency_status(Preparing)`）
  - clone `app` / `process_table.inner()` / `bridge.inner()`，构造 `release_path: PathBuf`
  - `tauri::async_runtime::spawn_blocking(move || start_plugin_from_dir(...)).await.map_err(JoinError→String)?`
  - 后置 `match started` 逻辑不变（`Ready` + `activate_pending` / `Failed` + `discard_pending`）
- [ ] 顶部 import 补 `PathBuf`（若未在用），确认 `plugin_runner::start_plugin_from_dir` 可见性（已是 `pub(crate)`）。

### Step 3 — `start_plugin` 改 async

- [ ] `apps/desktop/src-tauri/src/plugin_runner.rs:1355`：
  - `pub fn start_plugin(...)` → `pub async fn start_plugin(...)`
  - `resolve_plugin_dir` 留体内（快，拿 owned `PathBuf`）
  - clone `app` / `process_table.inner()` / `bridge.inner()`
  - `spawn_blocking` 包 `start_plugin_from_dir`，`.await?` 处理 JoinError

### Step 4 — `start_builtin_plugin` 改 async

- [ ] `apps/desktop/src-tauri/src/main.rs:54`：
  - `fn start_builtin_plugin(...)` → `async fn start_builtin_plugin(...)`
  - 插件查找 + `canonicalize` 留体内
  - clone `app` / `process_table.inner()` / `bridge.inner()`
  - `spawn_blocking` 包 `start_plugin_from_dir`

### Step 5 — 编译验证

- [ ] `cargo check -p lingfang-desktop`（或对应 crate 名）通过
- [ ] `cargo clippy` 无新增 warning（特别留意 `async` 函数里的 `?` on State 借用、unused import）

### Step 6 — 行为验证（手动 / dev）

- [ ] dev 启动桌面端，安装一个带 requirements.txt 的 Python 插件，点启动：窗口可拖动、日志面板逐行实时出 pip 输出。
- [ ] 启动一个带 dependencies 的 Node 插件：窗口响应 + pnpm 输出实时流。
- [ ] 已有 venv（秒过路径）插件仍正常启动返回 pid。
- [ ] 触发一次失败（如故意写坏 requirements.txt）：错误信息正常展示。
- [ ] 启动后 stop 正常，进程退出仍 emit `plugin:exited`。

## 验证命令

```bash
cd apps/desktop/src-tauri
cargo check
cargo clippy
```

dev 行为验证：

```bash
# 在 apps/desktop 下按既有方式启动 dev（参考 run skill / package.json scripts）
```

## Review Gates

- Step 2-4 每步改完先 `cargo check` 再进下一步，定位 borrow / Send 错误更容易。
- Step 5 clippy 通过后再做 Step 6 行为验证。

## Rollback Points

- 任一 Step 编译不过：可单独把该命令 revert 回同步 `fn` 直接调用（功能不退化，只是仍有卡顿），其余 async 改动保留。
- 全量回滚：`git checkout` 这几个文件即可，`Clone` derive 留着无害。
