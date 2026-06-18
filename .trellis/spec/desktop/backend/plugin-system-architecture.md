# 插件系统 + SDK Runtime 架构与流程

## 整体架构

```
用户 ──→ 桌面客户端（Tauri 2 + React）
              │
              ├─ 创建器（对话式 AI 生成插件）
              │     ├─ ClaudeCode / Codex SDK Runtime（Rust reqwest 内置请求）
              │     ├─ AI 产出写入 plugins_root/<session_id>/（临时持久化目录）
              │     └─ 预览满意 → 上传时弹命名 Dialog → rename 目录为正式名
              │
              ├─ 插件运行（三类独立）
              │     ├─ HTML（CLIENT）→ iframe 内嵌显示
              │     ├─ Python → venv 隔离 + 独立进程（外部窗口）
              │     └─ Node.js → pnpm install + pnpm start（独立进程）
              │
              ├─ 插件管理
              │     ├─ 插件列表（文件系统扫描动态状态）
              │     ├─ 运行/停止（进程管理）
              │     └─ 设置（插件存放路径可配置）
              │
              └─ 后端（collab-api NestJS）
                    ├─ 插件上传/市场/安装/购买
                    ├─ 模型网关（provider 云分发 + apiKey 加密存储）
                    ├─ 检查更新（Tauri updater）
                    └─ 通知/审计/导出/注销
```

## 创建流程（对话 → 生成 → 预览 → 命名上传）

```
用户输入需求（如"做个番茄钟"）
  │
  ├─ 1. 对话：start_session（不传 pluginId）
  │     ├─ Rust 用 temp-<timestamp> 生成临时 plugin_id
  │     ├─ workspace = plugins_root/temp-xxx/（持久化，非临时 sandbox）
  │     └─ SDK Runtime 从平台解密 apiKey/apiUrl 后直接调用模型 API
  │
  ├─ 2. AI 生成：模型通过本地工具写入 manifest.json + 源码 → plugins_root/temp-xxx/
  │     ├─ Python：main.py（单一入口）
  │     ├─ Node.js：package.json + index.js
  │     └─ HTML：ui/index.html
  │
  ├─ 3. 预览：
  │     ├─ HTML → iframe 内嵌预览
  │     ├─ Python → sandbox 一次性预览（终端输出）
  │     └─ Node.js → sandbox 一次性预览
  │
  ├─ 4. 命名上传：
  │     ├─ 用户点「上传到团队共享」→ 弹命名 Dialog
  │     ├─ 用户填名（如"我的番茄钟"）→ safePluginId → uXXXX 编码
  │     ├─ Rust rename_plugin_dir：temp-xxx/ → 正式名/
  │     └─ POST /api/plugins/upload（manifest.name = 用户命名）
  │
  └─ 5. 发布市场（可选）：submit-marketplace → admin 审核 → 上架
```

## 运行流程（三类插件各自的运行方式）

### HTML（CLIENT 类型）
```
Plugins 页 → 点「打开」
  ├─ 读插件 ui/index.html 内容
  ├─ iframe srcDoc 渲染（内嵌软件内）
  └─ 关闭 = 移除 iframe
```

### Python（NODEJS... 不，PYTHON 类型）
```
Plugins 页 → 点「运行」
  ├─ start_plugin({ pluginId })
  │   ├─ 检查 .venv/ 是否存在
  │   ├─ 不存在 → python -m venv .venv（创建虚拟环境）
  │   ├─ 有 requirements.txt → .venv/bin/pip install -r
  │   ├─ 运行 .venv/Scripts/python.exe -u main.py（Win）
  │   │       .venv/bin/python -u main.py（Unix）
  │   ├─ 独立进程（detached Stdio::null + setsid）
  │   └─ GUI 应用自己弹窗口（PyQt5/Tkinter 等）
  │
  ├─ 软件显示「运行中」+ PID + 启动时间
  └─ 点「强制关闭」→ kill_child_tree（杀进程组含孙进程）
```

### Node.js（NODEJS 类型）
```
Plugins 页 → 点「运行」
  ├─ start_plugin({ pluginId })
  │   ├─ 有 package.json + dependencies → pnpm install
  │   ├─ 运行 pnpm start（回退 npm start → 裸 node entry）
  │   └─ 独立进程（同 Python，detached）
  │
  ├─ 软件显示「运行中」
  └─ 点「强制关闭」→ kill_child_tree
```

## SDK Runtime 系统架构（AI 生成插件的引擎）

```
桌面客户端
  ├─ 用户选执行器
  │   ├─ claude → 显示 ClaudeCode → Anthropic/Claude Messages API
  │   └─ codex → 显示 Codex → OpenAI-compatible Chat Completions API
  ├─ 用户选模型（自定义输入或从拉取结果选）
  │
  ├─ SDK 请求前凭据解析：
  │   ├─ 从后端 GET /api/llm/active-provider 拿 apiUrl
  │   ├─ 从后端 POST /api/llm/binding/decrypt 拿 apiKey 明文
  │   └─ 明文仅在 Rust 内存中用于本轮 reqwest 请求，不写临时 CLI 配置文件
  │
  ├─ SDK Runtime：
  │   ├─ ClaudeCodeEngine → POST {apiUrl}/v1/messages
  │   ├─ CodexEngine → POST {apiUrl}/v1/chat/completions
  │   └─ 多轮统一从 transcript/history 重建上下文
  │
  └─ 本地工具循环：
      ├─ list_directory / read_file / write_file / scan_workspace
      ├─ stdout → 正文文本（对话区）
      ├─ thought → 思考折叠区
      ├─ tool → 工具卡片
      └─ stderr → 诊断区（仅错误）
```

OpenCode、Claude CLI、Codex CLI 均不再是创建器执行器；前端不探测、不安装、不展示代码助手 CLI。Node.js / Python 的安装能力仅服务插件脚本运行时。

### Scenario: Code Assistant SDK Runtime Contract

#### 1. Scope / Trigger
- Trigger: changing `code_assistant_start_session`, `code_assistant_send_input`, provider catalog, local tools, or model credential resolution.

#### 2. Signatures
- Tauri commands kept stable:
  - `code_assistant_start_session(input: StartSessionInput) -> SessionRecord`
  - `code_assistant_send_input(input: SendInputInput) -> Result<(), String>`
  - `code_assistant_stop_session(input: StopSessionInput) -> Result<(), String>`
  - `code_assistant_scan_workspace(input: ScanWorkspaceInput) -> Vec<DraftFileJson>`
- Provider ids:
  - `claude` → display `ClaudeCode`
  - `codex` → display `Codex`

#### 3. Contracts
- Frontend sends `sdkConfig { backendUrl, authToken }` to Rust. Rust keeps `cliConfig` only as a serde alias for older payloads.
- Rust calls `/api/llm/active-provider` and `/api/llm/binding/decrypt`; missing backend URL, token, apiUrl, or apiKey is an explicit error.
- Provider mapping:
  - `anthropic` → only `ClaudeCode`
  - `openai`, `azure`, `deepseek`, `minimax`, `moonshot`, `qwen`, `custom`, unknown OpenAI-compatible providers → only `Codex`
- Session `commandPreview` is an SDK summary such as `["ClaudeCode SDK", model]`, not a shell command.
- Transcript events remain `input`, `output { stream, text }`, `error`, `exit`, `stopped`.
- `stop_session` cancels the in-memory SDK task and writes both `stopped` and `exit` transcript events; it does not kill a CLI process tree.
- Local tool writes accept only relative workspace paths; absolute paths, `..`, empty path segments, and hidden path segments are rejected.

#### 4. Validation & Error Matrix
- Missing `sdkConfig` -> `缺少模型服务配置，请先登录并配置平台模型服务`
- Missing backend URL or auth token -> `缺少后端地址或登录凭证，无法调用 SDK`
- Active provider or binding decrypt missing apiUrl/apiKey -> explicit model binding error
- SDK HTTP non-2xx -> `ClaudeCode SDK 返回错误：HTTP ...` or `Codex SDK 返回错误：HTTP ...`
- Tool write path absolute / parent traversal / hidden segment -> explicit path validation error in tool result

#### 5. Good/Base/Bad Cases
- Good: minimax active provider + model `minimax-m3` shows only Codex and calls `/v1/chat/completions` with that model.
- Base: Anthropic active provider shows only ClaudeCode and calls `/v1/messages`.
- Bad: falling back to a user-level Claude/Codex/OpenCode config, spawning a local CLI, or silently switching provider when SDK credentials fail.

#### 6. Tests Required
- Rust: SDK URL/body construction, tool path validation, transcript history reconstruction, stop-session stopped/exit events.
- Frontend: provider catalog never exposes OpenCode, settings page omits CLI install area, readiness does not require code assistant CLI.
- Full verification: `cargo test -p lingfang-desktop`, `pnpm -C apps/desktop test`, `pnpm -C apps/desktop typecheck`, `pnpm -C apps/desktop vite:build`, NSIS build.

#### 7. Wrong vs Correct
Wrong:
```rust
// Spawn a CLI and let it read user-level config as fallback.
Command::new("claude").arg("-p").arg(prompt).spawn()?;
```

Correct:
```rust
// Use decrypted platform credentials for the selected SDK runtime.
let credentials = resolve_sdk_credentials(input.sdk_config.as_ref()).await?;
code_assistant::start_session(app, state, input, session_id, credentials)
```

## 数据流总览

```
┌──────────────────────────────────────────────────────────┐
│                    桌面客户端（Tauri）                      │
│                                                          │
│  创建器 ──→ SDK Runtime + 本地工具 ──→ plugins_root/<id>/ │
│    │         │         ├─ manifest.json                   │
│    │         │         ├─ main.py / index.js / ui/        │
│    │         │         ├─ .venv/（Python）                │
│    │         │         ├─ node_modules/（Node）           │
│    │         │         └─ data/（运行数据持久化）          │
│    │         │                                            │
│    │    模型凭据 ←── 后端（collab-api）                    │
│    │      ├─ active-provider（apiUrl 云分发）              │
│    │      ├─ binding/decrypt（apiKey 解密）                │
│    │      └─ Rust reqwest 内存使用，不写 CLI 配置文件       │
│    │                                                      │
│  运行器 ──→ start_plugin ──→ 独立进程                      │
│    ├─ HTML → iframe                                       │
│    ├─ Python → venv python main.py（外部窗口）             │
│    └─ Node → pnpm start（外部终端）                        │
│                                                          │
│  上传 ──→ POST /api/plugins/upload                        │
│    └─ 命名 Dialog → rename_plugin_dir → 正式目录名          │
└──────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   PostgreSQL                    插件文件系统
   ├─ plugins（市场）             ├─ plugins/
   ├─ installations              │   ├─ temp-xxx/（创建期临时）
   ├─ purchases                  │   └─ 正式名/（上传后命名）
   └─ audit_logs                 └─ .lingfang/config.json
```

## 文件结构

```
app_data/
├── plugins/                    ← 插件根目录（设置页可配置）
│   ├── .lingfang/
│   │   └── config.json         ← 插件根目录配置（路径）
│   ├── temp-12345-67890/       ← 创建期临时目录（session_id 命名）
│   │   ├── manifest.json
│   │   ├── main.py
│   │   └── data/               ← 运行数据
│   └── my-clock/               ← 上传命名后的正式目录
│       ├── manifest.json
│       ├── main.py / index.js / ui/index.html
│       ├── .venv/              ← Python 虚拟环境
│       ├── node_modules/       ← Node 依赖
│       └── data/
└── code-assistant/             ← SDK 会话记录（transcript/sessions/drafts）
```

## 关键约束

- **不污染用户默认配置**：创建器不启动 Claude/Codex/OpenCode CLI，也不读写用户级 CLI 配置。
- **apiKey 不进前端**：Rust 内部调 decrypt 端点拿明文（经 HTTPS），不传给前端 webview。
- **SDK 失败显式暴露**：缺凭据、HTTP 错误、响应解析错误都返回错误，不做 CLI 或默认配置 fallback。
- **venv 隔离**：每个 Python 插件独立 .venv，互不影响。
- **进程安全**：detached + setsid/CREATE_NEW_PROCESS_GROUP，停止时 kill 整个进程树。
- **路径穿越防御**：plugin_id 段级白名单 [A-Za-z0-9_-]，canonicalize 前缀断言。
