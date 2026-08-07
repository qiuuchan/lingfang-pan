# Node/Python 语言与本地预览执行 — 技术设计

> 关联父任务：`.trellis/tasks/06-13-plugin-creator-conversational-revamp/prd.md`（R3 项）。
> 本文聚焦子任务 `06-13-node-python-local-exec` 的技术方案，所有行号引用基于当前 `main` 分支（commit 1940804）。

---

## 1. 背景与目标

### 1.1 背景

当前插件创建链路仅支持 `client`（HTML/iframe）与 `cloud` 两种运行时（`packages/contract/src/plugin.ts:4` `z.enum(['client', 'cloud'])`）。对话式创建流程落地后，用户希望 AI 直接生成 Node.js / Python 这类「源码型」插件，并在上传云端前于本地预览运行，验证输出是否符合预期。

桌面壳侧已具备成熟的子进程基础设施（`apps/desktop/src-tauri/src/code_assistant.rs`：解释器探测、带超时的同步运行、跨平台进程 kill、sandbox 落盘），但目前仅服务于代码助手 CLI，未对「运行用户脚本」开放通道。前端预览面板（`apps/desktop/src/components/creator/panels/PreviewPanel.tsx`）是写死的 iframe `srcDoc`，无法承载终端型输出。

### 1.2 目标（呼应父 PRD R3）

- **R3.1 语言扩展**：支持生成 Node.js / Python 插件，按运行时分模板。
- **R3.2 本地预览执行**：桌面壳新增 `run_plugin_script` Tauri 命令，复用 `code_assistant.rs` 子进程骨架（探测解释器、超时、同步回传、sandbox 落盘）。预览为「无参数一次性运行 + 带超时」（已确认决策③）。
- **R3.3 预览分派**：`PreviewPanel` 按 `runtime_type` 分派：`client`→iframe，`nodejs/python`→终端输出组件。
- **R3.4 解释器缺失友好降级**：缺失时友好提示安装指引，并提供「仍要预览源码」降级。
- **R3.5 契约一并打通**（已确认决策②）：`RuntimeType` 扩为 `client|cloud|nodejs|python`，后端校验、Prisma enum、新迁移、前端类型全链路同步。

### 1.3 非目标（本轮不做）

- 不做 OS 级硬隔离（容器/seccomp/AppContainer 等）——本轮 sandbox 仅软隔离，留作后续独立大任务（见 §6）。
- 不做 Node/Python 插件的 Web 端云端执行——`nodejs/python` 上架后 Web 端仅可查看源码，由 UI 标注（见 §6）。
- 不做参数化输入与交互式长会话——首轮只支持无参数一次性运行（已确认决策③）。
- 不新增 `template` / `language` 冗余字段——语言由 `runtime_type` + `entry` 后缀推断（父 PRD 约束）。

---

## 2. 现状与问题（精确 file:line）

### 2.1 桌面壳：capability 网关只放行 fs.read / system.info

`apps/desktop/src-tauri/src/capability.rs`：

- `invoke`（`:72-89`）三步校验：manifest 声明 → 作用域白名单 → 执行。当前 `match kind`（`:84-87`）只分派 `"fs.read"`（`fs_read`，`:92-117`）与 `"system.info"`（`system_info`，`:137-150`），其余一律 `CapError::NotDeclared`。
- `DeclaredCapability`（`:24-30`）= `{ kind: String, paths: Vec<String> }`，是声明式白名单模型。
- **结论**：预览执行是「开发者侧主动运行自己刚生成的脚本」，与「插件运行态受控能力调用」语义不同。若强行塞进 `invoke`，会污染 capability 网关的声明/作用域语义。因此本子任务新建**独立的 `run_plugin_script` Tauri 命令**，不走 capability 网关（见 §3.1）。

### 2.2 code_assistant.rs：可复用的子进程骨架（私有函数）

`apps/desktop/src-tauri/src/code_assistant.rs`：

- `run_capture`（`:717-760`）：带超时的同步阻塞运行。`stdin(Stdio::null())` + piped stdout/stderr，轮询 `try_wait()` + `sleep 50ms`，超时则 `kill` + `wait_with_output` 收尾，返回 `CapturedOutput { stdout, stderr, exit_code, timed_out }`。**这是 `run_plugin_script` 的核心执行器原型**。
- `find_binary`（`:786-802`）：跨平台 PATH 探测，Windows 自动补 `.exe`。
- `find_command`（`:762-777`）：多候选解释器探测（按候选顺序返回首个命中）。
- `resolve_workspace`（`:819-833`）：workspace 目录校验（存在 + 是目录 + canonicalize）。
- `stop_child_process`（`:637-661`）：Unix `setsid` + `kill -PGID`、Windows `taskkill /T`。
- **问题**：这些函数目前是**私有函数**（`fn`，非 `pub`）。本子任务需将 `run_capture` / `find_binary` / `find_command` / `resolve_workspace` 提升为 `pub(crate)`，供 `plugin_script.rs` 复用（见 §3.4）。

### 2.3 进程生命周期：注册表 + 启动兜底 kill 已就绪

`apps/desktop/src-tauri/src/code_assistant/store.rs`：

- `register_process`（`:136-154`）：持久化 `pid` 到注册表 JSON。
- `cleanup_registered_processes`（`:156-196`）：启动时兜底 kill 上次未退出的进程（先 SIGTERM、等 1s、再 SIGKILL，跨平台 `kill_process`/`process_alive` 在 `:289-348`）。
- `main.rs:115-118`：已有 sandbox 落盘先例（`app_data_dir/claude-sandbox`）。
- **结论**：`run_plugin_script` 是「一次性同步运行 + 超时 kill」，**不需要**注册进 `CodeAssistantState.processes` 长生命周期表（那是给流式长会话用的）。超时由 `run_capture` 内部 `kill` 兜底即可。但「最终极兜底」仍可在文档标注：若未来支持交互式脚本，再纳入注册表。

### 2.4 前端 PreviewPanel：写死 iframe，不适应终端型输出

`apps/desktop/src/components/creator/panels/PreviewPanel.tsx:7-23`：

- `PreviewPanel({ files, previewKey, onRefresh })` 直接 `<iframe sandbox="allow-scripts" srcDoc={previewSrcDoc(files)} />`（`:16`）。
- `previewSrcDoc`（`apps/desktop/src/lib/plugin-draft.ts:274-285`）：读 `manifest.entry` 文件内容拼 `sdk` shim。**Node/Python 无 HTML 入口**，`previewSrcDoc` 会拿到 `.js`/`.py` 源码塞进 iframe，无意义。
- **结论**：`PreviewPanel` 需改为按 `parseManifest(files).runtime_type` 分派。

### 2.5 契约 / 后端 / Prisma：RuntimeType 只有二元

- 契约 `packages/contract/src/plugin.ts:4`：`z.enum(['client', 'cloud'])`。
- 后端 `apps/collab-api/src/modules/plugin-package.ts:82`：`if (runtime !== 'client' && runtime !== 'cloud') throw badRequest('runtime_type 只允许 client 或 cloud')` —— **Node/Python 上传会被 400 拒绝**。
- `:130`：`runtimeType: runtime === 'client' ? 'CLIENT' : 'CLOUD'` —— **头号陷阱**：三元会把 `nodejs`/`python` 全部误判为 `CLOUD`（见 §4.1）。
- `:34` / `:40`：`NormalizedPluginPackage` 的 `runtime_type` / `runtimeType` 类型也是二元字面量联合。
- Prisma `apps/collab-api/prisma/schema.prisma:56-59`：`enum PluginRuntimeType { CLIENT CLOUD }` —— 需加 `NODEJS` / `PYTHON` + 新迁移。
- 前端 `apps/desktop/src/lib/plugin-draft.ts:195`：`buildLocalDraft` 写死 `runtime_type: 'client'`（本子任务不直接改它，但下游依赖 R2 结构化产出会注入正确 runtime；见 §3.6）。

### 2.6 LoadedPlugin：manifest 弱类型

`apps/desktop/src/lib/types.ts:93-109`：`LoadedPlugin.manifest?: unknown`。前端读取 runtime 时只能走 `parseManifest`（`plugin-draft.ts:255-272`），它对 runtime 字段无校验，缺省回退 `client`。

---

## 3. 技术方案

### 3.1 边界

```
┌─────────────────────────────────────────────────────────────┐
│ 前端（apps/desktop/src）                                       │
│  PreviewPanel ─┬─ runtime=client ──→ IframePreview（现有）     │
│                └─ runtime=nodejs/python ──→ ScriptPreviewPanel │
│                      │                                         │
│                      ↓ tauriInvoke                             │
│  src/lib/plugin-script.ts（新增：类型 + invoke 封装）           │
└──────────────────────────┬──────────────────────────────────┘
                           │ run_plugin_script / probe_script_runtime
┌──────────────────────────┴──────────────────────────────────┐
│ 桌面壳（apps/desktop/src-tauri/src）                            │
│  plugin_script.rs（新增模块，#[tauri::command]）                │
│    ┌─ probe_script_runtime：find_binary 探测解释器+版本          │
│    └─ run_plugin_script：落盘 sandbox → run_capture 带超时       │
│  复用 code_assistant.rs（提升 pub(crate)）：                   │
│    find_binary / find_command / run_capture / resolve_workspace│
│  main.rs：generate_handler 注册两命令                          │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 契约变更（contract-first，详细执行顺序见 implement.md §3）

**`packages/contract/src/plugin.ts`**：

```ts
// :4  四值
export const RuntimeType = z.enum(['client', 'cloud', 'nodejs', 'python']);
```

`PluginManifest`（`:29-39`）的 `runtime_type` 字段自动随 enum 扩展（`RuntimeType.default('client')`），无需单独改。

**`apps/collab-api/src/modules/plugin-package.ts`**：

- `:34`：`runtime_type: 'client' | 'cloud'` → `'client' | 'cloud' | 'nodejs' | 'python'`
- `:40`：`runtimeType: 'CLIENT' | 'CLOUD'` → `'CLIENT' | 'CLOUD' | 'NODEJS' | 'PYTHON'`
- `:81-82`：校验放宽 ——
  ```ts
  const runtime = String(manifest.runtime_type || manifest.runtimeType || 'client').toLowerCase();
  if (!['client', 'cloud', 'nodejs', 'python'].includes(runtime)) {
    throw badRequest('runtime_type 只允许 client / cloud / nodejs / python');
  }
  ```
- `:121`（`normalizedManifest.runtime_type` cast）与 `:130`（`runtimeType` 映射）—— **头号陷阱修复**：用显式映射表替代三元：
  ```ts
  const RUNTIME_TYPE_MAP: Record<string, 'CLIENT' | 'CLOUD' | 'NODEJS' | 'PYTHON'> = {
    client: 'CLIENT',
    cloud: 'CLOUD',
    nodejs: 'NODEJS',
    python: 'PYTHON',
  };
  const runtimeType = RUNTIME_TYPE_MAP[runtime] ?? 'CLIENT';
  ```
  原代码 `runtime === 'client' ? 'CLIENT' : 'CLOUD'` 会让 `nodejs`/`python` 误落 `CLOUD`，是本子任务必须修复的隐藏 bug。
- `:171-172`：`publicPlugin` 透传 `runtimeType` / `runtime_type`（已是 `String(plugin.runtimeType).toLowerCase()`），enum 扩展后自动覆盖，**无需改动**（仅回归验证）。

**`apps/collab-api/prisma/schema.prisma:56-59`**：

```prisma
enum PluginRuntimeType {
  CLIENT
  CLOUD
  NODEJS   // 新增
  PYTHON   // 新增
}
```

**新迁移**（见 §5 迁移形状）：PG `ALTER TYPE "PluginRuntimeType" ADD VALUE` —— 注意 ADD VALUE 不能在事务块内执行（见 §6 风险）。

### 3.3 Rust：新增 `plugin_script.rs` 模块

**文件**：`apps/desktop/src-tauri/src/plugin_script.rs`（新建）

**职责**：

1. `probe_script_runtime(runtime)` → 探测解释器是否存在 + 版本。
2. `run_plugin_script(input)` → 落盘 + 运行 + 带超时回收。

**对外接口（`#[tauri::command]`）**：

```rust
use serde::{Deserialize, Serialize};

/// 运行时语言枚举（仅脚本型，不含 client/cloud）。
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptRuntime { Nodejs, Python }

#[derive(Deserialize)]
pub struct ScriptFile {
    pub path: String,       // 相对路径，防穿越校验
    pub content: String,
}

#[derive(Deserialize)]
pub struct RunPluginScriptInput {
    pub plugin_id: String,
    pub runtime: ScriptRuntime,
    pub entry: String,             // 运行入口相对路径，如 src/index.js / main.py
    pub files: Vec<ScriptFile>,
    pub timeout_ms: Option<u64>,   // 缺省 15000
}

#[derive(Serialize)]
pub struct ProbeResult {
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,   // 如 v20.11.0 / Python 3.12.1
    pub hint: Option<String>,      // 缺失时的安装指引文案
}

#[derive(Serialize)]
pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub elapsed_ms: u64,
}

#[tauri::command]
pub fn probe_script_runtime(runtime: ScriptRuntime) -> Result<ProbeResult, String> { ... }

#[tauri::command]
pub fn run_plugin_script(
    app: tauri::AppHandle,
    input: RunPluginScriptInput,
) -> Result<RunResult, String> { ... }
```

**核心实现要点**：

**(a) 解释器探测**（复用 `find_binary`）：

```rust
// Nodejs：优先 node（全平台），不假设有 nodejs/nvm 别名
// Python：跨平台探测顺序
//   Windows：py（官方 launcher，避免 python.exe 指向 Store stub）→ python → python3
//   Unix：python3 → python
let candidates = match runtime {
    ScriptRuntime::Nodejs => vec!["node"],
    ScriptRuntime::Python => {
        #[cfg(windows)] { vec!["py", "python", "python3"] }
        #[cfg(not(windows))] { vec!["python3", "python"] }
    }
};
```

探测命中后跑 `<binary> --version`（Node）或 `--version`（Python）取版本字符串。`find_binary` 已处理 Windows `.exe` 补全（`:793-799`）。

> 跨平台陷阱：Windows 上裸 `python` 可能是 Microsoft Store 的 stub（执行后弹商店而非报错）。**强制优先 `py` launcher**（与父 PRD「Python 脚本走 py launcher」约束一致），并用 `--version` 实跑确认非 stub（stub 通常不会在 stdout 打印 `Python x.y.z`，且会立刻退出非 0 或挂起 —— `run_capture` 超时兜底）。

**(b) sandbox 落盘**（复用 `main.rs:115-118` 的 app_data_dir 模式）：

```rust
let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
let sandbox = data_dir.join("plugin-sandbox").join(&input.plugin_id);
// 清空旧内容后重建，避免脏数据
let _ = std::fs::remove_dir_all(&sandbox);
std::fs::create_dir_all(&sandbox).map_err(|e| e.to_string())?;

for file in &input.files {
    let rel = sanitize_rel_path(&file.path)?;   // 防 .. 与绝对路径（见下）
    let abs = sandbox.join(&rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&abs, &file.content).map_err(|e| e.to_string())?;
}

let entry_abs = sandbox.join(sanitize_rel_path(&input.entry)?);
// canonicalize 后断言仍以 sandbox 为前缀（防符号链接逃逸）
let entry_canon = entry_abs.canonicalize().map_err(|e| e.to_string())?;
let sandbox_canon = sandbox.canonicalize().map_err(|e| e.to_string())?;
if !entry_canon.starts_with(&sandbox_canon) {
    return Err("entry 路径逃逸 sandbox".into());
}
```

`sanitize_rel_path` 复用后端 `cleanPath`（`plugin-package.ts:61-69`）的等价逻辑：禁绝对路径（`/`、`~`、`C:`）、禁空段、禁 `.`/`..`、禁隐藏系统段。**这是软隔离的第一道防线**（真隔离见 §6）。

**(c) 带超时一次性运行**（复用 `run_capture`）：

```rust
let (binary, mut args) = resolve_interpreter(runtime)?;  // 返回解释器路径 + 前置参数（如 py -3）
args.push(entry_canon.to_string_lossy().to_string());
let timeout = input.timeout_ms.unwrap_or(15_000);
let started = Instant::now();
let captured = run_capture(&binary, args, Some(sandbox_canon.to_str().unwrap()), timeout)?;
Ok(RunResult {
    stdout: captured.stdout,
    stderr: captured.stderr,
    exit_code: captured.exit_code,
    timed_out: captured.timed_out,
    elapsed_ms: started.elapsed().as_millis() as u64,
})
```

**(d) 环境裁剪**：`run_capture` 当前继承全量 env。本子任务需在 `run_plugin_script` 调用前构建一个**最小白名单 env** 传给子进程，避免泄漏宿主 token / 密钥到脚本：

```rust
fn minimal_env() -> Vec<(OsString, OsString)> {
    let keys = [
        "PATH",                     // 解释器/依赖查找必须
        "HOME", "USERPROFILE",      // Node/Python 用户级配置
        "APPDATA", "LOCALAPPDATA",  // Windows npm/pip 缓存定位
        "SystemRoot", "TEMP", "TMP",// Windows 系统调用与临时目录
        "LANG", "LC_ALL",           // 区域，避免乱码
    ];
    keys.iter()
        .filter_map(|k| std::env::var_os(k).map(|v| (OsString::from(k), v)))
        .collect()
}
```

> **决策**：`run_capture` 当前签名是 `run_capture(binary, args, workspace_dir, timeout_ms)`，内部用 `Command::new(binary)` 继承全 env。为不破坏现有 code_assistant 调用，新增一个 `run_capture_with_env(binary, args, workspace_dir, timeout_ms, env)`，`run_plugin_script` 调新函数；旧 `run_capture` 保持不变。两者共享轮询/超时/回收逻辑（抽到私有 helper `run_captured_inner`）。

**main.rs 注册**（`:193-207` `generate_handler!`）：

```rust
.invoke_handler(tauri::generate_handler![
    // ... 现有 ...
    plugin_script::probe_script_runtime,
    plugin_script::run_plugin_script,
])
```

并在 `main.rs` 顶部 `mod plugin_script;`。

### 3.4 code_assistant.rs：提升复用函数可见性

将以下私有函数改为 `pub(crate)`，供 `plugin_script.rs` 复用（不暴露给 crate 外，符合「最小可见性」）：

| 函数                | 当前行号 | 改动                                                                              | 用途                                             |
| ------------------- | -------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| `run_capture`       | `:717`   | 抽出 `run_captured_inner` 并 `pub(crate)`；新增 `pub(crate) run_capture_with_env` | 脚本带超时运行                                   |
| `find_binary`       | `:786`   | `fn` → `pub(crate) fn`                                                            | 解释器探测                                       |
| `find_command`      | `:762`   | `fn` → `pub(crate) fn`                                                            | 多候选探测（Python 跨平台顺序）                  |
| `resolve_workspace` | `:819`   | `fn` → `pub(crate) fn`                                                            | sandbox canonicalize（复用其 canonicalize 逻辑） |

> `stop_child_process`（`:637`）与 `spawn_waiter`/`spawn_reader` 是流式长会话专用，`run_plugin_script` 不复用（一次性同步运行由 `run_capture` 内部 kill 兜底）。

### 3.5 前端：新增 `plugin-script.ts` + `ScriptPreviewPanel`

**`apps/desktop/src/lib/plugin-script.ts`**（新建）—— 收纳类型与 invoke 封装：

```ts
import { tauriInvoke } from '@/lib/api';

export type ScriptRuntime = 'nodejs' | 'python';

export interface ScriptFile {
  path: string;
  content: string;
}

export interface ProbeResult {
  available: boolean;
  binaryPath?: string | null;
  version?: string | null;
  hint?: string | null;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  elapsedMs: number;
}

export function probeScriptRuntime(runtime: ScriptRuntime) {
  return tauriInvoke<ProbeResult>('probe_script_runtime', { runtime });
}

export function runPluginScript(input: {
  pluginId: string;
  runtime: ScriptRuntime;
  entry: string;
  files: ScriptFile[];
  timeoutMs?: number;
}) {
  return tauriInvoke<RunResult>('run_plugin_script', {
    input: {
      plugin_id: input.pluginId,
      runtime: input.runtime,
      entry: input.entry,
      files: input.files,
      timeout_ms: input.timeoutMs ?? null,
    },
  });
}

// 安装指引文案（缺失解释器时展示）
export const RUNTIME_INSTALL_HINT: Record<ScriptRuntime, string> = {
  nodejs:
    '未检测到 Node.js。请安装：访问 https://nodejs.org 下载 LTS，或运行 winget install OpenJS.Technology.NodeJS.LTS',
  python:
    '未检测到 Python。请安装：运行 winget install Python.Python.3.12，或访问 https://python.org 下载。Windows 推荐 py launcher。',
};
```

**`apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx`**（新建）：

- 终端样式 `<pre>` 渲染 `stdout` / `stderr`（等宽字体，github-dark 背景与 R4 高亮主题一致）。
- 顶部状态条：退出码（`exitCode`）、耗时（`elapsedMs`）、超时标记（`timedOut` 时显示「运行超时已终止」）。
- 「运行」按钮触发 `runPluginScript`，加载态 + 结果态切换。
- **缺失解释器降级**：首次进入先 `probeScriptRuntime`；`available=false` 时展示 `RUNTIME_INSTALL_HINT` + 两个按钮：
  - 「重试检测」—— 重新 `probe`（用户装完解释器后点）。
  - 「仍要预览源码」—— 切到只读源码视图（展示 entry 文件内容，等价于当前 iframe 退化但不执行）。

**`PreviewPanel.tsx` 改造**（`:7-23`）：

```tsx
import { parseManifest } from '@/lib/plugin-draft';
// 新增 ScriptRuntime 类型推断

export function PreviewPanel({ files, previewKey, onRefresh }) {
  const runtime = parseManifest(files).runtime_type;
  if (runtime === 'nodejs' || runtime === 'python') {
    return <ScriptPreviewPanel files={files} runtime={runtime} previewKey={previewKey} onRefresh={onRefresh} />;
  }
  // client（含默认）走原 iframe 逻辑
  return ( /* 现有 iframe JSX */ );
}
```

`parseManifest`（`plugin-draft.ts:255-272`）的 `runtime_type` 缺省回退 `client`（`:264`），无需改动——`nodejs/python` 由 R2 结构化产出注入 manifest，`parseManifest` 透传即可。`previewSrcDoc`（`:274-285`）仅 `client` 分支调用，不受影响。

> **数据来源**：`PreviewPanel` 的 `files` 由 `DetailsPanel.tsx:54` 传入（来自 `PluginDraft.files`）。Node/Python 草稿的 `files` 必须包含 `manifest.json`（含正确 `runtime_type`）+ 入口源码文件（如 `src/index.js` / `main.py`）。这部分**依赖 R2 结构化产出**（见 §4.2 与 implement.md §1）。

### 3.6 与 R2（结构化产出）的接口契约

本子任务**不实现** systemPrompt 协议与 `parseStructuredPackage`（那是 R2 的职责），但需与 R2 约定 manifest 字段：

| 字段           | Node                                 | Python                               | 说明                           |
| -------------- | ------------------------------------ | ------------------------------------ | ------------------------------ |
| `runtime_type` | `"nodejs"`                           | `"python"`                           | 驱动前端分派 + 后端映射        |
| `entry`        | `src/index.js` 等                    | `main.py` 等                         | `run_plugin_script` 的入口参数 |
| `files`        | 多文件（含 `package.json` 占位可空） | 多文件（含 `requirements.txt` 可空） | R2 解析产出                    |

本子任务**保证**：只要 `files` 含 `manifest.json` 且 `runtime_type ∈ {nodejs,python}`、`entry` 指向的文件存在于 `files`，`run_plugin_script` 即可运行。

---

## 4. 关键决策与权衡

### 4.1 头号陷阱：runtime_type 映射三元 → 显式映射表（已确认修复）

`plugin-package.ts:130` 原代码 `runtime === 'client' ? 'CLIENT' : 'CLOUD'` 是布尔二元假设。enum 扩展后若不改，`nodejs`/`python` 全部落 `CLOUD`，导致：

- 数据库存 `CLOUD`，但 manifest 存 `nodejs`/`python`，`publicPlugin` 透传出 `runtime_type: 'cloud'`（`:172`），前端 `loadPluginDocument`（`plugins-runtime.ts:81`）误按 cloud 走，行为错乱。
- 上架审核、marketplace 检索按 cloud 分类，统计失真。

**决策**：用 `RUNTIME_TYPE_MAP` 显式映射表（见 §3.2），`?? 'CLIENT'` 兜底未知值。这是本子任务的**一号正确性修复**，design 明确标注以备审查。

### 4.2 独立 run_plugin_script 命令，不污染 capability 网关（已确认）

capability 网关（`capability.rs:72-89`）是「插件运行态受控能力调用」的声明式白名单。预览执行是「开发者主动运行自己的脚本」，语义不同。若复用 `invoke`，要么得新增 `script.run` capability kind（污染白名单 + 让用户为本地预览声明能力），要么破坏三步校验语义。

**决策**：新建独立 `run_plugin_script` 命令，绕过 capability 校验。代价是**绕过了一个受控执行通道**——design 明确标注后续需把「执行用户脚本」纳入 `script.node` / `script.python` capability 体系（见 §6 安全边界）。

### 4.3 一次性运行 + 超时，不做交互式（已确认决策③）

首轮只支持无参数一次性运行（`run_capture` 模式）。理由：

- 交互式（stdin 流式喂入）需复用 `spawn_reader`/`spawn_waiter`（`:574-707`）长生命周期表 + 注册表，复杂度高。
- 预览的核心诉求是「验证脚本能跑出预期 stdout」，一次性运行足够。
- 超时（默认 15s）防止死循环脚本挂起 UI。

权衡：缺 stdin 意味着需要交互输入的脚本（如 `input()`）会在等待输入时超时。UI 在超时文案中提示「本预览不支持交互式输入」。

### 4.4 env 最小白名单，不全量继承

`run_capture` 现状继承全 env（含潜在 `LINGFANG_TOKEN`、CLI key 等）。`run_plugin_script` 改用最小白名单 env（§3.3 (d)）。

权衡：可能导致某些依赖环境变量的脚本（如 `process.env.MY_VAR`）在预览中行为与真实运行不一致。可接受——预览是「能跑起来看 stdout」，不是「100% 复现生产环境」。

### 4.5 解释器探测顺序：Windows Python 强制 py launcher（已确认约束）

Windows 裸 `python` 常是 Store stub。强制 `py` → `python` → `python3` 顺序，并用 `--version` 实跑确认非 stub（stub 不在 stdout 打印 `Python x.y.z`）。

---

## 5. 兼容性 / 迁移 / 回滚形状

### 5.1 契约扩展（破坏性，但向后兼容运行时）

`RuntimeType` 从二元扩到四值是**枚举扩展**，对现有 `client`/`cloud` 数据无影响（旧值仍在新集合内）。`z.enum` 扩展不破坏旧数据反序列化。唯一破坏点是后端 `:130` 三元映射（§4.1 已修）。

### 5.2 Prisma 迁移形状（PG ADD VALUE）

新迁移目录：`apps/collab-api/prisma/migrations/<timestamp>_plugin_runtime_nodejs_python/migration.sql`

```sql
-- 扩展 PluginRuntimeType 枚举：新增 NODEJS / PYTHON
-- 注意：PostgreSQL 的 ALTER TYPE ... ADD VALUE 不能在事务块内执行。
-- Prisma migrate dev 默认逐条执行（非单事务），可直接用；
-- 若用 --create-only 生成后需人工确认 SQL 顶部无 BEGIN/COMMIT 包裹。
ALTER TYPE "PluginRuntimeType" ADD VALUE IF NOT EXISTS 'NODEJS';
ALTER TYPE "PluginRuntimeType" ADD VALUE IF NOT EXISTS 'PYTHON';
```

> `IF NOT EXISTS` 保证幂等（重复 migrate 不报错）。`ADD VALUE` 在 PG <12 不能用于已有数据的枚举的某些场景，本项目 PG18 无此限制（记忆 MEMORY.md「PostgreSQL 配置」：原生 PG18 localhost:5432）。

### 5.3 回滚形状

- **契约/后端**：git revert 合并提交即可，Prisma 迁移回滚需 `prisma migrate resolve --rolled-back` + 手动清理（ADD VALUE 无法 DROP，只能整体重建枚举）。**建议回滚策略**：保留 enum 扩展（无害），仅 revert 前端/Rust 代码。新增的 NODEJS/PYTHON 值不被使用即等于回滚。
- **前端**：`PreviewPanel` 回退到纯 iframe（git revert），不影响现有 client 预览。
- **Rust**：移除 `mod plugin_script;` + 两命令注册 + 提升可见性的 `pub(crate)`（改回 `fn`）。提升可见性本身无运行时影响。

---

## 6. 安全与风险

### 6.1 核心风险：run_plugin_script 是不受控执行通道（明确标注）

`run_plugin_script` 绕过 capability 网关，在用户权限下执行任意 Node/Python 代码。

- **本轮 sandbox 仅软隔离**：路径穿越防（`sanitize_rel_path` + canonicalize 前缀断言）、env 白名单、超时 kill、stdin=null。
- **可逃逸**：用户权限运行的脚本可执行 `fs.writeFile`、`child_process`、网络请求等，影响用户文件系统（与本地直接 `node main.js` 等价风险）。
- **真隔离留后续大任务**：OS 级隔离（Windows AppContainer / Linux bubblewrap 或 firejail / macOS sandbox-exec）需独立设计、独立测试、独立迁移，**不在本子任务范围**。design 在此处明确留痕，避免误判为已安全。

> 后续纳入 capability 体系：新增 `script.node` / `script.python` capability kind，让预览执行也走声明式授权（届时 `run_plugin_script` 改为先查 `CapabilityRegistry`）。本子任务在 capability.rs 顶部注释预留 TODO。

### 6.2 路径穿越攻击面

恶意 manifest 的 `entry` 或 `files[].path` 可能含 `../../etc/passwd` 或绝对路径。防线：`sanitize_rel_path`（§3.3 (b)）+ canonicalize 后 `starts_with(sandbox_canon)` 双重校验。已有后端 `cleanPath`（`plugin-package.ts:61-69`）经验可参照。

### 6.3 PG ADD VALUE 事务陷阱

`ALTER TYPE ... ADD VALUE` 不能在事务块内执行。若迁移 SQL 被 `BEGIN/COMMIT` 包裹会报错。缓解：`prisma migrate dev --create-only` 生成后人工检查 SQL，确认无事务包裹；迁移应用用标准 `prisma migrate deploy`/`dev`。

### 6.4 跨平台解释器探测不确定性

- Windows `python` Store stub：用 `py` launcher 优先 + `--version` 实跑确认（§4.5）。
- macOS 系统自带 `python3` 可能版本过旧（如 3.9），但不影响「能跑」——版本号在 `ProbeResult.version` 暴露给用户，由用户判断。
- Linux `node` 可能不存在（仅 `nodejs`）：探测候选加 `nodejs`（`["node", "nodejs"]`）。

### 6.5 Node/Python 上架后 Web 端无法运行

`nodejs/python` 插件上架 marketplace 后，Web 端（非桌面壳）无 `run_plugin_script`，无法运行。UI 需在插件详情页标注「此插件为脚本型，仅桌面端可运行预览」。本子任务在前端 `ScriptPreviewPanel` 顶部加提示，并在 `publicPlugin` 消费侧（`plugins-runtime.ts`）对 `nodejs/python` runtime 不走 iframe（直接显示「请用桌面端运行」占位）。

### 6.6 RuntimeType 二元假设审查

除 `:130` 三元映射（§4.1），需全局审查是否有其他 `runtime === 'client' ? ... : ...` 二元假设：

- `plugin-package.ts:121`（`runtime as 'client'|'cloud'` cast）—— 类型扩展后 cast 范围跟随扩展，无害。
- 前端 `loadPluginDocument`（`plugins-runtime.ts:81`）—— 按 builtin/packaged 二分，不按 runtime 二分，**无问题**。
- `invokeRuntime`（`plugins-runtime.ts:114-137`）—— 按 builtin/cloud 分派能力，与 runtime_type 无关，**无问题**。

---

## 7. 验证策略（本地可重复）

### 7.1 契约与后端单元测试

- `pnpm --filter @lingfang/contract typecheck`（确认 `RuntimeType` 四值类型无破坏）。
- `apps/collab-api` 新增/扩展 `plugin-package.spec.ts`：断言 `normalizePluginPackage` 对 `nodejs`/`python` 的 manifest 返回正确 `runtimeType`（`NODEJS`/`PYTHON`），且 `runtime_type` 透传。断言 `RUNTIME_TYPE_MAP` 不再把 nodejs/python 落到 CLOUD（覆盖 §4.1 头号陷阱）。
- `pnpm --filter collab-api test` 回归（含现有 `plugin.service.spec`）。
- Prisma 迁移：本地 `psql` 或 `prisma migrate dev` 应用后 `\dT "PluginRuntimeType"` 确认含 NODEJS/PYTHON。

### 7.2 Rust 单元测试 + 集成

- `cargo test -p lingfang-desktop`（确认可见性提升不破坏现有 code_assistant 测试）。
- 新增 `plugin_script.rs` 内 `#[cfg(test)]`：用临时 sandbox 写一个 `console.log("ok")` 的 Node 脚本 + 一个 `print("ok")` 的 Python 脚本，断言 `run_plugin_script` 返回 `stdout` 含 `ok`、`exit_code=0`、`timed_out=false`。
- 超时测试：写一个 `while True` 死循环脚本，断言 `timed_out=true` 且 `elapsed_ms` ≈ 超时值。
- 路径穿越测试：`entry="../escape.js"` 断言返回错误。

### 7.3 前端验证

- `pnpm --filter desktop typecheck`。
- 手动：构造一个 `runtime_type=nodejs` 的 `PluginDraft.files`（含 `manifest.json` + `src/index.js`），在 Creator 预览面板点击「运行」，确认终端输出 stdout。
- 缺失解释器验证：临时改坏 PATH 或用不存在 runtime，确认 `ScriptPreviewPanel` 展示安装指引 + 降级按钮。
- `pnpm --filter desktop build` 确认产物构建通过。

### 7.4 端到端（依赖 R2）

AC3 验证：分别生成 Node.js 与 Python 插件 → 预览执行展示 stdout → 解释器缺失时友好提示。需 R2 结构化产出就绪后联调。

---

## 8. 文件清单（新增 / 修改）

**新增**：

- `apps/desktop/src-tauri/src/plugin_script.rs`（Rust 命令模块）
- `apps/desktop/src/lib/plugin-script.ts`（前端类型 + invoke 封装）
- `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx`（终端预览组件）
- `apps/collab-api/prisma/migrations/<timestamp>_plugin_runtime_nodejs_python/migration.sql`
- `apps/collab-api/src/modules/plugin-package.spec.ts`（新增或扩展，覆盖 §4.1）

**修改**：

- `packages/contract/src/plugin.ts:4`（RuntimeType 四值）
- `apps/collab-api/src/modules/plugin-package.ts:34,40,81-82,121,130`（类型 + 校验 + 映射表）
- `apps/collab-api/prisma/schema.prisma:56-59`（enum 扩展）
- `apps/desktop/src-tauri/src/code_assistant.rs:717,762,786,819`（函数可见性提升 + 抽 inner）
- `apps/desktop/src-tauri/src/main.rs:193-207`（注册两命令）+ 顶部 `mod plugin_script;`
- `apps/desktop/src/components/creator/panels/PreviewPanel.tsx:7-23`（runtime 分派）
- `apps/desktop/src/lib/types.ts`（可选：`LoadedPlugin` 增加 `runtimeType?: ScriptRuntime` 字段，弱化 `manifest: unknown`）
