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
│   ├── .venv/                    # 仅 Python 插件（venv 隔离）
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
| `python` | `main.py` | 独立 venv 进程（GUI 自弹窗口） | 「运行」/「停止」+ 状态 |
| `nodejs` | `package.json` scripts.start | `pnpm start` 独立进程 | 「运行」/「停止」+ 状态 |

- **Python**：`ensure_python_venv` 检测 `.venv/` → 不存在则 `py -3 -m venv .venv`（300s）→ 有 `requirements.txt` 则 `pip install -r`（600s，幂等）→ `.venv/Scripts/python.exe -u main.py`（Windows）。
- **Node**：`ensure_node_dependencies` 有 `package.json` + 非空依赖 + `node_modules` 缺失 → `pnpm install`（回退 `npm install`，600s）→ `pnpm start`（回退 `npm start` / `node entry`）。
- **HTML**：`read_local_plugin_file` 读取 entry HTML → iframe srcDoc 渲染。iframe 去 `allow-same-origin` 形成 opaque origin，防越权访问 parent.__TAURI__/localStorage。

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

## 用户命名链路（AC1）

插件名由用户在上传时命名（不自动取 manifest.name）：

1. 创建期：`startNewSession` 从 Rust 返回的 `workspaceDir`（`plugins_root/<temp_id>/`）提取 plugin_id。
2. 上传时：`doUpload` 弹命名 Dialog → `safePluginId(name)` 转正式目录名 → `rename_plugin_dir(oldId, newId, title=name)` 改目录名 + 把用户名写入 `manifest.title`。
3. 展示：`scan_one_plugin` 的 `name = title ?? name_field ?? plugin_id`（title 优先）。
4. 草稿携带 `plugin_id` 落盘，切历史会话据此恢复 pluginId（状态走文件系统扫描）。

`rename_and_title`（`plugin_store.rs`）是 `rename_plugin_dir` 命令的底层方法（抽出为方法便于单测）：rename 目录 + 解析 manifest JSON 写入 title 字段（保留其他字段）。

Reference files:
- `apps/desktop/src-tauri/src/plugin_store.rs`（`rename_and_title`）
- `apps/desktop/src/pages/PluginCreatorHome.tsx`（`doUpload` / `startNewSession`）
- `apps/desktop/src/lib/plugin-draft.ts`（`parseManifest` 解析 title / `defaultEntryForRuntime`）

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

AI（claude/codex/opencode CLI）用 Write 工具写文件时 cwd = workspace_dir = `plugins_root/<id>/`，产出直接落持久化目录。

## system-prompt 传递（claude）

`start_session` 把 `system_prompt` 作为**独立 system message** 传给 claude（`--system-prompt <s>`），而非拼进 `-p` 用户消息。此前拼接方式导致 claude 把创建指令当普通用户文本弱化/忽略。追问（`send_input`）走 `--resume` 续接，system_prompt 恒 None（claude 恢复首轮 system prompt，避免与 `--resume` 冲突）。codex/opencode 签名对齐但忽略（system prompt 由各自配置文件注入，见 `cli_config.rs`）。

Reference files:
- `apps/desktop/src-tauri/src/code_assistant/adapters/claude.rs`（`build_args` 的 `system_prompt` 参数）
- `apps/desktop/src/lib/plugin-creator-protocol.ts`（`DEFAULT_CONVERSATION_SYSTEM_PROMPT` 三种 runtime 开发规范）

## 预览执行 vs 持久化运行

两条运行通道：
- **`run_plugin_script`（预览执行）**：创建期一次性 sandbox 执行，裸 `node <entry>` / `python <entry>`，捕获 stdout 进 UI，15s 超时。适合验证简单脚本。**对需专属运行时的插件（如 Electron，`scripts.start=electron .`）不适用**——`needs_runtime_start` 预检拦截并提示用持久化运行。
- **`start_plugin`（持久化运行）**：detached 独立进程，`pnpm install` + `pnpm start`，不捕获 stdout。创建器的 `ScriptPreviewPanel` 透传 `pluginId` 后走此通道（`usePersistent = Boolean(pluginId)`），让 Electron 等框架插件在创建期也能拉起。

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
