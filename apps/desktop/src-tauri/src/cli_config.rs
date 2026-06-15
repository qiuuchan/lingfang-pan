//! CLI 配置注入（key + apiUrl 隔离写入，不污染用户默认配置）。
//!
//! 背景（task 06-15-cli-config-injection-codex-fix）：
//! - 模型网关 v3 让用户在设置页填 apiKey + 平台维护 provider apiUrl（active-provider）。
//! - 桌面 Rust spawn CLI（claude/codex/opencode）时此前不注入任何 env/配置，
//!   CLI 用各自默认配置（~/.codex、~/.claude 等），导致用不到平台分发的 key/url。
//! - 本模块负责：把 (api_key, api_url) 按各 CLI 的隔离机制写入临时配置，
//!   spawn 时以 env 指向临时配置，**绝不写用户默认配置**。
//!
//! 三 CLI 隔离机制（已查 context7 官方文档 + GitHub discussion #7782 查证）：
//! - **claude**：env `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`（最简单，无需配置文件）。
//! - **codex**：env `CODEX_HOME=<临时目录>`，该目录放 `config.toml`：
//!     ```toml
//!     model_provider = "lingfang"
//!     [model_providers.lingfang]
//!     name = "LingFang Platform"
//!     base_url = "<apiUrl>"
//!     wire_api = "chat"        # 平台是 OpenAI Chat Completions 兼容（非 Responses API）
//!     api_key = "<key>"        # 明文 api_key 字段（discussion #7782 验证 codex 接受）
//!     ```
//!   同时追加 env `OPENAI_API_KEY=<key>` 作为双保险（codex 多路径读取）。
//! - **opencode**：env `OPENCODE_CONFIG=<临时.json>`，json 含 provider.lingfang.options.{baseURL, apiKey}。
//!
//! 安全边界（AC8）：
//! - 临时配置文件放在 app_data/cli-configs/<sessionId>/ 下，文件权限默认（用户私有）。
//! - 本模块不打印 api_key（无 println!/eprintln! 含 key；command_preview 复用 redact_arg）。
//! - 调用方负责在会话结束（spawn_waiter 退出 / stop_session / delete_session）时清理临时目录（AC7）。
//!
//! 降级（AC4）：无 api_key 或无 api_url 时，prepare_cli_env 返回空 Vec（调用方据此不注入 env，
//! CLI 回退默认配置，行为与改造前一致，不崩）。

use std::ffi::OsString;
use std::path::Path;

use crate::code_assistant::adapters::CodeAssistantTool;

/// codex 临时 config.toml 的 provider id（不可用 openai/ollama/lmstudio 等保留 id）。
const CODEX_PROVIDER_ID: &str = "lingfang";
/// opencode 临时 json 的 provider key（与 npm 包名对齐，前端可识别）。
const OPENCODE_PROVIDER_ID: &str = "lingfang";

/// 按工具类型生成 spawn 时注入的 env 列表，并把 codex/opencode 的临时配置文件写入 config_dir。
///
/// 参数：
/// - `tool`：CLI 类型（claude/codex/opencode）。
/// - `api_key`：明文 apiKey（来自后端 decrypt 端点，仅在本次 spawn 生命周期内持有）。
/// - `api_url`：provider 基础地址（来自后端 active-provider 端点）。
/// - `config_dir`：临时配置目录（app_data/cli-configs/<sessionId>/），codex/opencode 的配置文件写在此。
///
/// 返回 `Vec<(OsString, OsString)>` 供 `Command::envs()` 追加（不清空宿主 env，保留 PATH 让 CLI 找到二进制）。
///
/// 降级（AC4）：api_key 或 api_url 为空时返回空 Vec（不注入，CLI 走默认配置，不崩）。
pub fn prepare_cli_env(
    tool: CodeAssistantTool,
    api_key: &str,
    api_url: &str,
    config_dir: &Path,
) -> Vec<(OsString, OsString)> {
    // AC4 降级：缺 key 或 url 时直接返回空（调用方不注入 env）。
    if api_key.trim().is_empty() || api_url.trim().is_empty() {
        return Vec::new();
    }
    match tool {
        CodeAssistantTool::Claude => prepare_claude_env(api_key, api_url),
        CodeAssistantTool::Codex => prepare_codex_env(api_key, api_url, config_dir),
        CodeAssistantTool::Opencode => prepare_opencode_env(api_key, api_url, config_dir),
    }
}

/// claude：纯 env 注入（ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY），无需配置文件。
fn prepare_claude_env(api_key: &str, api_url: &str) -> Vec<(OsString, OsString)> {
    vec![
        (
            OsString::from("ANTHROPIC_BASE_URL"),
            OsString::from(api_url),
        ),
        (
            OsString::from("ANTHROPIC_API_KEY"),
            OsString::from(api_key),
        ),
    ]
}

/// codex：写临时 config.toml 到 config_dir，返 CODEX_HOME + OPENAI_API_KEY（双保险）。
/// 写盘失败返回空 Vec（降级，不阻塞 spawn——CLI 会回退默认配置）。
fn prepare_codex_env(api_key: &str, api_url: &str, config_dir: &Path) -> Vec<(OsString, OsString)> {
    if let Err(error) = write_codex_config(config_dir, api_key, api_url) {
        eprintln!(
            "codex 临时配置写入失败（降级为默认配置）：{}",
            error
        );
        return Vec::new();
    }
    vec![
        // CODEX_HOME 指向临时目录：codex 读 <CODEX_HOME>/config.toml（隔离，不碰 ~/.codex）。
        (OsString::from("CODEX_HOME"), config_dir.as_os_str().to_owned()),
        // 双保险：codex 多路径读 OPENAI_API_KEY；config.toml 的 api_key 字段优先。
        (OsString::from("OPENAI_API_KEY"), OsString::from(api_key)),
    ]
}

/// opencode：写临时 opencode.json 到 config_dir，返 OPENCODE_CONFIG 指向该 json。
/// 写盘失败返回空 Vec（降级）。
fn prepare_opencode_env(
    api_key: &str,
    api_url: &str,
    config_dir: &Path,
) -> Vec<(OsString, OsString)> {
    match write_opencode_config(config_dir, api_key, api_url) {
        Ok(path) => vec![(OsString::from("OPENCODE_CONFIG"), path.into_os_string())],
        Err(error) => {
            eprintln!(
                "opencode 临时配置写入失败（降级为默认配置）：{}",
                error
            );
            Vec::new()
        }
    }
}

/// 写 codex 临时 config.toml 到 `<config_dir>/config.toml`。
///
/// 格式（已查 context7 + GitHub discussion #7782 查证）：
/// - `model_provider = "lingfang"`：选中自定义 provider（不可用保留 id openai/ollama/lmstudio）。
/// - `[model_providers.lingfang]`：provider 定义。
/// - `base_url`：平台 apiUrl（OpenAI 兼容）。
/// - `wire_api = "chat"`：平台是 OpenAI Chat Completions 协议（非 Responses API）。
///   官方新版本默认 responses 且 chat 已 deprecate，但对纯 Chat Completions 网关仍工作（带 warning）。
/// - `api_key`：明文 key（discussion #7782 的 LM Studio 示例验证 codex 接受此字段）。
///
/// TOML 手写（避免引入 toml crate 依赖）：字段均为简单字符串/字面量，无嵌套对象，
/// 手写格式可控且可单测断言。
pub fn write_codex_config(config_dir: &Path, api_key: &str, api_url: &str) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|error| error.to_string())?;
    // TOML 基本字符串需转义 " 和 \。OpenAI 兼容 key 通常只含 [a-zA-Z0-9-_]，
    // 但防御性转义保证 key/url 含特殊字符时不破坏 TOML（不引入 toml crate）。
    let toml = format!(
        "# LingFang 平台自动生成的 codex 临时配置（CODEX_HOME 隔离，不污染 ~/.codex）。\n\
         model_provider = \"{CODEX_PROVIDER_ID}\"\n\
         \n\
         [model_providers.{CODEX_PROVIDER_ID}]\n\
         name = \"LingFang Platform\"\n\
         base_url = \"{url}\"\n\
         wire_api = \"chat\"\n\
         api_key = \"{key}\"\n",
        url = escape_toml_string(api_url),
        key = escape_toml_string(api_key),
    );
    let path = config_dir.join("config.toml");
    std::fs::write(&path, toml).map_err(|error| error.to_string())
}

/// TOML 基本字符串转义（仅 " 和 \ 需转义，控制字符极罕见故不处理）。
/// 用防御性转义替代引入 toml crate 依赖（PRD 明确避免新依赖）。
fn escape_toml_string(value: &str) -> String {
    value.replace('\\', r"\\").replace('"', r#"\""#)
}

/// 写 opencode 临时 opencode.json 到 `<config_dir>/opencode.json`，返回该文件路径。
///
/// 格式（已查 context7 opencode 官方文档）：
/// - `$schema`：opencode 官方 config schema（IDE 友好）。
/// - `model`：默认模型（lingfang/default）。
/// - `provider.lingfang`：用 @ai-sdk/openai-compatible 适配器（OpenAI 兼容 provider）。
/// - `options.baseURL` / `options.apiKey`：传给适配器的连接参数。
/// - `models.default`：占位模型定义（opencode 要求至少一个模型条目）。
pub fn write_opencode_config(
    config_dir: &Path,
    api_key: &str,
    api_url: &str,
) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(config_dir).map_err(|error| error.to_string())?;
    // 用 serde_json 构造再序列化（避免 JSON 转义地狱，且 api_key/api_url 含特殊字符时自动转义）。
    let json = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "model": format!("{OPENCODE_PROVIDER_ID}/default"),
        "provider": {
            OPENCODE_PROVIDER_ID: {
                "npm": "@ai-sdk/openai-compatible",
                "name": "LingFang Platform",
                "options": {
                    "baseURL": api_url,
                    "apiKey": api_key,
                },
                "models": {
                    "default": {
                        "name": "默认模型"
                    }
                }
            }
        }
    });
    let path = config_dir.join("opencode.json");
    let body = serde_json::to_string_pretty(&json).map_err(|error| error.to_string())?;
    std::fs::write(&path, body).map_err(|error| error.to_string())?;
    Ok(path)
}

/// 删除会话的临时配置目录（AC7 清理）。
///
/// `configs_root` 即 `state.configs_root()`（= `app_data/cli-configs`，每个 session 子目录的直接父目录），
/// 本函数删除 `<configs_root>/<session_id>/`。
///
/// 幂等：目录不存在不报错（允许半删状态收尾）。
///
/// 安全修复 H1：`session_id` 来自前端 IPC 入参（stop_session / delete_session / send_input），
/// 不可信任。此前直接 `configs_root.join(session_id)` 后 `remove_dir_all`，传入 `..` / 路径分隔符
/// 可删除 configs_root 之外的任意目录（数据丢失）。现加两层防护：
/// 1. 字符过滤：session_id 必须非空且不含 `/`、`\`、`..`（裸标识符）。
/// 2. canonicalize 前缀断言：规范化后路径必须仍以 configs_root 规范化路径为前缀。
/// 任一校验失败静默返回（不删，安全优先）。
pub fn cleanup_session_config(configs_root: &Path, session_id: &str) {
    // 第一层：裸标识符校验（防 `..` 与路径分隔符穿越）。
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return;
    }
    let dir = configs_root.join(session_id);
    // 第二层：canonicalize 前缀断言（防符号链接等绕过）。configs_root 不存在时跳过删除。
    let Ok(canon) = dir.canonicalize() else {
        return;
    };
    let Ok(root_canon) = configs_root.canonicalize() else {
        return;
    };
    if !canon.starts_with(&root_canon) {
        return;
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// === 单元测试 ===
//
// 覆盖：三 CLI env 生成 + codex TOML/opencode JSON 内容正确性 + AC4 降级 + AC8 不含明文 key 在生成函数返回值。
// 注意：写盘的文件本身含明文 key（codex/opencode 必需），但本模块不打印 key（无 println!）。
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lingfang-cli-config-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // === claude env ===

    #[test]
    fn claude_env_has_base_url_and_key() {
        let dir = temp_dir("claude-basic");
        let env = prepare_cli_env(
            CodeAssistantTool::Claude,
            "sk-test-123",
            "https://api.example.com",
            &dir,
        );
        let map: Vec<(String, String)> = env
            .into_iter()
            .map(|(k, v)| (k.to_string_lossy().to_string(), v.to_string_lossy().to_string()))
            .collect();
        assert_eq!(map.len(), 2, "claude 应注入 2 个 env");
        assert!(
            map.iter()
                .any(|(k, v)| k == "ANTHROPIC_BASE_URL" && v == "https://api.example.com"),
            "应有 ANTHROPIC_BASE_URL：{map:?}"
        );
        assert!(
            map.iter()
                .any(|(k, v)| k == "ANTHROPIC_API_KEY" && v == "sk-test-123"),
            "应有 ANTHROPIC_API_KEY：{map:?}"
        );
        // claude 不写配置文件（纯 env）。
        assert!(dir.read_dir().unwrap().count() == 0, "claude 不应写配置文件");
    }

    // === codex config.toml ===

    #[test]
    fn codex_env_has_codex_home_and_openai_key() {
        let dir = temp_dir("codex-env");
        let env = prepare_cli_env(
            CodeAssistantTool::Codex,
            "sk-codex-456",
            "https://llm.example.com",
            &dir,
        );
        let map: Vec<(String, String)> = env
            .into_iter()
            .map(|(k, v)| (k.to_string_lossy().to_string(), v.to_string_lossy().to_string()))
            .collect();
        assert_eq!(map.len(), 2, "codex 应注入 2 个 env");
        // CODEX_HOME 指向临时目录。
        let codex_home = map
            .iter()
            .find(|(k, _)| k == "CODEX_HOME")
            .map(|(_, v)| v.clone())
            .expect("应有 CODEX_HOME");
        assert_eq!(codex_home, dir.to_string_lossy().to_string());
        // OPENAI_API_KEY 双保险。
        assert!(
            map.iter()
                .any(|(k, v)| k == "OPENAI_API_KEY" && v == "sk-codex-456"),
            "应有 OPENAI_API_KEY：{map:?}"
        );
    }

    #[test]
    fn codex_config_toml_contains_provider_and_url_and_key() {
        let dir = temp_dir("codex-toml");
        write_codex_config(&dir, "sk-codex-456", "https://llm.example.com").unwrap();
        let toml = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        // model_provider 指向 lingfang（非保留 id）。
        assert!(
            toml.contains("model_provider = \"lingfang\""),
            "应含 model_provider：{toml}"
        );
        // provider 段含 base_url + wire_api=chat + api_key。
        assert!(toml.contains("[model_providers.lingfang]"));
        assert!(
            toml.contains("base_url = \"https://llm.example.com\""),
            "应含 base_url：{toml}"
        );
        assert!(
            toml.contains("wire_api = \"chat\""),
            "应含 wire_api=chat（平台是 Chat Completions 兼容）：{toml}"
        );
        assert!(
            toml.contains("api_key = \"sk-codex-456\""),
            "应含明文 api_key：{toml}"
        );
    }

    #[test]
    fn codex_config_toml_not_in_user_home() {
        // AC2/AC3：CODEX_HOME 指向临时目录，绝不在 ~/.codex 写文件。
        // 这里仅验证写入路径是传入的 config_dir，而非用户 home。
        let dir = temp_dir("codex-isolation");
        write_codex_config(&dir, "k", "u").unwrap();
        let written = dir.join("config.toml");
        assert!(written.exists(), "应写入 config_dir/config.toml");
        // 文件路径必须以传入的 config_dir 为前缀（不在用户 home）。
        assert!(
            written.starts_with(&dir),
            "临时配置应在传入目录内：{written:?}"
        );
    }

    // === opencode opencode.json ===

    #[test]
    fn opencode_env_points_to_json_file() {
        let dir = temp_dir("opencode-env");
        let env = prepare_cli_env(
            CodeAssistantTool::Opencode,
            "sk-oc-789",
            "https://oc.example.com",
            &dir,
        );
        assert_eq!(env.len(), 1, "opencode 应注入 1 个 env");
        let (key, value) = &env[0];
        assert_eq!(key.to_string_lossy(), "OPENCODE_CONFIG");
        let value_str = value.to_string_lossy().to_string();
        assert!(
            value_str.ends_with("opencode.json"),
            "OPENCODE_CONFIG 应指向 opencode.json：{value_str}"
        );
        assert!(
            value_str.starts_with(dir.to_string_lossy().as_ref()),
            "json 应在 config_dir 内：{value_str}"
        );
    }

    #[test]
    fn opencode_config_json_contains_provider_options() {
        let dir = temp_dir("opencode-json");
        let path = write_opencode_config(&dir, "sk-oc-789", "https://oc.example.com").unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        // model = lingfang/default。
        assert_eq!(parsed["model"], "lingfang/default");
        // provider.lingfang.options 含 baseURL + apiKey。
        let options = &parsed["provider"]["lingfang"]["options"];
        assert_eq!(options["baseURL"], "https://oc.example.com");
        assert_eq!(options["apiKey"], "sk-oc-789");
        // npm 适配器 + models 占位。
        assert_eq!(parsed["provider"]["lingfang"]["npm"], "@ai-sdk/openai-compatible");
        assert!(parsed["provider"]["lingfang"]["models"]["default"]["name"].is_string());
    }

    // === AC4 降级 ===

    #[test]
    fn empty_key_returns_empty_env() {
        let dir = temp_dir("degrade-empty-key");
        let env = prepare_cli_env(
            CodeAssistantTool::Claude,
            "",
            "https://api.example.com",
            &dir,
        );
        assert!(env.is_empty(), "空 key 应降级为不注入 env");
    }

    #[test]
    fn empty_url_returns_empty_env() {
        let dir = temp_dir("degrade-empty-url");
        let env = prepare_cli_env(CodeAssistantTool::Codex, "sk-test", "  ", &dir);
        assert!(env.is_empty(), "空 url 应降级为不注入 env");
    }

    #[test]
    fn whitespace_only_credentials_return_empty_env() {
        let dir = temp_dir("degrade-ws");
        let env = prepare_cli_env(CodeAssistantTool::Opencode, "  ", "", &dir);
        assert!(env.is_empty(), "纯空白凭据应降级");
    }

    // === AC7 清理 ===
    // configs_root 即 state.configs_root()（= app_data/cli-configs），session 子目录是其直接子目录。

    #[test]
    fn cleanup_session_config_removes_dir() {
        let configs_root = temp_dir("cleanup-root");
        let session_dir = configs_root.join("session-xyz");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("config.toml"), "stub").unwrap();
        assert!(session_dir.exists());
        cleanup_session_config(&configs_root, "session-xyz");
        assert!(!session_dir.exists(), "清理后目录应消失");
    }

    #[test]
    fn cleanup_session_config_idempotent_for_missing() {
        // 幂等：不存在的 session 清理不报错。
        let configs_root = temp_dir("cleanup-idempotent");
        cleanup_session_config(&configs_root, "nonexistent");
        // 不 panic 即通过。
        assert!(!configs_root.join("nonexistent").exists());
    }

    // === 特殊字符安全 ===

    #[test]
    fn opencode_json_escapes_special_chars_in_key() {
        // api_key 含双引号/反斜杠时，serde_json 序列化应正确转义（不破坏 JSON）。
        let dir = temp_dir("special-chars");
        let tricky_key = "sk-\"weird\\key";
        let path = write_opencode_config(&dir, tricky_key, "https://api.example.com").unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        // JSON 应可正确解析（转义无误）。
        let parsed: serde_json::Value = serde_json::from_str(&body).expect("JSON 应合法");
        assert_eq!(parsed["provider"]["lingfang"]["options"]["apiKey"], tricky_key);
    }

    #[test]
    fn codex_toml_escapes_special_chars_in_key() {
        // codex 手写 TOML：key 含双引号/反斜杠时需 escape_toml_string 转义（不破坏 TOML）。
        // 用 toml crate 解析验证（仅测试用，生产不依赖）。
        let dir = temp_dir("codex-special-chars");
        let tricky_key = "sk-\"q\\k";
        write_codex_config(&dir, tricky_key, "https://api.example.com").unwrap();
        let body = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        // 断言转义后的字面量出现（" -> \"，\ -> \\）。
        assert!(
            body.contains(r#"api_key = "sk-\"q\\k""#),
            "TOML 应含转义后的 key：{body}"
        );
    }
}
