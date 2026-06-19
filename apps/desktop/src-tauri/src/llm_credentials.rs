//! 桌面 Rust 内部调后端拿 apiKey + apiUrl（CLI 配置注入的数据源，AC8 key 不进前端）。
//!
//! 背景（task 06-15-cli-config-injection-codex-fix R3）：
//! - 模型网关 v3 后端有两个端点：
//!   * `GET /api/llm/active-provider`（ensureCurrentTeam）：返 `{ name?, apiUrl, defaultModels }`。
//!   * `POST /api/llm/binding/decrypt`（ensureTeamAdmin）：返 `{ apiKey: 明文 }`。
//! - SDK runtime 发起模型请求前需要这俩值。
//! - **安全（AC8）**：apiKey 明文只在 Rust reqwest 请求时临时用，经 HTTPS 拿到后立即传给
//!   prepare_cli_env 生成临时配置，**绝不传给前端 webview**。前端只传 backendUrl + token。
//!
//! 降级（AC4）：任一端点失败（无 active-provider / 未绑定 / 网络）→ 返回 None，调用方据此
//! 走原行为（不注入 env，CLI 用默认配置），不崩。

use std::time::Duration;

use serde::Deserialize;

const CREDENTIAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LlmCredentials {
    pub api_key: String,
    pub api_url: String,
}

#[derive(Debug)]
struct ActiveProvider {
    api_url: String,
}

/// 后端 `GET /api/llm/active-provider` 出参（取 provider + apiUrl，其余字段忽略）。
///
/// 注意：后端返回 camelCase `apiUrl`（见 packages/contract/src/llm.ts ActiveProviderSchema），
/// 必须用 `rename = "apiUrl"` 让 serde 按 camelCase 匹配，否则字段恒为 None（降级，违反 AC1-AC3）。
#[derive(Deserialize)]
struct ActiveProviderResponse {
    #[serde(default)]
    provider: Option<String>,
    #[serde(default, rename = "apiUrl")]
    api_url: Option<String>,
}

/// 后端 `POST /api/llm/binding/decrypt` 出参（明文 apiKey）。
///
/// 后端返回 `{ apiKey: plaintext }`（见 llm.service.ts decryptBindingKey），用 `rename = "apiKey"` 匹配 camelCase。
#[derive(Deserialize)]
struct DecryptKeyResponse {
    #[serde(rename = "apiKey")]
    api_key: String,
}

/// 拉取 SDK Runtime 直连上游所需的 provider + api_key + api_url。
///
/// 顺序调两个后端端点（都是轻量 GET/POST，顺序调用延迟可忽略，避免引入 tokio 显式依赖）：
/// 1. `GET {backend}/api/llm/active-provider` 拿 provider + apiUrl（普通成员可见）。
/// 2. `POST {backend}/api/llm/binding/decrypt` 拿 apiKey 明文（需 TEAM_ADMIN）。
///
/// 返回 `Ok(Some(credentials))` 表示两端点都成功；
/// `Ok(None)` 表示后端未配置/未绑定/网络失败，调用方返回用户可见错误。
///
/// **安全（AC8）**：明文 key 仅在返回值中存在，由调用方立即传给 reqwest 请求头，
/// 不经过前端 webview，不落盘到日志。错误信息不含 key 片段。
pub async fn fetch_credentials(
    backend_url: &str,
    auth_token: &str,
) -> Result<Option<LlmCredentials>, String> {
    if backend_url.trim().is_empty() || auth_token.trim().is_empty() {
        return Ok(None);
    }
    let base = backend_url.trim_end_matches('/');
    let client = credential_client()?;
    let Some(active_provider) = fetch_active_provider(&client, base, auth_token).await? else {
        return Ok(None);
    };
    let Some(api_key) = fetch_decrypted_api_key(&client, base, auth_token).await? else {
        return Ok(None);
    };

    Ok(Some(LlmCredentials {
        api_key,
        api_url: active_provider.api_url,
    }))
}

fn credential_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(CREDENTIAL_REQUEST_TIMEOUT)
        .user_agent("LingFang-Desktop")
        .build()
        .map_err(|error| format!("网络请求初始化失败：{error}"))
}

async fn fetch_active_provider(
    client: &reqwest::Client,
    base: &str,
    auth_token: &str,
) -> Result<Option<ActiveProvider>, String> {
    let response = match client
        .get(format!("{base}/api/llm/active-provider"))
        .bearer_auth(auth_token)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    let parsed = response
        .json::<ActiveProviderResponse>()
        .await
        .map_err(|error| format!("active-provider 响应解析失败：{error}"))?;
    Ok(Some(active_provider_from_response(parsed)?))
}

async fn fetch_decrypted_api_key(
    client: &reqwest::Client,
    base: &str,
    auth_token: &str,
) -> Result<Option<String>, String> {
    let response = match client
        .post(format!("{base}/api/llm/binding/decrypt"))
        .bearer_auth(auth_token)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    let parsed = response
        .json::<DecryptKeyResponse>()
        .await
        .map_err(|error| format!("binding/decrypt 响应解析失败：{error}"))?;
    required_response_field(Some(&parsed.api_key), "binding/decrypt", "apiKey").map(Some)
}

fn active_provider_from_response(
    response: ActiveProviderResponse,
) -> Result<ActiveProvider, String> {
    required_response_field(response.provider.as_deref(), "active-provider", "provider")?;
    Ok(ActiveProvider {
        api_url: required_response_field(response.api_url.as_deref(), "active-provider", "apiUrl")?,
    })
}

fn required_response_field(
    value: Option<&str>,
    source: &str,
    field: &str,
) -> Result<String, String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{source} 响应缺少 {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 锁定后端 camelCase 字段映射（防止 api_url/apiUrl 大小写不匹配导致恒降级）。
    // 历史 bug：曾漏写 rename="apiUrl"，后端返 apiUrl 而 serde 找 api_url，字段恒 None → 违反 AC1-AC3。

    #[test]
    fn active_provider_parses_camel_case_api_url() {
        // 后端实际返回 { name, apiUrl, defaultModels }（见 llm.service.ts getActiveProvider）。
        let body = r#"{"name":"LingFang","provider":"openai","apiUrl":"https://api.example.com","defaultModels":["gpt-4"]}"#;
        let parsed: ActiveProviderResponse = serde_json::from_str(body).expect("应可解析");
        assert_eq!(parsed.api_url.as_deref(), Some("https://api.example.com"));
    }

    #[test]
    fn active_provider_parses_provider_id() {
        let body = r#"{"provider":"moonshot","apiUrl":"https://api.moonshot.cn/v1"}"#;
        let parsed: ActiveProviderResponse = serde_json::from_str(body).expect("应可解析");

        assert_eq!(parsed.provider.as_deref(), Some("moonshot"));
    }

    #[test]
    fn active_provider_missing_api_url_is_explicit_error() {
        let body = r#"{"provider":"openai","name":"X","defaultModels":[]}"#;
        let parsed: ActiveProviderResponse = serde_json::from_str(body).expect("应可解析");
        let error = active_provider_from_response(parsed).unwrap_err();

        assert!(error.contains("apiUrl"));
    }

    #[test]
    fn decrypt_key_parses_camel_case_api_key() {
        // 后端实际返回 { apiKey: plaintext }（见 llm.service.ts decryptBindingKey）。
        let body = r#"{"apiKey":"sk-plaintext-123"}"#;
        let parsed: DecryptKeyResponse = serde_json::from_str(body).expect("应可解析");
        assert_eq!(parsed.api_key, "sk-plaintext-123");
    }
}
