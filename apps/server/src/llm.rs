//! 第三方 LLM 网关调用 + 插件生成服务（见 docs/03 §B、docs/01 §10）。
//! 平台只转发与生成、不计费；第三方 key 仅服务端持有。

use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::crypto;
use crate::error::AppError;
use crate::state::AppState;

pub struct ResolvedBinding {
    pub base_url: String,
    pub api_key: String,
    pub default_model: String,
}

/// 单次生成的输出上限。插件草稿把 manifest + HTML/CSS/JS 拼成一行 JSON，体积大；
/// 不显式放宽时网关会套用偏小的默认上限，把输出截断成未闭合的 JSON 字符串（EOF 解析失败）。
/// 取值覆盖当前主流模型的输出上限，足以容纳完整插件草稿。
const MAX_TOKENS: u32 = 8192;

/// 取租户绑定并解密 key；未配置则显式失败（不伪造结果）。
pub async fn resolve_binding(
    state: &AppState,
    tenant_id: Uuid,
) -> Result<ResolvedBinding, AppError> {
    let row = sqlx::query_as::<_, (String, String, Value)>(
        "SELECT base_url, api_key_ciphertext, models FROM llm_gateway_bindings \
         WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1",
    )
    .bind(tenant_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::LlmBindingMissing)?;

    let api_key = crypto::decrypt(&row.1, &state.config.key_encryption_secret)
        .ok_or_else(|| AppError::Internal("解密 LLM key 失败".into()))?;
    let default_model = row
        .2
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .unwrap_or("gpt-4o-mini")
        .to_string();

    Ok(ResolvedBinding {
        base_url: row.0,
        api_key,
        default_model,
    })
}

/// 拉取网关可用模型列表（GET /models）。成功即说明 base_url + key 可用，兼作连接测试。
pub async fn list_models(
    state: &AppState,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, AppError> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let resp = state
        .http
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| AppError::UpstreamLlm(e.to_string()))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::UpstreamLlm(format!("{code}: {body}")));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| AppError::UpstreamLlm(e.to_string()))?;
    // OpenAI 兼容格式：{ "data": [ { "id": "..." }, ... ] }
    let mut models: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    Ok(models)
}

#[derive(Deserialize)]
struct ChatResp {
    choices: Vec<ChatChoice>,
}
#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMsg,
}
#[derive(Deserialize)]
struct ChatMsg {
    content: String,
}

/// 调 OpenAI 兼容 /chat/completions（非流式；SSE 流式留待后续优化）。
pub async fn chat_completion(
    state: &AppState,
    binding: &ResolvedBinding,
    model: &str,
    messages: Value,
) -> Result<String, AppError> {
    let url = format!(
        "{}/chat/completions",
        binding.base_url.trim_end_matches('/')
    );
    let resp = state
        .http
        .post(url)
        .bearer_auth(&binding.api_key)
        .json(&json!({ "model": model, "messages": messages, "max_tokens": MAX_TOKENS }))
        .send()
        .await
        .map_err(|e| AppError::UpstreamLlm(e.to_string()))?;

    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::UpstreamLlm(format!("{code}: {body}")));
    }
    let parsed: ChatResp = resp
        .json()
        .await
        .map_err(|e| AppError::UpstreamLlm(e.to_string()))?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| AppError::UpstreamLlm("空响应".into()))
}

/// 流式增量的两类内容：模型思考（reasoning）与正文（content）。
pub enum StreamDelta<'a> {
    /// 原生推理增量（如 deepseek-r1 的 reasoning_content）。
    Reasoning(&'a str),
    /// 正文增量 + 截至目前的完整正文累积。
    Content { token: &'a str, full: &'a str },
}

/// 调 OpenAI 兼容 /chat/completions（流式）。
/// `on_delta` 对每个增量回调（区分思考/正文）；返回拼接后的完整正文内容。
pub async fn chat_completion_stream<F>(
    state: &AppState,
    binding: &ResolvedBinding,
    model: &str,
    messages: Value,
    mut on_delta: F,
) -> Result<String, AppError>
where
    F: FnMut(StreamDelta),
{
    use futures_util::StreamExt;

    let url = format!(
        "{}/chat/completions",
        binding.base_url.trim_end_matches('/')
    );
    let resp = state
        .http
        .post(url)
        .bearer_auth(&binding.api_key)
        .json(&json!({ "model": model, "messages": messages, "stream": true, "max_tokens": MAX_TOKENS }))
        .send()
        .await
        .map_err(|e| AppError::UpstreamLlm(e.to_string()))?;

    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::UpstreamLlm(format!("{code}: {body}")));
    }

    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    // 回退思考解析：累积全部 content 原始流，从中切分 <think>…</think> 与正文，
    // 已发出的思考/正文长度用指针记录，避免重复。原生 reasoning_content 直接走 Reasoning 分发。
    let mut content_raw = String::new();
    let mut emitted_think = 0usize;
    let mut emitted_body = 0usize;

    // 解析 SSE：按行读取 `data: {json}`，抽取 delta.content（正文）与 delta.reasoning_content（思考）。
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| AppError::UpstreamLlm(e.to_string()))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            let data = match line.strip_prefix("data:") {
                Some(d) => d.trim(),
                None => continue,
            };
            if data == "[DONE]" {
                return Ok(full);
            }
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                let delta = v
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"));
                // 原生推理增量：reasoning_content（deepseek 系）或 reasoning（部分网关）。
                if let Some(r) = delta
                    .and_then(|d| d.get("reasoning_content").or_else(|| d.get("reasoning")))
                    .and_then(|t| t.as_str())
                {
                    if !r.is_empty() {
                        on_delta(StreamDelta::Reasoning(r));
                    }
                }
                if let Some(token) = delta
                    .and_then(|d| d.get("content"))
                    .and_then(|t| t.as_str())
                {
                    if !token.is_empty() {
                        content_raw.push_str(token);
                        // 从累积原始流切分思考与正文，分别发出各自的新增部分。
                        let (think, body, body_ready) = split_think(&content_raw);
                        if think.len() > emitted_think {
                            on_delta(StreamDelta::Reasoning(&think[emitted_think..]));
                            emitted_think = think.len();
                        }
                        if body_ready && body.len() > emitted_body {
                            let new_body = &body[emitted_body..];
                            emitted_body = body.len();
                            full.push_str(new_body);
                            on_delta(StreamDelta::Content {
                                token: new_body,
                                full: &full,
                            });
                        }
                    }
                }
            }
        }
    }
    Ok(full)
}

/// 从 content 原始流中切分回退思考块与正文。
/// 返回 (思考文本, 正文文本, 正文是否可发出)。
/// 规则：去前导空白后若以 `<think>` 开头，则 `</think>` 之前为思考、之后为正文；
/// 否则整体为正文。开头尚不足以判定（可能是被拆分的 `<think>` 前缀）时，正文暂不发出。
fn split_think(raw: &str) -> (&str, &str, bool) {
    const OPEN: &str = "<think>";
    const CLOSE: &str = "</think>";
    let trimmed_start = raw.len() - raw.trim_start().len();
    let rest = &raw[trimmed_start..];

    if let Some(after_open) = rest.strip_prefix(OPEN) {
        let think_start = trimmed_start + OPEN.len();
        match rest.find(CLOSE) {
            Some(close_rel) => {
                let think = &raw[think_start..trimmed_start + close_rel];
                let body_start = trimmed_start + close_rel + CLOSE.len();
                (think, &raw[body_start..], true)
            }
            // 仍在思考中：全部是思考，正文未开始。
            None => (after_open, "", false),
        }
    } else if OPEN.starts_with(rest) || rest.is_empty() {
        // 开头可能是被拆分的 <think> 前缀（如 "<th"），暂不判定为正文。
        ("", "", false)
    } else {
        // 确定不以 <think> 开头：整体为正文。
        ("", raw, true)
    }
}

/// 对完整生成文本做解析 + 校验，复用于流式与非流式结尾。
pub fn finalize_generation(raw: &str) -> Result<GeneratedPlugin, AppError> {
    // 先剥离回退思考块 <think>…</think>，避免其中的花括号干扰 JSON 抽取。
    let body = strip_think(raw);
    let json_text = extract_json(body).ok_or_else(|| {
        // 失败时附上模型实际输出（截断到合理长度），便于用户与排障定位「模型到底吐了什么」。
        AppError::GenerationInvalid(format!("模型输出中未找到 JSON 对象。{}", excerpt(body)))
    })?;
    let parsed: Value = serde_json::from_str(&json_text).map_err(|e| {
        AppError::GenerationInvalid(format!("JSON 解析失败: {e}。{}", excerpt(body)))
    })?;
    let files = parse_files(&parsed)?;
    let diagnostics = validate(&files);
    let ok = diagnostics.iter().all(|(_, status, _)| status == "pass");
    let assistant_note = parsed
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("已生成插件草稿。")
        .to_string();
    Ok(GeneratedPlugin {
        files,
        diagnostics,
        assistant_note,
        ok,
    })
}

/// 把模型原始输出裁剪成可读摘要附到错误里：空输出明确指出，过长则首尾保留并标注省略。
fn excerpt(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "模型返回为空（可能是 key 额度/网关配置问题）。".to_string();
    }
    const MAX: usize = 600;
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= MAX {
        format!("模型实际输出：\n{trimmed}")
    } else {
        let head: String = chars[..MAX].iter().collect();
        format!(
            "模型实际输出（前 {MAX} 字，共 {} 字）：\n{head}…",
            chars.len()
        )
    }
}

pub struct GeneratedPlugin {
    pub files: Vec<(String, String)>,               // (path, content)
    pub diagnostics: Vec<(String, String, String)>, // (stage, status, message)
    pub assistant_note: String,
    pub ok: bool, // 所有校验通过
}

const SYSTEM_PROMPT: &str = "你是 LingFang 平台的插件生成器。根据用户的自然语言需求，生成一个可在沙箱中运行的 Web 插件。\n\
先思考再产出：在 <think> 与 </think> 标记之间用中文简述你的设计思路（要做哪些文件、关键交互、注意点），然后在思考结束后只输出一个 JSON 对象。\n\
JSON 形如：\n\
{\"files\":[{\"path\":\"manifest.json\",\"content\":\"...\"},{\"path\":\"ui/index.html\",\"content\":\"...\"}],\"summary\":\"一句话说明\"}\n\
要求：\n\
- 必须包含 manifest.json（字段 id,name,version,description,runtime_type='client',entry='ui/index.html',visibility='tenant',capabilities[]）以及 entry 指向的 UI 文件。\n\
- id 用小写字母/数字/点/连字符（如 user.todo-list）；version 用语义化版本（如 0.1.0）。\n\
- UI 用纯 HTML/CSS/JS，单文件内联样式与脚本。禁止 import、require、fetch、XMLHttpRequest、eval、直接访问网络或文件系统。需要这些能力时在 manifest.capabilities 里声明，并用宿主注入的全局对象 sdk（如 sdk.fs.pick、sdk.llm.chat）调用。\n\
- 需要 AI 能力时用 sdk.llm.chat({ messages, model }) 并在 capabilities 声明 {\"kind\":\"llm.chat\"}；该调用经平台网关，返回字符串。\n\
- 界面要完整可用：含基本的输入校验、空状态提示、错误处理，交互顺滑，移动端也能用。\n\
- 样式现代简洁，优先消费宿主 design token（如 var(--lf-color-primary)），无 token 时用克制的中性配色，不要大红大绿。\n\
- 面向非技术用户，文案用简洁中文。\n\
- 迭代修改时：在“当前文件快照”基础上做最小必要改动，保留无关代码与用户既有数据结构，不要推倒重写。\n\
JSON 之外不要输出任何内容（不要 markdown 代码围栏、不要在 JSON 后再解释）。";

/// 构造生成插件的消息序列（流式与非流式共用）。
pub fn build_messages(user_prompt: &str, current_files: &Value) -> Value {
    json!([
        { "role": "system", "content": SYSTEM_PROMPT },
        { "role": "user", "content": format!("需求：{user_prompt}\n\n当前文件快照（迭代时在此基础上修改）：\n{current_files}") }
    ])
}

/// 依据流式累积的 JSON 文本推断当前阶段，供前端展示「思考 / 编写某文件 / 校验」等具体进度。
pub fn stream_stage(acc: &str) -> String {
    if !acc.contains("\"files\"") {
        return "正在理解需求、构思插件结构…".to_string();
    }
    // summary 出现意味着文件数组已写完，进入收尾。
    if acc.contains("\"summary\"") {
        return "正在整理与校验插件…".to_string();
    }
    match last_json_path(acc) {
        Some(p) => format!("正在编写 {p}…"),
        None => "正在规划文件结构…".to_string(),
    }
}

/// 从累积文本里取最后一个 `"path":"xxx"` 的值（容忍冒号前后空白、半截路径）。
fn last_json_path(acc: &str) -> Option<String> {
    let mut result = None;
    let mut search_from = 0;
    let needle = "\"path\"";
    while let Some(rel) = acc[search_from..].find(needle) {
        let idx = search_from + rel;
        search_from = idx + needle.len();
        let after = acc[search_from..].trim_start();
        let after = match after.strip_prefix(':') {
            Some(a) => a.trim_start(),
            None => continue,
        };
        let after = match after.strip_prefix('"') {
            Some(a) => a,
            None => continue,
        };
        if let Some(end) = after.find('"') {
            result = Some(after[..end].to_string());
        }
    }
    result
}

/// 生成/迭代插件：构造 prompt → 调 LLM → 抽 JSON → 解析文件 → 校验。
pub async fn generate_plugin(
    state: &AppState,
    binding: &ResolvedBinding,
    model: &str,
    user_prompt: &str,
    current_files: &Value,
) -> Result<GeneratedPlugin, AppError> {
    let messages = build_messages(user_prompt, current_files);
    let raw = chat_completion(state, binding, model, messages).await?;
    finalize_generation(&raw)
}

/// 从模型输出里抽出 JSON 对象（容忍前后多余文本 / 代码围栏）。
fn extract_json(raw: &str) -> Option<String> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end > start {
        Some(raw[start..=end].to_string())
    } else {
        None
    }
}

/// 剥离回退思考块 <think>…</think>（含未闭合的情况），返回其后的正文切片。
fn strip_think(raw: &str) -> &str {
    let trimmed = raw.trim_start();
    if let Some(after_open) = trimmed.strip_prefix("<think>") {
        match after_open.find("</think>") {
            Some(close) => after_open[close + "</think>".len()..].trim_start(),
            None => "", // 只有思考、未产出正文
        }
    } else {
        raw
    }
}

fn parse_files(parsed: &Value) -> Result<Vec<(String, String)>, AppError> {
    let arr = parsed
        .get("files")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::GenerationInvalid("缺少 files 数组".into()))?;
    let mut files = Vec::new();
    for item in arr {
        let path = item
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::GenerationInvalid("file 缺少 path".into()))?;
        let content = item.get("content").and_then(|v| v.as_str()).unwrap_or("");
        files.push((path.to_string(), content.to_string()));
    }
    if files.is_empty() {
        return Err(AppError::GenerationInvalid("files 为空".into()));
    }
    Ok(files)
}

/// schema + 安全校验，返回诊断列表（见 docs/03 §8：不过则上层据此置 invalid）。
fn validate(files: &[(String, String)]) -> Vec<(String, String, String)> {
    let mut diags: Vec<(String, String, String)> = Vec::new();

    // schema：manifest.json 存在、合法、entry 指向真实文件
    match files.iter().find(|(p, _)| p == "manifest.json") {
        None => diags.push(("schema".into(), "fail".into(), "缺少 manifest.json".into())),
        Some((_, content)) => match serde_json::from_str::<Value>(content) {
            Ok(m) => {
                let entry = m.get("entry").and_then(|v| v.as_str());
                let has_id = m.get("id").and_then(|v| v.as_str()).is_some();
                let has_name = m.get("name").and_then(|v| v.as_str()).is_some();
                if !has_id || !has_name || entry.is_none() {
                    diags.push((
                        "schema".into(),
                        "fail".into(),
                        "manifest 缺少 id/name/entry".into(),
                    ));
                } else if !files.iter().any(|(p, _)| Some(p.as_str()) == entry) {
                    diags.push((
                        "schema".into(),
                        "fail".into(),
                        format!("entry 指向的文件不存在: {}", entry.unwrap_or("")),
                    ));
                } else {
                    diags.push(("schema".into(), "pass".into(), "manifest 合法".into()));
                }
            }
            Err(e) => diags.push((
                "schema".into(),
                "fail".into(),
                format!("manifest 非合法 JSON: {e}"),
            )),
        },
    }

    // security：UI 文件禁止直连网络 / 越权
    let forbidden = ["import ", "require(", "fetch(", "XMLHttpRequest", "eval("];
    let mut sec_ok = true;
    for (path, content) in files {
        if path.ends_with(".html") || path.ends_with(".js") {
            for bad in forbidden {
                if content.contains(bad) {
                    diags.push((
                        "security".into(),
                        "fail".into(),
                        format!("{path} 含禁止用法: {bad}"),
                    ));
                    sec_ok = false;
                }
            }
        }
    }
    if sec_ok {
        diags.push((
            "security".into(),
            "pass".into(),
            "无直连网络/越权用法".into(),
        ));
    }

    diags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_from_noisy_output() {
        let raw = "这是说明\n{\"files\":[]}\n谢谢";
        assert_eq!(extract_json(raw).as_deref(), Some("{\"files\":[]}"));
    }

    #[test]
    fn validate_flags_missing_manifest() {
        let files = vec![("ui/index.html".to_string(), "<p>hi</p>".to_string())];
        let diags = validate(&files);
        assert!(diags
            .iter()
            .any(|(stage, status, _)| stage == "schema" && status == "fail"));
    }

    #[test]
    fn validate_flags_forbidden_usage() {
        let files = vec![
            (
                "manifest.json".to_string(),
                "{\"id\":\"x\",\"name\":\"X\",\"entry\":\"ui/index.html\"}".to_string(),
            ),
            (
                "ui/index.html".to_string(),
                "<script>fetch('/evil')</script>".to_string(),
            ),
        ];
        let diags = validate(&files);
        assert!(diags
            .iter()
            .any(|(stage, status, _)| stage == "security" && status == "fail"));
    }

    #[test]
    fn validate_passes_clean_plugin() {
        let files = vec![
            (
                "manifest.json".to_string(),
                "{\"id\":\"x\",\"name\":\"X\",\"entry\":\"ui/index.html\"}".to_string(),
            ),
            (
                "ui/index.html".to_string(),
                "<button>ok</button>".to_string(),
            ),
        ];
        let diags = validate(&files);
        assert!(diags.iter().all(|(_, status, _)| status == "pass"));
    }

    #[test]
    fn strip_think_removes_block() {
        assert_eq!(
            strip_think("<think>想一想</think>\n{\"files\":[]}"),
            "{\"files\":[]}"
        );
        // 无思考块原样返回
        assert_eq!(strip_think("{\"files\":[]}"), "{\"files\":[]}");
        // 只有思考、未产出正文
        assert_eq!(strip_think("<think>仍在想"), "");
    }

    #[test]
    fn finalize_strips_think_with_braces() {
        // 思考块内含花括号，不应干扰 JSON 抽取。
        let raw = "<think>我打算用 {key:value} 结构</think>{\"files\":[{\"path\":\"manifest.json\",\"content\":\"{}\"},{\"path\":\"ui/index.html\",\"content\":\"<b>hi</b>\"}],\"summary\":\"ok\"}";
        let g = finalize_generation(raw).expect("应成功解析");
        assert_eq!(g.files.len(), 2);
    }

    #[test]
    fn split_think_streaming_phases() {
        // 还在思考中：正文未就绪
        let (think, _body, ready) = split_think("<think>构思中");
        assert_eq!(think, "构思中");
        assert!(!ready);
        // 思考结束，正文开始
        let (think, body, ready) = split_think("<think>好了</think>{\"files\"");
        assert_eq!(think, "好了");
        assert_eq!(body, "{\"files\"");
        assert!(ready);
        // 无思考块：整体即正文
        let (think, body, ready) = split_think("{\"files\":[]}");
        assert_eq!(think, "");
        assert_eq!(body, "{\"files\":[]}");
        assert!(ready);
        // 被拆分的 <think> 前缀：暂不判定为正文
        let (_t, _b, ready) = split_think("<thi");
        assert!(!ready);
    }

    #[test]
    fn stream_stage_progresses_with_content() {
        assert_eq!(stream_stage("{\"fil"), "正在理解需求、构思插件结构…");
        assert_eq!(
            stream_stage("{\"files\":[{\"path\":\"manifest.json\",\"content\":\"..."),
            "正在编写 manifest.json…"
        );
        assert_eq!(
            stream_stage("{\"files\":[{\"path\":\"ui/index.html\"}],\"summary\":\"x\"}"),
            "正在整理与校验插件…"
        );
    }

    #[test]
    fn last_json_path_takes_latest() {
        let acc = "{\"files\":[{\"path\":\"manifest.json\"},{\"path\":\"ui/index.html\"";
        assert_eq!(last_json_path(acc).as_deref(), Some("ui/index.html"));
    }

    #[test]
    fn excerpt_reports_empty_and_text() {
        assert!(excerpt("   ").contains("为空"));
        assert!(excerpt("抱歉，我无法完成").contains("模型实际输出"));
    }

    #[test]
    fn finalize_generation_surfaces_raw_on_no_json() {
        let msg = match finalize_generation("抱歉，我不能生成") {
            Err(e) => e.to_string(),
            Ok(_) => panic!("无 JSON 输出应当报错"),
        };
        assert!(msg.contains("未找到 JSON 对象"));
        assert!(msg.contains("抱歉，我不能生成"));
    }
}
