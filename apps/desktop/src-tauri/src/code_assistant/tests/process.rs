use crate::code_assistant::process::{find_binaries_in_path, resolve_npm_shim};

/// resolve_npm_shim 应从 npm .cmd（直接调 .exe）提取真实 exe 路径。
/// 这是 Windows 上 npm 全局工具的标准形态，Rust 直接 spawn .cmd 会丢孙子进程 stdout。
#[cfg(windows)]
#[test]
fn resolve_npm_shim_extracts_exe_from_cmd() {
    let dir = std::env::temp_dir().join(format!("lf-shim-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let exe_dir = dir.join("node_modules").join("fake-cli").join("bin");
    std::fs::create_dir_all(&exe_dir).unwrap();
    std::fs::write(exe_dir.join("fake.exe"), "stub").unwrap();
    let cmd_path = dir.join("fake.cmd");
    std::fs::write(
        &cmd_path,
        "@ECHO off\nSETLOCAL\nCALL :find_dp0\n\"%dp0%\\node_modules\\fake-cli\\bin\\fake.exe\"   %*\n",
    )
    .unwrap();
    let resolved = resolve_npm_shim(&cmd_path).expect("应解析出 shim 入口");
    assert_eq!(resolved.binary, exe_dir.join("fake.exe"));
    assert!(resolved.prefix_args.is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

/// resolve_npm_shim 应从 node + .js 风格 .cmd 包装成 node 调用。
#[cfg(windows)]
#[test]
fn resolve_npm_shim_wraps_js_with_node() {
    let dir = std::env::temp_dir().join(format!("lf-shim-js-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let js_dir = dir.join("node_modules").join("fake-cli").join("bin");
    std::fs::create_dir_all(&js_dir).unwrap();
    std::fs::write(js_dir.join("fake.js"), "// js").unwrap();
    let cmd_path = dir.join("fakejs.cmd");
    std::fs::write(
        &cmd_path,
        "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\" \"%dp0%\\node_modules\\fake-cli\\bin\\fake.js\" %*\n",
    )
    .unwrap();
    let resolved = resolve_npm_shim(&cmd_path).expect("应解析出 node + js");
    assert!(
        resolved.binary.file_name().unwrap() == "node.exe"
            || resolved.binary.file_name().unwrap() == "node",
        "应为 node，实际 {:?}",
        resolved.binary
    );
    assert_eq!(resolved.prefix_args.len(), 1);
    assert!(resolved.prefix_args[0].ends_with("fake.js"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn find_binaries_in_path_keeps_later_matches() {
    let root = std::env::temp_dir().join(format!(
        "lf-find-binaries-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let first = root.join("first");
    let second = root.join("second");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    #[cfg(windows)]
    {
        std::fs::write(first.join("tool.exe"), "bad").unwrap();
        std::fs::write(second.join("tool.exe"), "good").unwrap();
    }
    #[cfg(not(windows))]
    {
        std::fs::write(first.join("tool"), "bad").unwrap();
        std::fs::write(second.join("tool"), "good").unwrap();
    }
    let path = std::env::join_paths([first.as_path(), second.as_path()]).unwrap();
    let found = find_binaries_in_path("tool", &path);
    assert_eq!(found.len(), 2);
    assert!(found[0].starts_with(&first));
    assert!(found[1].starts_with(&second));
    std::fs::remove_dir_all(&root).ok();
}
