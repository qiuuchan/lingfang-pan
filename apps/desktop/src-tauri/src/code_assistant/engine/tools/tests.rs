use std::path::PathBuf;

use serde_json::json;

use super::*;

fn workspace(name: &str) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("lingfang-sdk-tools-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn ok_result(value: &serde_json::Value) -> &serde_json::Value {
    assert_eq!(value["ok"], true, "tool call failed: {value}");
    &value["result"]
}

#[test]
fn write_file_accepts_relative_workspace_path() {
    let root = workspace("valid-write");
    let tools = LocalToolExecutor::new(root.clone());

    tools.write_file("ui/index.html", "<html></html>").unwrap();

    assert_eq!(
        std::fs::read_to_string(root.join("ui").join("index.html")).unwrap(),
        "<html></html>"
    );
}

#[test]
fn write_file_rejects_absolute_path() {
    let root = workspace("absolute");
    let tools = LocalToolExecutor::new(root);

    let error = tools
        .write_file("C:/Users/test/secret.txt", "x")
        .unwrap_err();

    assert!(error.contains("绝对路径"));
}

#[test]
fn write_file_rejects_parent_traversal() {
    let root = workspace("parent");
    let tools = LocalToolExecutor::new(root);

    let error = tools.write_file("../secret.txt", "x").unwrap_err();

    assert!(error.contains(".."));
}

#[test]
fn write_file_rejects_hidden_segments() {
    let root = workspace("hidden");
    let tools = LocalToolExecutor::new(root);

    let error = tools.write_file(".env", "TOKEN=x").unwrap_err();

    assert!(error.contains("隐藏"));
}

#[test]
fn list_local_directory_accepts_absolute_path() {
    let root = workspace("local-list");
    let source = workspace("local-list-source");
    std::fs::write(source.join("app.py"), "print('ok')").unwrap();
    let tools = LocalToolExecutor::new(root);

    let value = tools.execute(
        "list_local_directory",
        &json!({ "path": source.to_string_lossy() }),
    );
    let result = ok_result(&value);

    assert_eq!(result["entries"][0]["name"], "app.py");
}

#[test]
fn read_local_file_accepts_absolute_path() {
    let root = workspace("local-read");
    let source = workspace("local-read-source");
    let file = source.join("main.py");
    std::fs::write(&file, "print('hello')").unwrap();
    let tools = LocalToolExecutor::new(root);

    let value = tools.execute(
        "read_local_file",
        &json!({ "path": file.to_string_lossy() }),
    );
    let result = ok_result(&value);

    assert_eq!(result["content"], "print('hello')");
}

#[test]
fn search_local_files_finds_text_under_absolute_source() {
    let root = workspace("local-search");
    let source = workspace("local-search-source");
    std::fs::create_dir_all(source.join("pkg")).unwrap();
    std::fs::write(
        source.join("pkg").join("app.py"),
        "class OutfitTool:\n    pass",
    )
    .unwrap();
    std::fs::write(source.join("notes.txt"), "nothing here").unwrap();
    let tools = LocalToolExecutor::new(root);

    let value = tools.execute(
        "search_local_files",
        &json!({ "path": source.to_string_lossy(), "query": "OutfitTool" }),
    );
    let result = ok_result(&value);

    assert_eq!(result["matches"][0]["path"], "pkg/app.py");
    assert_eq!(result["matches"][0]["line"], 1);
}

#[test]
fn import_local_project_copies_source_into_workspace() {
    let root = workspace("import-workspace");
    let source = workspace("import-source");
    std::fs::create_dir_all(source.join("pkg")).unwrap();
    std::fs::write(source.join("pkg").join("app.py"), "print('ok')").unwrap();
    let tools = LocalToolExecutor::new(root.clone());

    let value = tools.execute(
        "import_local_project",
        &json!({ "source_path": source.to_string_lossy(), "destination": "imported" }),
    );
    let result = ok_result(&value);

    assert_eq!(result["copiedFiles"], 1);
    assert_eq!(
        std::fs::read_to_string(root.join("imported").join("pkg").join("app.py")).unwrap(),
        "print('ok')"
    );
}

#[test]
fn import_local_project_skips_generated_dependency_dirs() {
    let root = workspace("import-skips-workspace");
    let source = workspace("import-skips-source");
    std::fs::create_dir_all(source.join("node_modules").join("lib")).unwrap();
    std::fs::create_dir_all(source.join(".venv").join("Scripts")).unwrap();
    std::fs::write(source.join("main.py"), "print('ok')").unwrap();
    std::fs::write(source.join("node_modules").join("lib").join("x.js"), "x").unwrap();
    std::fs::write(source.join(".venv").join("Scripts").join("python.exe"), "x").unwrap();
    let tools = LocalToolExecutor::new(root.clone());

    let value = tools.execute(
        "import_local_project",
        &json!({ "source_path": source.to_string_lossy(), "destination": "" }),
    );
    let result = ok_result(&value);

    assert_eq!(result["copiedFiles"], 1);
    assert!(result["skippedEntries"].as_u64().unwrap() >= 2);
    assert!(root.join("main.py").is_file());
    assert!(!root.join("node_modules").exists());
    assert!(!root.join(".venv").exists());
}

#[test]
fn run_command_rejects_cwd_outside_workspace_or_imported_source() {
    let root = workspace("command-workspace");
    let outside = workspace("command-outside");
    let tools = LocalToolExecutor::new(root);

    let value = tools.execute(
        "run_command",
        &json!({ "command": "echo", "args": ["hello"], "cwd": outside.to_string_lossy() }),
    );

    assert_eq!(value["ok"], false);
    assert!(value["error"].as_str().unwrap().contains("工作目录"));
}

#[test]
fn run_command_rejects_external_runtime_binary_path() {
    let root = workspace("command-runtime-absolute");
    let tools = LocalToolExecutor::new(root);

    let value = tools.execute(
        "run_command",
        &json!({ "command": "C:/Python/python.exe", "args": ["--version"] }),
    );

    assert_eq!(value["ok"], false);
    assert!(value["error"].as_str().unwrap().contains("软件内置运行时"));
}

#[test]
fn run_command_defaults_to_workspace_cwd_and_returns_output() {
    let root = workspace("command-default-cwd");
    let tools = LocalToolExecutor::new(root);

    let value = tools.execute(
        "run_command",
        &json!({ "command": "rustc", "args": ["--version"] }),
    );
    let result = ok_result(&value);

    assert_eq!(result["exitCode"], 0);
    assert!(result["stdout"].as_str().unwrap().contains("rustc"));
}
