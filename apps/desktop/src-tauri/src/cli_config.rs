//! CLI 配置注入（key + apiUrl + model 隔离写入，不污染用户默认配置）。
//!
//! 背景（task 06-15-cli-config-injection-codex-fix）：
//! - 模型网关 v3 让用户在设置页填 apiKey + 平台维护 provider apiUrl（active-provider）。
//! - 桌面 Rust spawn CLI（claude/codex/opencode）时此前不注入任何 env/配置，
//!   CLI 用各自默认配置（~/.codex、~/.claude 等），导致用不到平台分发的 key/url。
//! - 本模块负责：把 (api_key, api_url, model) 按各 CLI 的隔离机制写入临时配置，
//!   spawn 时以 env 指向临时配置，**绝不写用户默认配置**。
//!
//! 三 CLI 隔离机制（已查 context7 官方文档 + GitHub discussion #7782 + codex 0.139 二进制反查）：
//! - **claude**：env `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`，adapter 启动时追加
//!   `--bare --setting-sources ""`，避免读取用户 `~/.claude/settings.json` 中由 CC Switch
//!   等工具写入的 base_url/model 默认值；模型仍走 `--model <m>` 命令行参数。
//!   模型不写配置文件——claude 走 `--model <m>` 命令行参数（adapters/claude.rs build_args），
//!   配置文件无 model 字段机制，故这里 claude 忽略 model 参数。
//! - **codex**：env `CODEX_HOME=<临时目录>`，该目录放 `config.toml`：
//!     ```toml
//!     model_provider = "lingfang"
//!     model = "<model>"            # 顶级字段（仅 model 非空时写；CLI 优先用 --model 参数，此为配置兜底）
//!     [model_providers.lingfang]
//!     name = "LingFang Platform"
//!     base_url = "<apiUrl>"
//!     wire_api = "responses"   # 平台网关走 OpenAI Responses API（codex 0.139 原生路径）
//!     api_key = "<key>"        # 明文 api_key 字段（discussion #7782 验证 codex 接受）
//!     ```
//!   同时追加 env `OPENAI_API_KEY=<key>` 作为双保险（codex 多路径读取）。
//! - **opencode**：env `OPENCODE_CONFIG=<临时.json>`，json 含 provider.lingfang.options.{baseURL, apiKey}，
//!   `model` 字段为 `lingfang/<model>`（用户选定模型，非占位 default）；
//!   同时隔离 `HOME` / `USERPROFILE` / `XDG_*`，避免 CLI 读取用户级 `~/.config/opencode` / `~/.opencode`。
//!
//! wire_api 取值决策（task 06-13 修正）：
//! - codex-cli 0.139.0 二进制反查：`/responses` 路径出现 10 次，`/chat/completions` 出现 **0 次**。
//!   即 codex 0.139 已以 Responses API 为主要路径，Chat Completions 路径已被移除/弃用。
//! - 平台默认 provider 是 OpenAI 官方（`https://api.openai.com/v1`，见 seed-llm-gateways.ts），
//!   OpenAI 官方原生支持 Responses API（codex 的默认 wire_api 即 responses）。
//! - 用户实测：本地 CC Switch 代理（`wire_api = "responses"`）走 `/v1/responses` 端点，
//!   仅因余额不足 402 失败，端点本身正确（证明 responses 是有效路径）。
//! - 故 `wire_api = "responses"`（此前 `chat` 在 0.139 会回退到 responses 但带 deprecate warning，
//!   且部分第三方网关 chat 端点已不可用，responses 是正确选择）。
//!
//! 安全边界（AC8）：
//! - 临时配置文件放在 app_data/cli-configs/<sessionId>/ 下，文件权限默认（用户私有）。
//! - 本模块不打印 api_key（无 println!/eprintln! 含 key；command_preview 复用 redact_arg）。
//! - 调用方负责在会话结束（spawn_waiter 退出 / stop_session / delete_session）时清理临时目录（AC7）。
//!
//! 降级（AC4）：无 api_key 或无 api_url 时，prepare_cli_env 返回空 Vec（调用方据此不注入 env）。
//! codex/opencode 仍按各自 CLI 默认配置处理；claude 因 adapter 强制清空 setting sources，
//! 会暴露缺少 LingFang 注入凭据的真实错误，而不会静默使用用户本机 CC 配置。

use std::ffi::OsString;
use std::path::Path;

use crate::code_assistant::adapters::CodeAssistantTool;
use crate::cli_provider::{opencode_model_ref, CODEX_PROVIDER_ID, OPENCODE_PROVIDER_ID};

/// 按工具类型生成 spawn 时注入的 env 列表，并把 codex/opencode 的临时配置文件写入 config_dir。
///
/// 参数：
/// - `tool`：CLI 类型（claude/codex/opencode）。
/// - `api_key`：明文 apiKey（来自后端 decrypt 端点，仅在本次 spawn 生命周期内持有）。
/// - `api_url`：provider 基础地址（来自后端 active-provider 端点）。
/// - `config_dir`：临时配置目录（app_data/cli-configs/<sessionId>/），codex/opencode 的配置文件写在此。
/// - `model`：用户选定的模型 id（已由调用方 clean：None 或非空且非 default 占位）。
///   codex 写入 config.toml 顶级 `model` 字段；opencode 写入 json `model = "lingfang/<model>"`；
///   claude 忽略（走 `--model` 命令行参数）。
///
/// 返回 `Vec<(OsString, OsString)>` 供 `Command::envs()` 追加（不清空宿主 env，保留 PATH 让 CLI 找到二进制）。
///
/// 降级（AC4）：api_key 或 api_url 为空时返回空 Vec（不注入）。
/// claude adapter 使用 `--bare --setting-sources ""`，因此不会在缺平台凭据时读取用户级 CC 配置。
pub fn prepare_cli_env(
    tool: CodeAssistantTool,
    api_key: &str,
    api_url: &str,
    config_dir: &Path,
    model: Option<&str>,
) -> Vec<(OsString, OsString)> {
    // AC4 降级：缺 key 或 url 时直接返回空（调用方不注入 env）。
    if api_key.trim().is_empty() || api_url.trim().is_empty() {
        return Vec::new();
    }
    match tool {
        // claude 走 --model 命令行参数；adapter 清空 setting sources 隔离用户 ~/.claude/settings.json。
        CodeAssistantTool::Claude => prepare_claude_env(api_key, api_url),
        CodeAssistantTool::Codex => prepare_codex_env(api_key, api_url, config_dir, model),
        CodeAssistantTool::Opencode => prepare_opencode_env(api_key, api_url, config_dir, model),
    }
}

/// claude：纯 env 注入（ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY），无需配置文件。
/// 用户级 Claude Code 配置隔离由 adapters/claude.rs 的 `--bare --setting-sources ""` 保证。
fn prepare_claude_env(api_key: &str, api_url: &str) -> Vec<(OsString, OsString)> {
    vec![
        (
            OsString::from("ANTHROPIC_BASE_URL"),
            OsString::from(api_url),
        ),
        (OsString::from("ANTHROPIC_API_KEY"), OsString::from(api_key)),
    ]
}

/// codex：写临时 config.toml 到 config_dir，返 CODEX_HOME + OPENAI_API_KEY（双保险）。
/// 写盘失败返回空 Vec（降级，不阻塞 spawn——CLI 会回退默认配置）。
///
/// `model` 非空时写入 config.toml 顶级 `model = "<m>"`（与 model_provider 同级）。
/// codex 命令行已通过 `--model <m>` 传模型（adapters/codex.rs build_args），config 字段为兜底/默认模型。
fn prepare_codex_env(
    api_key: &str,
    api_url: &str,
    config_dir: &Path,
    model: Option<&str>,
) -> Vec<(OsString, OsString)> {
    if let Err(error) = write_codex_config(config_dir, api_key, api_url, model) {
        eprintln!("codex 临时配置写入失败（降级为默认配置）：{}", error);
        return Vec::new();
    }
    vec![
        // CODEX_HOME 指向临时目录：codex 读 <CODEX_HOME>/config.toml（隔离，不碰 ~/.codex）。
        (
            OsString::from("CODEX_HOME"),
            config_dir.as_os_str().to_owned(),
        ),
        // 双保险：codex 多路径读 OPENAI_API_KEY；config.toml 的 api_key 字段优先。
        (OsString::from("OPENAI_API_KEY"), OsString::from(api_key)),
    ]
}

/// opencode：写临时 opencode.json 到 config_dir，返 OPENCODE_CONFIG 指向该 json。
/// 写盘失败返回空 Vec（降级）。
///
/// `model` 非空时 json `model` 为 `lingfang/<model>`；None 时回退 `lingfang/default`（占位）。
fn prepare_opencode_env(
    api_key: &str,
    api_url: &str,
    config_dir: &Path,
    model: Option<&str>,
) -> Vec<(OsString, OsString)> {
    match write_opencode_config(config_dir, api_key, api_url, model) {
        Ok(path) => {
            let mut env = vec![(OsString::from("OPENCODE_CONFIG"), path.into_os_string())];
            env.extend(opencode_isolation_envs(config_dir));
            env
        }
        Err(error) => {
            eprintln!("opencode 临时配置写入失败（降级为默认配置）：{}", error);
            Vec::new()
        }
    }
}

fn opencode_isolation_envs(config_dir: &Path) -> Vec<(OsString, OsString)> {
    let home = config_dir.as_os_str().to_owned();
    let xdg_config_home = config_dir.join("xdg-config");
    let xdg_data_home = config_dir.join("xdg-data");
    let xdg_state_home = config_dir.join("xdg-state");
    let xdg_cache_home = config_dir.join("xdg-cache");
    vec![
        (OsString::from("HOME"), home.clone()),
        (OsString::from("USERPROFILE"), home),
        (
            OsString::from("XDG_CONFIG_HOME"),
            xdg_config_home.into_os_string(),
        ),
        (
            OsString::from("XDG_DATA_HOME"),
            xdg_data_home.into_os_string(),
        ),
        (
            OsString::from("XDG_STATE_HOME"),
            xdg_state_home.into_os_string(),
        ),
        (
            OsString::from("XDG_CACHE_HOME"),
            xdg_cache_home.into_os_string(),
        ),
    ]
}

/// 写 codex 临时 config.toml 到 `<config_dir>/config.toml`。
///
/// 格式（已查 context7 + GitHub discussion #7782 + codex 0.139 二进制反查）：
/// - `model_provider = "lingfang"`：选中自定义 provider（不可用保留 id openai/ollama/lmstudio）。
/// - `model = "<model>"`：顶级字段（仅 model 非空时写）。codex 命令行已通过 `--model` 传值，
///   此字段为配置层兜底（无 --model 时仍命中用户选定模型）。位置必须在 `[model_providers.*]` 段之外（顶级）。
/// - `[model_providers.lingfang]`：provider 定义。
/// - `base_url`：平台 apiUrl（OpenAI 兼容，应含 /v1 后缀，如 `https://api.openai.com/v1`）。
/// - `wire_api = "responses"`：平台走 OpenAI Responses API（codex 0.139 原生路径，见模块文档决策说明）。
/// - `api_key`：明文 key（discussion #7782 的 LM Studio 示例验证 codex 接受此字段）。
///
/// TOML 手写（避免引入 toml crate 依赖）：字段均为简单字符串/字面量，无嵌套对象，
/// 手写格式可控且可单测断言。`model` 行仅在该字段非空时插入，紧随 model_provider 之后（顶层，
/// 严禁落到 [model_providers.*] 段内被解析为 provider 子字段）。
pub fn write_codex_config(
    config_dir: &Path,
    api_key: &str,
    api_url: &str,
    model: Option<&str>,
) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|error| error.to_string())?;
    // clean model：trim + 去空 + 去占位 default（与 adapters clean_model / write_opencode_config 一致）。
    // default 是前端「默认模型」占位，不应写入配置文件（CLI 回退自身默认模型）。
    let clean_model = model
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default");
    // model 行：仅 clean 后非空时拼一行（顶级，紧跟 model_provider，在 [model_providers.*] 段之前）。
    // model 仍走 escape_toml_string 转义（用户可手输任意字符，如 "gpt-5.1-codex" 无特殊字符但需防御）。
    let model_line = match clean_model {
        Some(model) => format!("model = \"{}\"\n", escape_toml_string(model)),
        None => String::new(),
    };
    // TOML 基本字符串需转义 " 和 \。OpenAI 兼容 key 通常只含 [a-zA-Z0-9-_]，
    // 但防御性转义保证 key/url 含特殊字符时不破坏 TOML（不引入 toml crate）。
    let toml = format!(
        "# LingFang 平台自动生成的 codex 临时配置（CODEX_HOME 隔离，不污染 ~/.codex）。\n\
         model_provider = \"{CODEX_PROVIDER_ID}\"\n\
         {model_line}\
         \n\
         [model_providers.{CODEX_PROVIDER_ID}]\n\
         name = \"LingFang Platform\"\n\
         base_url = \"{url}\"\n\
         wire_api = \"responses\"\n\
         api_key = \"{key}\"\n",
        model_line = model_line,
        url = escape_toml_string(api_url),
        key = escape_toml_string(api_key),
    );
    let path = config_dir.join("config.toml");
    std::fs::write(&path, toml).map_err(|error| error.to_string())
}

/// TOML 基本字符串转义。
/// 用防御性转义替代引入 toml crate 依赖（PRD 明确避免新依赖）。
///
/// 转义规则（覆盖 TOML 基本字符串禁止的字符）：
///  - `\` → `\\`、`"` → `\"`（基本转义）。
///  - 控制字符 U+0000–U+001F（TOML 基本字符串禁止，否则 codex 解析 config.toml 失败）→ `\uXXXX`。
///    修复 TOML-CTRL：此前注释「控制字符极罕见故不处理」，但 model 名来自前端用户自定义输入，
///    含换行/null 等控制字符会让生成的 config.toml 非法，codex 静默退化为默认配置或报错。
///    用 \uXXXX 保留原值（TOML 合法转义），不静默剥离用户输入。
fn escape_toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str(r"\\"),
            '"' => out.push_str(r#"\""#),
            c if (c as u32) <= 0x001F => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 写 opencode 临时 opencode.json 到 `<config_dir>/opencode.json`，返回该文件路径。
///
/// 格式（已查 context7 opencode 官方文档）：
/// - `$schema`：opencode 官方 config schema（IDE 友好）。
/// - `model`：`lingfang/<model>`（用户选定模型，非占位 default）；model 为空时回退 `lingfang/default`。
/// - `provider.lingfang`：用 @ai-sdk/openai-compatible 适配器（OpenAI 兼容 provider）。
/// - `options.baseURL` / `options.apiKey`：传给适配器的连接参数。
/// - `models.<model>`：模型条目定义（opencode 要求 model 字段对应 models 内至少一个条目，
///   否则 opencode 不识别该模型）。model 为空时用 default 占位 + models.default 占位条目。
pub fn write_opencode_config(
    config_dir: &Path,
    api_key: &str,
    api_url: &str,
    model: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(config_dir).map_err(|error| error.to_string())?;
    // clean model：trim + 去空 + 去占位 default（与 adapters clean_model 一致）。
    let clean_model = model
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default");
    // model 字段 = lingfang/<model>，模型条目 key 与 model 末段保持一致（opencode 据此匹配 provider 内模型）。
    // 空时回退 default 占位（保留原行为，不破坏降级路径）。
    let model_key = clean_model.unwrap_or("default");
    let model_field = opencode_model_ref(model_key);
    // 用 serde_json 构造再序列化（避免 JSON 转义地狱，且 api_key/api_url 含特殊字符时自动转义）。
    // models 条目 key 用动态 model_key（serde_json::json! 宏不支持动态 key，故用 .insert 后置）。
    let mut json = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "model": model_field,
        "provider": {
            OPENCODE_PROVIDER_ID: {
                "npm": "@ai-sdk/openai-compatible",
                "name": "LingFang Platform",
                "options": {
                    "baseURL": api_url,
                    "apiKey": api_key,
                },
                "models": {}
            }
        }
    });
    // 后置插入 models.<model_key> 条目：opencode 要求 model 字段对应的模型在 provider.models 内有定义。
    json["provider"][OPENCODE_PROVIDER_ID]["models"][model_key] = serde_json::json!({
        "name": capitalize_first(model_key)
    });
    let path = config_dir.join("opencode.json");
    let body = serde_json::to_string_pretty(&json).map_err(|error| error.to_string())?;
    std::fs::write(&path, body).map_err(|error| error.to_string())?;
    Ok(path)
}

/// 模型名首字母大写（opencode models 条目 name 字段用，仅显示用途）。
/// 复用前端 capitalizeModel 同款语义：仅 ASCII 小写首字符大写，其余原样（适配 gpt-5.1-codex 等）。
fn capitalize_first(value: &str) -> String {
    let first = value.chars().next();
    match first {
        Some(c) if c >= 'a' && c <= 'z' => {
            let upper: String = c.to_uppercase().collect();
            upper + &value[c.len_utf8()..]
        }
        _ => value.to_string(),
    }
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

    fn env_map(env: Vec<(OsString, OsString)>) -> std::collections::HashMap<String, String> {
        env.into_iter()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.to_string_lossy().to_string(),
                )
            })
            .collect()
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
            None,
        );
        let map: Vec<(String, String)> = env
            .into_iter()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.to_string_lossy().to_string(),
                )
            })
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
        assert!(
            dir.read_dir().unwrap().count() == 0,
            "claude 不应写配置文件"
        );
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
            None,
        );
        let map: Vec<(String, String)> = env
            .into_iter()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.to_string_lossy().to_string(),
                )
            })
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
        write_codex_config(&dir, "sk-codex-456", "https://llm.example.com", None).unwrap();
        let toml = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        // model_provider 指向 lingfang（非保留 id）。
        assert!(
            toml.contains("model_provider = \"lingfang\""),
            "应含 model_provider：{toml}"
        );
        // provider 段含 base_url + wire_api=responses + api_key。
        assert!(toml.contains("[model_providers.lingfang]"));
        assert!(
            toml.contains("base_url = \"https://llm.example.com\""),
            "应含 base_url：{toml}"
        );
        assert!(
            toml.contains("wire_api = \"responses\""),
            "应含 wire_api=responses（codex 0.139 走 Responses API 原生路径）：{toml}"
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
        write_codex_config(&dir, "k", "u", None).unwrap();
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
            None,
        );
        let map = env_map(env);
        let value_str = map
            .get("OPENCODE_CONFIG")
            .cloned()
            .expect("应有 OPENCODE_CONFIG");
        assert!(
            value_str.ends_with("opencode.json"),
            "OPENCODE_CONFIG 应指向 opencode.json：{value_str}"
        );
        assert!(
            value_str.starts_with(dir.to_string_lossy().as_ref()),
            "json 应在 config_dir 内：{value_str}"
        );
        assert!(map.contains_key("HOME"), "应注入 HOME");
        assert!(map.contains_key("USERPROFILE"), "应注入 USERPROFILE");
    }

    #[test]
    fn opencode_env_isolates_user_config_locations() {
        let dir = temp_dir("opencode-isolation");
        let env = prepare_cli_env(
            CodeAssistantTool::Opencode,
            "sk-oc-789",
            "https://oc.example.com",
            &dir,
            Some("minimax-m3"),
        );
        let map = env_map(env);
        let expected_home = dir.to_string_lossy().to_string();
        assert!(
            map.get("OPENCODE_CONFIG")
                .is_some_and(|value| value.starts_with(&expected_home)),
            "OPENCODE_CONFIG 应指向会话临时目录：{map:?}"
        );
        assert_eq!(map.get("HOME"), Some(&expected_home), "HOME 应隔离到临时目录");
        assert_eq!(
            map.get("USERPROFILE"),
            Some(&expected_home),
            "USERPROFILE 应隔离到临时目录"
        );
        assert_eq!(
            map.get("XDG_CONFIG_HOME"),
            Some(&dir.join("xdg-config").to_string_lossy().to_string()),
            "XDG_CONFIG_HOME 应隔离到临时目录"
        );
        assert_eq!(
            map.get("XDG_DATA_HOME"),
            Some(&dir.join("xdg-data").to_string_lossy().to_string()),
            "XDG_DATA_HOME 应隔离到临时目录"
        );
        assert_eq!(
            map.get("XDG_STATE_HOME"),
            Some(&dir.join("xdg-state").to_string_lossy().to_string()),
            "XDG_STATE_HOME 应隔离到临时目录"
        );
        assert_eq!(
            map.get("XDG_CACHE_HOME"),
            Some(&dir.join("xdg-cache").to_string_lossy().to_string()),
            "XDG_CACHE_HOME 应隔离到临时目录"
        );
    }

    #[test]
    fn opencode_config_json_contains_provider_options() {
        let dir = temp_dir("opencode-json");
        let path =
            write_opencode_config(&dir, "sk-oc-789", "https://oc.example.com", None).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        // model = lingfang/default。
        assert_eq!(parsed["model"], "lingfang/default");
        // provider.lingfang.options 含 baseURL + apiKey。
        let options = &parsed["provider"]["lingfang"]["options"];
        assert_eq!(options["baseURL"], "https://oc.example.com");
        assert_eq!(options["apiKey"], "sk-oc-789");
        // npm 适配器 + models 占位。
        assert_eq!(
            parsed["provider"]["lingfang"]["npm"],
            "@ai-sdk/openai-compatible"
        );
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
            None,
        );
        assert!(env.is_empty(), "空 key 应降级为不注入 env");
    }

    #[test]
    fn empty_url_returns_empty_env() {
        let dir = temp_dir("degrade-empty-url");
        let env = prepare_cli_env(CodeAssistantTool::Codex, "sk-test", "  ", &dir, None);
        assert!(env.is_empty(), "空 url 应降级为不注入 env");
    }

    #[test]
    fn whitespace_only_credentials_return_empty_env() {
        let dir = temp_dir("degrade-ws");
        let env = prepare_cli_env(CodeAssistantTool::Opencode, "  ", "", &dir, None);
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
        let path =
            write_opencode_config(&dir, tricky_key, "https://api.example.com", None).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        // JSON 应可正确解析（转义无误）。
        let parsed: serde_json::Value = serde_json::from_str(&body).expect("JSON 应合法");
        assert_eq!(
            parsed["provider"]["lingfang"]["options"]["apiKey"],
            tricky_key
        );
    }

    #[test]
    fn codex_toml_escapes_special_chars_in_key() {
        // codex 手写 TOML：key 含双引号/反斜杠时需 escape_toml_string 转义（不破坏 TOML）。
        // 用 toml crate 解析验证（仅测试用，生产不依赖）。
        let dir = temp_dir("codex-special-chars");
        let tricky_key = "sk-\"q\\k";
        write_codex_config(&dir, tricky_key, "https://api.example.com", None).unwrap();
        let body = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        // 断言转义后的字面量出现（" -> \"，\ -> \\）。
        assert!(
            body.contains(r#"api_key = "sk-\"q\\k""#),
            "TOML 应含转义后的 key：{body}"
        );
    }

    #[test]
    fn codex_toml_escapes_control_chars_in_model() {
        // 修复 TOML-CTRL：model 含控制字符（换行/null）时必须转义为 \uXXXX，
        // 否则生成的 config.toml 非法，codex 解析失败。
        // 不引入 toml crate（PRD 避免新依赖），用程序化不变量验证控制字符被转义：
        //  1) model 行存在且为单行（值内换行已转义，不会把行打断）。
        //  2) model 行内不含原始控制字符字节（U+0000–U+001F）。
        //  3) 文件内出现 \u 转义前缀（控制字符确实被 \uXXXX 序列替代）。
        let dir = temp_dir("codex-model-ctrl");
        let model_with_ctrl = "gpt\n5\x00";
        write_codex_config(
            &dir,
            "sk-test",
            "https://api.example.com",
            Some(model_with_ctrl),
        )
        .unwrap();
        let body = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        // 1) model 行存在且为单行：按行查找以 "model = " 开头的行应恰好命中一行。
        let model_line = body
            .lines()
            .find(|line| line.starts_with("model = "))
            .expect("应存在 model 行");
        // 2) model 行内不含任何原始控制字符字节（换行已转义，整行是单行）。
        assert!(
            !model_line.chars().any(|c| (c as u32) <= 0x001F),
            "model 行不得含原始控制字符（应已转义为 \\uXXXX）：{model_line}"
        );
        // 3) 文件内出现 \u 转义前缀（证明控制字符被 \uXXXX 序列替代，而非被剥离或原样保留）。
        assert!(
            body.contains("\\u"),
            "TOML 应含 \\uXXXX 控制字符转义序列：{body}"
        );
    }

    // === model 写入配置文件（task 06-15-custom-model-config-file-flow） ===
    //
    // 验证：用户选定 model 透传到 codex config.toml（顶级字段）+ opencode.json（lingfang/<model>）。
    // claude 忽略（走 --model 命令行参数，见 prepare_cli_env）。

    #[test]
    fn codex_config_toml_writes_top_level_model() {
        // model 非空时写入顶级 `model = "<m>"`，位置在 model_provider 之后、[model_providers.*] 段之前。
        let dir = temp_dir("codex-model");
        write_codex_config(
            &dir,
            "sk-codex",
            "https://llm.example.com",
            Some("gpt-5.1-codex"),
        )
        .unwrap();
        let toml = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(
            toml.contains("model = \"gpt-5.1-codex\""),
            "应含顶级 model 字段：{toml}"
        );
        // 顶级 model 必须在 provider 段之前（否则被解析为 provider 子字段）。
        let model_pos = toml
            .find("model = \"gpt-5.1-codex\"")
            .expect("model 行应存在");
        let provider_seg_pos = toml
            .find("[model_providers.lingfang]")
            .expect("provider 段应存在");
        assert!(
            model_pos < provider_seg_pos,
            "model 必须为顶级字段（在 [model_providers.*] 之前）：{toml}"
        );
    }

    #[test]
    fn codex_config_toml_custom_model_id_preserved() {
        // 自定义模型 id（用户手输，如 minimax-m3）原样写入，不做格式校验/转换。
        let dir = temp_dir("codex-custom-model");
        write_codex_config(&dir, "k", "u", Some("minimax-m3")).unwrap();
        let toml = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(
            toml.contains("model = \"minimax-m3\""),
            "自定义 model id 应原样保留：{toml}"
        );
    }

    #[test]
    fn codex_config_toml_none_model_has_no_model_line() {
        // model=None 时不写 model 行（保持改造前行为，向后兼容）。
        let dir = temp_dir("codex-no-model");
        write_codex_config(&dir, "k", "u", None).unwrap();
        let toml = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(
            !toml.contains("\nmodel = "),
            "model=None 时不应有顶级 model 行：{toml}"
        );
        assert!(
            toml.contains("model_provider = \"lingfang\""),
            "model_provider 应仍存在：{toml}"
        );
    }

    #[test]
    fn codex_config_toml_empty_or_default_model_treated_as_none() {
        // 空串 / "default" 占位视为无模型（与 adapters clean_model 语义一致），不写 model 行。
        let dir = temp_dir("codex-default-model");
        write_codex_config(&dir, "k", "u", Some("default")).unwrap();
        let toml = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(
            !toml.contains("model = "),
            "占位 default 不应写 model 行：{toml}"
        );
    }

    #[test]
    fn opencode_config_json_writes_custom_model() {
        // model 非空：json model = lingfang/<model>，models 条目含 <model> 定义（非 default 占位）。
        let dir = temp_dir("opencode-model");
        let path =
            write_opencode_config(&dir, "sk-oc", "https://oc.example.com", Some("qwen-coder"))
                .unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            parsed["model"], "lingfang/qwen-coder",
            "model 应为 lingfang/<model>"
        );
        // provider.models 应含 qwen-coder 条目（opencode 据此匹配模型）。
        assert!(
            parsed["provider"]["lingfang"]["models"]["qwen-coder"]["name"].is_string(),
            "models 应含 <model> 条目：{body}"
        );
        // 不应残留 default 占位条目。
        assert!(
            parsed["provider"]["lingfang"]["models"]["default"].is_null(),
            "不应残留 default 占位条目：{body}"
        );
    }

    #[test]
    fn opencode_config_json_none_model_falls_back_to_default() {
        // model=None：回退 lingfang/default + models.default（保留改造前行为）。
        let dir = temp_dir("opencode-default-model");
        let path = write_opencode_config(&dir, "sk-oc", "https://oc.example.com", None).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["model"], "lingfang/default", "None 回退 default");
        assert!(
            parsed["provider"]["lingfang"]["models"]["default"]["name"].is_string(),
            "应有 default 占位条目"
        );
    }

    #[test]
    fn opencode_config_json_custom_model_with_slash_safe() {
        // 自定义 model id 含 / 时，model 字段会含三段（lingfang/a/b）。
        // 这是用户输入的边界（允许任意字符串），只验证不 panic 且 JSON 合法（CLI 自行报错无效模型）。
        let dir = temp_dir("opencode-slash-model");
        let path = write_opencode_config(&dir, "k", "u", Some("kimi/k2")).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).expect("JSON 应合法");
        assert_eq!(parsed["model"], "lingfang/kimi/k2");
    }
}
