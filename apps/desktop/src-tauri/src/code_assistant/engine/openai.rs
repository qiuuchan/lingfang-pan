use serde_json::Value;

use super::tools::openai_tool_definitions;

pub fn build_chat_url(api_url: &str) -> String {
    let base = api_url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

pub fn build_chat_body<R, C>(model: &str, messages: Vec<(R, C)>) -> Value
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
    serde_json::json!({
        "model": model,
        "messages": messages,
        "tools": openai_tool_definitions(),
        "tool_choice": "auto",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_url_appends_openai_compatible_path() {
        assert_eq!(
            build_chat_url("https://api.example.com"),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            build_chat_url("https://api.example.com/v1/"),
            "https://api.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn chat_body_contains_model_messages_and_tools() {
        let body = build_chat_body(
            "minimax-m3",
            vec![("system", "build plugins"), ("user", "生成番茄钟")],
        );

        assert_eq!(body["model"], "minimax-m3");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "生成番茄钟");
        assert_eq!(body["tools"][0]["function"]["name"], "list_directory");
        assert_eq!(body["tools"][1]["function"]["name"], "read_file");
        assert_eq!(body["tools"][2]["function"]["name"], "write_file");
        assert_eq!(body["tools"][3]["function"]["name"], "scan_workspace");
    }
}
