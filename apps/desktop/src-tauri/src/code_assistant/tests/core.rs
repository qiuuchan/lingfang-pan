use super::*;

#[test]
fn command_preview_redacts_sensitive_args() {
    let preview = command_preview(
        PathBuf::from("assistant").as_path(),
        &["--api-key=abc".to_string(), "hello".to_string()],
    );
    assert_eq!(preview, vec!["assistant", "[redacted]", "hello"]);
}

#[test]
fn tail_keeps_last_chars() {
    assert_eq!(tail("abcdef", 3), "def");
    assert_eq!(tail("abc", 10), "abc");
}
