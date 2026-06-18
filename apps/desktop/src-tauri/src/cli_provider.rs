pub(crate) const CODEX_PROVIDER_ID: &str = "lingfang";
pub(crate) const OPENCODE_PROVIDER_ID: &str = "lingfang";

pub(crate) fn opencode_model_ref(model: &str) -> String {
    let provider_prefix = format!("{OPENCODE_PROVIDER_ID}/");
    if model.starts_with(&provider_prefix) {
        return model.to_string();
    }
    format!("{provider_prefix}{model}")
}
