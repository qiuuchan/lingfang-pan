use super::*;
use std::path::PathBuf;

// === workspace 扫描（SDK 本地工具写文件到 workspace 后扫描收成 files） ===
//
// 覆盖 scan_workspace_files + collect_workspace_files：
// - 正常扫描 manifest.json + ui/index.html（网页插件典型产出）。
// - 排除隐藏文件（.env）、node_modules、.git。
// - 跳过二进制文件（非 UTF-8）。
// - 跳过超大文件（>256KB）。
// - manifest.json 置顶。
// - session 不存在报错；sandbox 空目录返回空列表。

/// 构造一个带 workspace 记录的 state（workspace_dir 指向临时目录）。
/// 返回 (state, workspace_root)：测试方在 workspace_root 下写文件后调 scan_workspace_files。
fn state_with_sandbox(test_name: &str) -> (CodeAssistantState, PathBuf) {
    let store = temp_assistant_store(test_name);
    let sandbox = store.root().join("sdk-workspace");
    std::fs::create_dir_all(&sandbox).unwrap();
    // 写一条 session 记录，workspace_dir 指向 workspace（scan_workspace_files 从此取路径）。
    store
        .upsert_session(SessionRecord {
            session_id: "scan-1".into(),
            tool: CodeAssistantTool::Claude,
            model: Some("sonnet".into()),
            workspace_dir: sandbox.to_string_lossy().to_string(),
            status: "exited".into(),
            transcript_path: store
                .transcript_path("scan-1")
                .to_string_lossy()
                .to_string(),
            command_preview: vec!["ClaudeCode SDK".into()],
            pid: None,
            started_at: "1".into(),
            ended_at: None,
            exit_code: Some(0),
            cli_session_id: None,
            title: None,
            archived: None,
            draft_updated_at: None,
        })
        .unwrap();
    let state = CodeAssistantState {
        store,
        tasks: Arc::new(Mutex::new(HashMap::new())),
    };
    (state, sandbox)
}

#[test]
fn scan_returns_manifest_and_files_with_relative_paths() {
    // SDK 工具典型产出：manifest.json + ui/index.html，扫描返回相对路径。
    let (state, sandbox) = state_with_sandbox("scan-normal");
    std::fs::write(
        sandbox.join("manifest.json"),
        r#"{"id":"pomodoro","name":"番茄钟"}"#,
    )
    .unwrap();
    std::fs::create_dir_all(sandbox.join("ui")).unwrap();
    std::fs::write(sandbox.join("ui").join("index.html"), "<html></html>").unwrap();

    let files = scan_workspace_files(
        &state,
        ScanWorkspaceInput {
            session_id: "scan-1".to_string(),
        },
    )
    .expect("扫描应成功");

    // manifest.json 置顶，ui/index.html 跟随；路径用 / 分隔（跨平台一致）。
    assert_eq!(files.len(), 2, "应返回 2 个文件，实际 {files:?}");
    assert_eq!(files[0].path, "manifest.json", "manifest.json 应置顶");
    assert_eq!(files[0].content, r#"{"id":"pomodoro","name":"番茄钟"}"#);
    assert_eq!(files[1].path, "ui/index.html");
    assert_eq!(files[1].content, "<html></html>");
}

#[test]
fn scan_excludes_hidden_files_and_node_modules_and_git() {
    // 排除 .env / .git 目录 / node_modules 目录（依赖体积大且非插件源码）。
    let (state, sandbox) = state_with_sandbox("scan-exclude");
    std::fs::write(sandbox.join("manifest.json"), "{}").unwrap();
    std::fs::write(sandbox.join(".env"), "SECRET=xxx").unwrap();
    std::fs::create_dir_all(sandbox.join(".git")).unwrap();
    std::fs::write(sandbox.join(".git").join("config"), "git-config").unwrap();
    std::fs::create_dir_all(sandbox.join("node_modules")).unwrap();
    std::fs::write(
        sandbox.join("node_modules").join("lib.js"),
        "module.exports = 1",
    )
    .unwrap();
    std::fs::create_dir_all(sandbox.join("ui")).unwrap();
    std::fs::write(sandbox.join("ui").join("index.html"), "<html></html>").unwrap();

    let files = scan_workspace_files(
        &state,
        ScanWorkspaceInput {
            session_id: "scan-1".to_string(),
        },
    )
    .expect("扫描应成功");

    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    // 仅保留 manifest.json + ui/index.html，.env / .git / node_modules 全部排除。
    assert!(paths.contains(&"manifest.json"), "应含 manifest.json");
    assert!(paths.contains(&"ui/index.html"), "应含 ui/index.html");
    assert!(!paths.contains(&".env"), "不应含 .env");
    assert!(
        !paths.iter().any(|p| p.starts_with(".git")),
        "不应含 .git 目录内文件"
    );
    assert!(
        !paths.iter().any(|p| p.starts_with("node_modules")),
        "不应含 node_modules 目录内文件"
    );
}

#[test]
fn scan_skips_binary_files() {
    // 二进制文件（非 UTF-8）跳过，不报错（read_to_string 失败即跳过）。
    let (state, sandbox) = state_with_sandbox("scan-binary");
    std::fs::write(sandbox.join("manifest.json"), "{}").unwrap();
    // 写入无效 UTF-8 字节序列（二进制文件）。
    let binary = vec![0xFFu8, 0xFE, 0xFD, 0x00];
    std::fs::write(sandbox.join("image.png"), binary).unwrap();
    std::fs::create_dir_all(sandbox.join("ui")).unwrap();
    std::fs::write(sandbox.join("ui").join("index.html"), "<html></html>").unwrap();

    let files = scan_workspace_files(
        &state,
        ScanWorkspaceInput {
            session_id: "scan-1".to_string(),
        },
    )
    .expect("扫描应成功（二进制跳过不报错）");

    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert!(!paths.contains(&"image.png"), "二进制文件应跳过");
    assert!(paths.contains(&"manifest.json"));
    assert!(paths.contains(&"ui/index.html"));
}

#[test]
fn scan_skips_oversized_files() {
    // 超大文件（>256KB）跳过，对齐后端 MAX_PLUGIN_FILE_BYTES 限制。
    let (state, sandbox) = state_with_sandbox("scan-oversize");
    std::fs::write(sandbox.join("manifest.json"), "{}").unwrap();
    // 写一个 300KB 的文本文件（超 256KB 限制）。
    let big = "x".repeat(300 * 1024);
    std::fs::write(sandbox.join("huge.txt"), big).unwrap();
    std::fs::create_dir_all(sandbox.join("ui")).unwrap();
    std::fs::write(sandbox.join("ui").join("index.html"), "<html></html>").unwrap();

    let files = scan_workspace_files(
        &state,
        ScanWorkspaceInput {
            session_id: "scan-1".to_string(),
        },
    )
    .expect("扫描应成功（超大文件跳过）");

    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert!(!paths.contains(&"huge.txt"), "超大文件应跳过");
    assert!(paths.contains(&"manifest.json"));
}

#[test]
fn scan_empty_sandbox_returns_empty_list() {
    // 空目录（纯对话 / SDK 未写文件）返回空列表，调用方据此回退对话态逻辑。
    let (state, _sandbox) = state_with_sandbox("scan-empty");
    let files = scan_workspace_files(
        &state,
        ScanWorkspaceInput {
            session_id: "scan-1".to_string(),
        },
    )
    .expect("空 sandbox 应返回空列表");
    assert!(files.is_empty(), "空 sandbox 应返回空列表");
}

#[test]
fn scan_missing_session_errors() {
    // session 不存在报错（不静默吞，避免前端拿到空列表误判为「SDK 没写文件」）。
    let store = temp_assistant_store("scan-missing-session");
    let state = CodeAssistantState {
        store,
        tasks: Arc::new(Mutex::new(HashMap::new())),
    };
    let result = scan_workspace_files(
        &state,
        ScanWorkspaceInput {
            session_id: "nonexistent".to_string(),
        },
    );
    assert!(result.is_err(), "session 不存在应报错");
}

// 修复 RUSTSHIM-04（medium 逻辑 bug）：sandbox 内目录符号链接环不应导致栈溢出 panic。
// 修复前用 entry.metadata()（跟随符号链接）判定 is_dir，对指向祖先目录的符号链接
// 递归 collect_workspace_files 会沿符号链接无限深入，栈溢出 abort 整个 Tauri 进程。
// 修复后用 symlink_metadata（不跟随），符号链接被视为非目录直接跳过。
// 注：Unix 才支持创建符号链接；Windows 需要特殊权限/开发者模式，cfg 限制为 unix。
#[cfg(unix)]
#[test]
fn scan_does_not_stack_overflow_on_symlink_loop() {
    use std::os::unix::fs::symlink;
    let (state, sandbox) = state_with_sandbox("scan-symlink-loop");
    std::fs::write(sandbox.join("manifest.json"), "{}").unwrap();
    std::fs::create_dir_all(sandbox.join("realdir")).unwrap();
    std::fs::write(sandbox.join("realdir").join("a.txt"), "a").unwrap();
    // 创建指向祖先目录的符号链接（构成环：sandbox/loop -> sandbox）。
    symlink(&sandbox, sandbox.join("loop")).unwrap();
    // 创建指向自身的目录符号链接（最经典的环）。
    symlink(sandbox.join("self-loop"), sandbox.join("self-loop-target")).ok(); // 可能因目标不存在而失败，不影响主断言

    // 关键断言：scan 应正常返回（不栈溢出 panic），且符号链接本身被跳过。
    let files = scan_workspace_files(
        &state,
        ScanWorkspaceInput {
            session_id: "scan-1".to_string(),
        },
    )
    .expect("符号链接环场景应正常扫描不栈溢出");
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    // manifest.json + realdir/a.txt 应被收集；符号链接目录不被递归。
    assert!(paths.contains(&"manifest.json"), "应含 manifest.json");
    assert!(paths.contains(&"realdir/a.txt"), "应含 realdir/a.txt");
    // 符号链接目录不应进结果（symlink_metadata 判定为非普通文件，跳过）。
    assert!(
        !paths.iter().any(|p| p.starts_with("loop")),
        "符号链接目录不应被递归扫描：{paths:?}"
    );
}
