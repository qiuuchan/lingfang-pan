//! fetch_models 命令：用桌面 Rust 直连 LLM provider 的 `/v1/models` 拉取可用模型列表（design §2）。
//!
//! 职责与背景：
//! - 旧版模型网关交互是「网关目录 + Admin 维护静态 models 数组让租户勾选」，实际场景错误：模型应由
//!   provider 真实 `/v1/models` 接口动态返回，租户只填一个 apiKey。本模块负责在桌面 Rust 内用
//!   reqwest 调用 provider 的 `/v1/models`，把返回的 `{ data: [{ id }, ...] }` 解析成模型 id 列表。
//! - OpenAI 兼容协议是事实标准（OpenAI / DeepSeek / Moonshot / Qwen / Anthropic 2024 后均遵循
//!   `/v1/models` 返回 `{data:[{id,object,created,owned_by},...]}` 的结构）。首版聚焦该协议，
//!   Azure `/openai/deployments` 等特殊 provider 留 TODO。
//!
//! 安全边界（design §5 / AC7）：
//! - **reqwest 走 Rust 进程，不经 webview**：绕开 webview 的 CORS 限制（provider 一般不放跨域），
//!   同时 apiKey 只在 Rust reqwest 请求时临时用，请求结束随 stack 释放，不进前端 webview 长期内存。
//! - 后端只存加密后的 encryptedApiKey（跨电脑用，AES-256-GCM），拉取模型不经过后端 collab-api。
//! - 本模块不记日志（不打印 apiKey），错误返回的字符串仅含 code 前缀 + 通用提示，不回显 key 片段。
//!
//! 错误约定（前端按 err 字符串前缀 code 分支，不 message.includes）：
//! - `api_key_invalid:` —— HTTP 401/403，key 无效或过期（AC2）。
//! - `provider_response_unsupported:` —— 非 OpenAI 兼容响应（无 data 数组，AC4）。
//! - 其余 —— 网络失败/超时/非 2xx 等，前端按「网络」字样识别（AC3）。

use serde::{Deserialize, Serialize};

/// fetch_models 命令入参（前端 `{ input: {...} }` 包裹，与 install_cli 等命令一致）。
///
/// `rename_all = "camelCase"`：前端 tauriInvoke 传 `{ provider, apiUrl, apiKey }`（camelCase，
/// 与 lib/llm-fetch.ts 调用约定一致），serde 把 camelCase 的 apiUrl/api_key 映射到本结构体字段。
///
/// 可见性 `pub`：Tauri 的 `generate_handler!` 宏会为 command 生成 `__cmd__fetch_models` 模块，
/// 要求入参/出参类型对外可见（否则报 `private type` 编译错误）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsInput {
    /// provider 标识（仅用于错误提示上下文，不参与请求构造）。
    pub provider: String,
    /// provider 的基础地址（来自云分发 `LlmGateway.apiUrl`，前端选中 provider 后注入）。
    pub api_url: String,
    /// 用户填的明文 apiKey（仅本次 reqwest 请求用，不落盘、不进前端长期内存）。
    pub api_key: String,
}

/// fetch_models 命令出参（返回模型 id 列表）。可见性 `pub` 同 FetchModelsInput（宏要求）。
#[derive(Serialize)]
pub struct FetchModelsResult {
    pub models: Vec<String>,
}

/// OpenAI `/v1/models` 响应根结构：`{ object: "list", data: [{id, ...}, ...] }`。
#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

/// `/v1/models` 单条模型条目。仅取 id，其余字段（object/created/owned_by）忽略。
#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

/// 把 provider 基础地址拼成 `/v1/models` 完整 URL：去尾斜杠后追加路径（design §2.2）。
///
/// 纯函数便于单测：不实跑 reqwest，仅断言拼接逻辑正确（去重复尾斜杠 + 路径前导斜杠）。
fn build_models_url(api_url: &str) -> String {
    format!("{}/v1/models", api_url.trim_end_matches('/'))
}

/// 命令：拉取 provider 的可用模型列表。
///
/// 流程（design §2.2）：
/// 1. 拼接 `{api_url}/v1/models`（去尾斜杠）。
/// 2. reqwest GET + Bearer apiKey，15s 超时，user-agent "LingFang-Desktop"。
/// 3. 401/403 → `api_key_invalid:`；非 2xx → `provider 返回错误：HTTP {status}`；
///    非 OpenAI 兼容（解析失败）→ `provider_response_unsupported:`。
/// 4. 成功 → 返回模型 id 列表。
///
/// 返回 `Result<FetchModelsResult, String>`：String 含 code 前缀，前端按前缀分支（design §3.2 第5点）。
#[tauri::command]
pub async fn fetch_models(input: FetchModelsInput) -> Result<FetchModelsResult, String> {
    let url = build_models_url(&input.api_url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("LingFang-Desktop")
        .build()
        .map_err(|e| format!("网络请求初始化失败：{e}"))?;
    let resp = client
        .get(&url)
        .bearer_auth(&input.api_key)
        .send()
        .await
        // reqwest 内部已区分超时/连接失败/握手失败等，统一带「网络」字样让前端识别（AC3）。
        .map_err(|e| format!("网络请求失败：{e}"))?;
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        // AC2：key 无效或过期，返回带 code 前缀的友好提示（含 provider 上下文）。
        return Err(format!("api_key_invalid:{} 的 apiKey 无效或已过期", input.provider));
    }
    if !status.is_success() {
        // 非 2xx（429/5xx 等）：不读取 body 进错误信息（避免 provider 回显敏感内容），仅回显状态码 + provider。
        return Err(format!("{} 返回错误：HTTP {status}", input.provider));
    }
    let parsed: ModelsResponse = resp
        .json()
        .await
        // AC4：响应体不是 OpenAI 兼容的 {data:[...]} 结构（如 HTML 错误页、私有协议 JSON）。
        .map_err(|_| {
            format!(
                "provider_response_unsupported:{} 返回格式非 OpenAI 兼容，暂不支持自动拉取模型",
                input.provider
            )
        })?;
    Ok(FetchModelsResult {
        models: parsed.data.into_iter().map(|m| m.id).collect(),
    })
}

// === 单元测试（design §6） ===
//
// 测试范围：纯函数 build_models_url（URL 拼接逻辑），不实跑 reqwest（真实 HTTP 走手动验证）。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_models_url_appends_path() {
        // 正常地址：直接追加 /v1/models。
        assert_eq!(build_models_url("https://api.openai.com"), "https://api.openai.com/v1/models");
        assert_eq!(
            build_models_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/models"
        );
    }

    #[test]
    fn build_models_url_trims_trailing_slash() {
        // 尾斜杠应被裁掉，避免拼成 //v1/models（双斜杠虽多数 provider 容忍但不规范）。
        assert_eq!(
            build_models_url("https://api.openai.com/"),
            "https://api.openai.com/v1/models"
        );
        // 多个尾斜杠全部裁掉。
        assert_eq!(
            build_models_url("https://api.openai.com///"),
            "https://api.openai.com/v1/models"
        );
        // 带 /v1 前缀的地址：用户填的 apiUrl 若已含 /v1，结果会是 /v1/v1/models（前端 apiUrl 规范
        // 不带 /v1，由云分发 LlmGateway.apiUrl 保证，本测仅验证去尾斜杠行为本身）。
        assert_eq!(
            build_models_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/v1/models"
        );
    }

    #[test]
    fn build_models_url_preserves_port_and_path() {
        // 自托管 provider 带端口 + 子路径：仅裁尾斜杠，中间路径保留。
        assert_eq!(
            build_models_url("https://llm.local:8080/openai"),
            "https://llm.local:8080/openai/v1/models"
        );
        assert_eq!(
            build_models_url("http://127.0.0.1:11434"),
            "http://127.0.0.1:11434/v1/models"
        );
    }

    #[test]
    fn build_models_url_empty_input() {
        // 空串边界：trim_end_matches 对空串返回空，拼接结果为 /v1/models（前端 apiUrl 必非空，
        // 此处仅验证不 panic）。
        assert_eq!(build_models_url(""), "/v1/models");
    }

    #[test]
    fn fetch_models_input_deserializes_camel_case() {
        // 前端 tauriInvoke 传 { input: { provider, apiUrl, apiKey } }（camelCase），
        // FetchModelsInput 标了 rename_all = "camelCase"，serde 把 apiUrl/apiKey 映射到
        // api_url/api_key 字段。本测验证该映射成功（与 lib/llm-fetch.ts 调用约定一致）。
        let json = r#"{"provider":"openai","apiUrl":"https://api.openai.com","apiKey":"sk-test"}"#;
        let input: FetchModelsInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.provider, "openai");
        assert_eq!(input.api_url, "https://api.openai.com");
        assert_eq!(input.api_key, "sk-test");

        // snake_case key 反而应被拒绝（rename 后 api_url 不再匹配）。
        let snake = r#"{"provider":"openai","api_url":"https://api.openai.com","api_key":"sk-test"}"#;
        let result: Result<FetchModelsInput, _> = serde_json::from_str(snake);
        assert!(result.is_err(), "rename_all=camelCase 后 snake_case key 应被拒绝");
    }

    #[test]
    fn models_response_parses_openai_shape() {
        // OpenAI /v1/models 真实响应结构：{ object, data: [{id, object, created, owned_by}, ...] }。
        // 本模块只反序列化 data[].id，其余字段忽略（serde 默认忽略未知字段）。
        let body = r#"{
            "object": "list",
            "data": [
                {"id": "gpt-4o", "object": "model", "created": 1715367049, "owned_by": "openai"},
                {"id": "gpt-4o-mini", "object": "model", "created": 1715367049, "owned_by": "openai"},
                {"id": "gpt-3.5-turbo", "object": "model", "created": 1715367049, "owned_by": "openai"}
            ]
        }"#;
        let parsed: ModelsResponse = serde_json::from_str(body).unwrap();
        let ids: Vec<String> = parsed.data.into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"]);
    }

    #[test]
    fn models_response_rejects_non_openai_shape() {
        // 非 OpenAI 兼容响应（缺 data 数组）应反序列化失败——对应 fetch_models 内的
        // provider_response_unsupported 分支（serde_json::from_str Err → 命令返回该 code）。
        let html_body = r#"<html><body>Not Found</body></html>"#;
        let result: Result<ModelsResponse, _> = serde_json::from_str(html_body);
        assert!(result.is_err());

        // 私有协议 JSON（有 models 但无 data）：同样失败。
        let private_json = r#"{"models": [{"name": "foo"}]}"#;
        let result: Result<ModelsResponse, _> = serde_json::from_str(private_json);
        assert!(result.is_err());

        // data 存在但非数组：失败。
        let wrong_type = r#"{"data": "not-an-array"}"#;
        let result: Result<ModelsResponse, _> = serde_json::from_str(wrong_type);
        assert!(result.is_err());
    }
}
