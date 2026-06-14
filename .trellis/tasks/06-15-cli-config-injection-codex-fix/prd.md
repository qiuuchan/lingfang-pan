# CLI 配置注入（key+apiUrl 隔离写入）+ codex 可用性

## Goal（目标）

1. 用户在设置页填的 apiKey + 平台维护的 provider apiUrl，**自动写入对应 CLI 的配置**（claude/codex/opencode），让 CLI 用平台指定的模型源而非 CLI 默认配置。
2. **不污染用户默认配置**：用独立临时配置目录/文件（CODEX_HOME / OPENCODE_CONFIG / claude 的 env 隔离），软件启动 CLI 时指向它，用户的 `~/.codex` `~/.claude` 等默认配置不受影响。
3. **修复 codex 可用性**：codex exec 当前只传 prompt+model，缺配置注入导致用默认 OpenAI（无 key 失败）+ 思考/工具输出未流式。

## 背景

当前桌面 Rust `code_assistant::start_session` spawn CLI 时**不注入任何 env/配置**（build_spawn_command 只设 stdin/stdout/stderr）。CLI 用各自默认配置（`~/.codex/config.toml`、`~/.claude.json`、`~/.config/opencode`），这些默认配置里的 key/url 是用户自己装的，**不是平台分发的那套**。

模型网关 v3 已让用户在设置页填 apiKey + 平台维护 provider apiUrl（active-provider）。现在要把这俩值**桥接进 CLI 启动**，让 CLI 真正用平台的模型源。

## 三 CLI 配置注入机制（已查 context7 官方文档）

| CLI | 隔离机制 | 注入内容 | 注入方式 |
|---|---|---|---|
| **claude** | 环境变量（无需配置文件） | `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` | spawn 时 `.envs([...])`（最简单）|
| **codex** | `CODEX_HOME=<临时目录>` | 临时目录放 `config.toml`：`[model_providers.lingfang]` + `base_url` + `api_key` + `wire_api`；`model_provider = "lingfang"` | spawn 时 `.env("CODEX_HOME", <临时目录>)` |
| **opencode** | `OPENCODE_CONFIG=<临时文件.json>` | 临时 json：`provider.lingfang.options.{baseURL, apiKey}` + `model` | spawn 时 `.env("OPENCODE_CONFIG", <临时文件>)` |

**关键**：每个 CLI 都支持「指定独立配置」，天然不污染默认。claude 最简单（纯 env），codex/opencode 要生成临时配置文件（放 app_data/cli-configs/<sessionId>/）。

## codex 可用性修复（任务4）

codex `exec` 当前问题：
1. **无配置注入** → 用默认 OpenAI（用户没装 key 就失败）。修复：上面 CODEX_HOME + config.toml。
2. **思考/工具输出未流式**：codex `exec` 默认输出是最终结果，要看思考+工具需 `--output-last-message` 或 json 流。查 codex 文档确认 `exec` 是否支持 `--json` 流式输出思考/工具（若不支持，codex 的思考/工具展示降级为「最终结果聚合」，与 claude 的 stream-json 不同，文档标注）。

## Scope（范围）

### R1 桌面 Rust：CLI 配置注入（新 `cli_config.rs`）
- 新建 `apps/desktop/src-tauri/src/cli_config.rs`：
  - `prepare_cli_env(tool, api_key, api_url, session_id) -> Vec<(OsString, OsString)>`：按 tool 生成 env 列表：
    - claude：`[("ANTHROPIC_BASE_URL", api_url), ("ANTHROPIC_API_KEY", api_key)]`。
    - codex：生成临时 `app_data/cli-configs/<session_id>/config.toml`（含 model_providers + base_url + api_key），返 `[("CODEX_HOME", <临时目录>)]`。
    - opencode：生成临时 `app_data/cli-configs/<session_id>/opencode.json`，返 `[("OPENCODE_CONFIG", <临时文件>)]`。
  - 临时配置文件生成函数（codex 的 TOML / opencode 的 JSON），含 redact（不打印 key）。
- `code_assistant::start_session` / `send_input`：spawn 时 `.envs(prepare_cli_env(...))`（替换当前不设 env 的 build_spawn_command 调用）。
  - **来源**：apiKey 从后端 `POST /api/llm/binding/decrypt` 解密拿明文（已有端点）；apiUrl 从 `GET /api/llm/active-provider` 拿。
  - 在 start_session 前先调这俩端点（桌面 Rust 内 fetch，或前端拿好传入 invoke）。

### R2 codex 可用性（codex.rs adapter）
- `codex.rs build_args`：若 codex exec 支持 `--json` / 流式思考输出，加上；否则文档标注 codex 思考/工具为聚合输出（不流式）。
- 查 codex exec 的输出 flag（context7 已查，需确认 `--output-last-message` / json 流）。

### R3 前端
- ModelGatewayTab 已有 apiKey 输入 + active-provider。启动 CLI 时（PluginCreatorHome 的 start_session）自动带上 key+url（前端从 binding 解密拿 key，从 active-provider 拿 url，传给 start_session invoke）。
- 或：桌面 Rust 内部自己调后端拿（更安全，key 不进前端）。**选 Rust 内部调**（key 不经前端 webview）。

## Constraints

- 简体中文。UTF-8 无 BOM。专用工具。
- **不污染默认配置**：必须用 CODEX_HOME/OPENCODE_CONFIG/env 隔离，绝不写用户的 ~/.codex 等。
- **key 不进前端 webview**：桌面 Rust 内部调 decrypt 端点拿明文（经 HTTPS），不传给前端。
- 复用：credential-cipher 解密、active-provider 端点、ensureTeamAdmin 鉴权全保留。
- codex 思考/工具流式若 CLI 不支持，诚实标注降级（不硬造）。

## Acceptance Criteria

- [ ] AC1 启动 claude 会话：用平台的 apiUrl + apiKey（ANTHROPIC_BASE_URL/KEY），不用 claude 默认配置。
- [ ] AC2 启动 codex 会话：CODEX_HOME 指向临时目录，config.toml 含平台的 apiUrl+key，~/.codex 不被修改。
- [ ] AC3 启动 opencode 会话：OPENCODE_CONFIG 指向临时 json，~/.config/opencode 不被修改。
- [ ] AC4 未填 apiKey 或无 active-provider 时，降级为原行为（不注入配置，用 CLI 默认），不崩。
- [ ] AC5 codex exec 能成功执行（用平台的 key+url），输出可见。
- [ ] AC6 codex 思考/工具输出：若 CLI 支持流式则流式展示，否则标注降级（聚合输出）。
- [ ] AC7 临时配置文件清理：会话结束后 app_data/cli-configs/<sessionId>/ 清理（或定期清理）。
- [ ] AC8 key 不进前端 webview（Rust 内部调 decrypt）。
- [ ] AC9 cargo test + desktop typecheck/build 全绿。

## 实施顺序

1. cli_config.rs（三 CLI 的 env/配置生成 + 单测）。
2. code_assistant spawn 注入 env（start_session + send_input）。
3. Rust 内部调 decrypt + active-provider 拿 key/url（新 tauri command 或 spawn 前内部 fetch）。
4. codex.rs 思考/工具输出 flag（查文档确认）。
5. 实测：真实填 key + 启动三个 CLI 验证。

## Notes

- 三 CLI 配置机制已查 context7 官方文档（codex CODEX_HOME + config.toml model_providers；claude ANTHROPIC_BASE_URL/KEY env；opencode OPENCODE_CONFIG + provider.options）。
- design.md 不单写（技术路径在本 prd 已清晰，实施按上述顺序）。
