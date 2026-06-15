# 插件系统 + CLI 系统架构与流程

## 整体架构

```
用户 ──→ 桌面客户端（Tauri 2 + React）
              │
              ├─ 创建器（对话式 AI 生成插件）
              │     ├─ claude / codex / opencode CLI（配置注入：平台 key + url）
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
  │     └─ CLI（claude/codex/opencode）启动，配置注入（平台 key/url/model）
  │
  ├─ 2. AI 生成：CLI 产出 manifest.json + 源码 → 写入 plugins_root/temp-xxx/
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

## CLI 系统架构（AI 生成插件的引擎）

```
桌面客户端
  ├─ 用户选 CLI（claude / codex / opencode）
  ├─ 用户选模型（自定义输入或从拉取结果选）
  │
  ├─ 启动前配置注入（cli_config.rs）：
  │   ├─ 从后端 GET /api/llm/active-provider 拿 apiUrl
  │   ├─ 从后端 POST /api/llm/binding/decrypt 拿 apiKey 明文
  │   ├─ 按 CLI 类型生成隔离配置：
  │   │   ├─ claude → env: ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY
  │   │   ├─ codex → CODEX_HOME=<临时目录>/config.toml（model_providers + key）
  │   │   └─ opencode → OPENCODE_CONFIG=<临时.json>（provider.options）
  │   └─ 配置写入 plugins_root/<session_id>/cli-configs/（会话结束清理）
  │
  ├─ CLI 启动（spawn）：
  │   ├─ codex exec --json --skip-git-repo-check（结构化 JSONL 输出）
  │   ├─ claude -p --output-format stream-json（流式思考/工具/文本分流）
  │   └─ opencode run（聚合输出）
  │
  └─ 输出分流（spawn_reader）：
      ├─ stdout → 正文文本（对话区）
      ├─ thought → 思考折叠区
      ├─ tool → 工具卡片
      └─ stderr → 诊断区（仅错误）
```

## 数据流总览

```
┌──────────────────────────────────────────────────────────┐
│                    桌面客户端（Tauri）                      │
│                                                          │
│  创建器 ──→ CLI ──→ plugins_root/<id>/                   │
│    │         │         ├─ manifest.json                   │
│    │         │         ├─ main.py / index.js / ui/        │
│    │         │         ├─ .venv/（Python）                │
│    │         │         ├─ node_modules/（Node）           │
│    │         │         └─ data/（运行数据持久化）          │
│    │         │                                            │
│    │    配置注入 ←── 后端（collab-api :3000）              │
│    │      ├─ active-provider（apiUrl 云分发）              │
│    │      ├─ binding/decrypt（apiKey 解密）                │
│    │      └─ cli-configs/<session>/（临时隔离配置）        │
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
├── cli-configs/                ← CLI 临时配置（会话结束清理）
│   └── <session_id>/
│       ├── config.toml         ← codex
│       └── opencode.json       ← opencode
└── code-assistant/             ← CLI 会话记录（transcript/sessions）
```

## 关键约束

- **不污染用户默认配置**：claude 用 env 注入；codex/opencode 用临时 CODEX_HOME/OPENCODE_CONFIG。
- **apiKey 不进前端**：Rust 内部调 decrypt 端点拿明文（经 HTTPS），不传给前端 webview。
- **venv 隔离**：每个 Python 插件独立 .venv，互不影响。
- **进程安全**：detached + setsid/CREATE_NEW_PROCESS_GROUP，停止时 kill 整个进程树。
- **路径穿越防御**：plugin_id 段级白名单 [A-Za-z0-9_-]，canonicalize 前缀断言。
