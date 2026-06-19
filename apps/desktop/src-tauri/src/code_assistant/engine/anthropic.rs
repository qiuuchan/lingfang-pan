use serde_json::Value;

use super::tools::anthropic_tool_definitions;

const MOONSHOT_PROVIDER: &str = "moonshot";
const OPENAI_V1_SUFFIX: &str = "/v1";
const ANTHROPIC_SUFFIX: &str = "/anthropic";

pub fn build_messages_url(api_url: &str) -> String {
    let base = api_url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

pub fn build_provider_messages_url(provider: &str, api_url: &str) -> String {
    let base = match normalized_provider(provider).as_deref() {
        Some(MOONSHOT_PROVIDER) => moonshot_anthropic_base(api_url),
        _ => api_url.trim_end_matches('/').to_string(),
    };
    build_messages_url(&base)
}

fn moonshot_anthropic_base(api_url: &str) -> String {
    let base = api_url.trim_end_matches('/');
    if let Some(prefix) = base.strip_suffix(OPENAI_V1_SUFFIX) {
        if prefix.ends_with(ANTHROPIC_SUFFIX) {
            return prefix.to_string();
        }
        return format!("{prefix}{ANTHROPIC_SUFFIX}");
    }
    if base.ends_with(ANTHROPIC_SUFFIX) {
        return base.to_string();
    }
    format!("{base}{ANTHROPIC_SUFFIX}")
}

fn normalized_provider(provider: &str) -> Option<String> {
    Some(provider)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

pub fn build_messages_body<R, C>(model: &str, system: Option<&str>, messages: Vec<(R, C)>) -> Value
where
    R: AsRef<str>,
    C: AsRef<str>,
{
    let messages = messages
        .into_iter()
        .map(|(role, content)| {
            serde_json::json!({ "role": role.as_ref(), "content": content.as_ref() })
        })
        .collect::<Vec<_>>();
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        "stream": true,
        "thinking": { "type": "enabled", "budget_tokens": 2048 },
        "messages": messages,
        "tools": anthropic_tool_definitions(),
    });
    if let Some(system) = system.map(str::trim).filter(|value| !value.is_empty()) {
        body["system"] = Value::String(system.to_string());
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_url_appends_anthropic_path() {
        assert_eq!(
            build_messages_url("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            build_messages_url("https://api.anthropic.com/v1/"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn provider_messages_url_uses_moonshot_anthropic_base() {
        assert_eq!(
            build_provider_messages_url("moonshot", "https://api.moonshot.cn/v1"),
            "https://api.moonshot.cn/anthropic/v1/messages"
        );
        assert_eq!(
            build_provider_messages_url("moonshot", "https://api.moonshot.cn/anthropic"),
            "https://api.moonshot.cn/anthropic/v1/messages"
        );
        assert_eq!(
            build_provider_messages_url("moonshot", "https://api.moonshot.cn/anthropic/v1"),
            "https://api.moonshot.cn/anthropic/v1/messages"
        );
    }

    #[test]
    fn messages_body_contains_model_system_messages_and_tools() {
        let body = build_messages_body(
            "claude-sonnet-4-5",
            Some("build plugins"),
            vec![("user", "生成番茄钟")],
        );

        assert_eq!(body["model"], "claude-sonnet-4-5");
        assert_eq!(body["system"], "build plugins");
        assert_eq!(body["max_tokens"], 8192);
        assert_eq!(body["stream"], true);
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 2048);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "生成番茄钟");
        assert_eq!(body["tools"][0]["name"], "list_directory");
        assert_eq!(body["tools"][1]["name"], "read_file");
        assert_eq!(body["tools"][2]["name"], "write_file");
        assert_eq!(body["tools"][3]["name"], "scan_workspace");
        assert_eq!(body["tools"][4]["name"], "list_local_directory");
        assert_eq!(body["tools"][5]["name"], "read_local_file");
        assert_eq!(body["tools"][6]["name"], "search_local_files");
        assert_eq!(body["tools"][7]["name"], "import_local_project");
        assert_eq!(body["tools"][8]["name"], "run_command");
    }
}
