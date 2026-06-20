use super::*;
use crate::code_assistant::find_binary;

#[test]
fn venv_python_path_is_platform_correct() {
    let venv = PathBuf::from("/tmp/.venv");
    let py = venv_python(&venv);
    #[cfg(windows)]
    assert!(py.to_string_lossy().contains("Scripts"));
    #[cfg(not(windows))]
    assert!(py.ends_with("bin/python"));
}

#[test]
fn parse_manifest_python_defaults_entry() {
    // manifest 缺 entry 时，python 默认 main.py，nodejs 默认 index.js。
    let tmp = temp_dir_unique("manifest-py");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(
        tmp.join("manifest.json"),
        r#"{"runtime_type":"python","name":"x"}"#,
    )
    .unwrap();
    let m = parse_manifest(&tmp).expect("解析应成功");
    assert_eq!(m.runtime, PluginRuntimeKind::Python);
    assert_eq!(m.entry, "main.py");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn parse_manifest_nodejs_explicit_entry() {
    let tmp = temp_dir_unique("manifest-node");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(
        tmp.join("manifest.json"),
        r#"{"runtime_type":"nodejs","entry":"src/index.js"}"#,
    )
    .unwrap();
    let m = parse_manifest(&tmp).expect("解析应成功");
    assert_eq!(m.runtime, PluginRuntimeKind::Nodejs);
    assert_eq!(m.entry, "src/index.js");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn parse_manifest_rejects_client_runtime() {
    // client（HTML）不支持独立进程运行（前端 iframe 分流）。
    let tmp = temp_dir_unique("manifest-client");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(tmp.join("manifest.json"), r#"{"runtime_type":"client"}"#).unwrap();
    assert!(parse_manifest(&tmp).is_err());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn parse_manifest_rejects_missing_file() {
    let tmp = temp_dir_unique("manifest-missing");
    std::fs::create_dir_all(&tmp).unwrap();
    // 文件不存在返回 manifest_missing: 前缀（前端据此引导重新生成，而非裸 os error 2）。
    let err = parse_manifest(&tmp).unwrap_err();
    assert!(
        err.starts_with("manifest_missing:"),
        "缺 manifest 应返回 manifest_missing 前缀，实际：{err}"
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn parse_manifest_rejects_invalid_json() {
    let tmp = temp_dir_unique("manifest-badjson");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(tmp.join("manifest.json"), "{not valid json").unwrap();
    assert!(parse_manifest(&tmp).is_err());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn minimal_env_excludes_sensitive_keys() {
    // 白名单不应含 TOKEN/KEY/SECRET/LINGFANG_ 前缀（防泄漏）。
    let env = minimal_env();
    let keys: Vec<_> = env
        .iter()
        .map(|(k, _)| k.to_string_lossy().to_string())
        .collect();
    for k in &keys {
        let upper = k.to_uppercase();
        assert!(!upper.contains("TOKEN"), "minimal_env 不应含 TOKEN：{k}");
        assert!(!upper.contains("SECRET"), "minimal_env 不应含 SECRET：{k}");
        assert!(
            !upper.contains("LINGFANG"),
            "minimal_env 不应含 LINGFANG_：{k}"
        );
    }
}

#[test]
fn bundled_pip_wheel_dir_prefers_ensurepip_bundled() {
    let root = temp_dir_unique("pip-wheel-dir");
    let bundled = root
        .join("python")
        .join("Lib")
        .join("ensurepip")
        .join("_bundled");
    std::fs::create_dir_all(&bundled).unwrap();
    std::fs::write(bundled.join("pip-25.0.1-py3-none-any.whl"), "").unwrap();
    std::fs::write(root.join("python").join("pip-older.whl"), "").unwrap();

    let runtime = EmbeddedRuntime::from_root(root.clone());
    assert_eq!(bundled_pip_wheel_dir(&runtime), Some(bundled));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn bundled_pip_wheel_dir_falls_back_to_python_root() {
    let root = temp_dir_unique("pip-wheel-root");
    let python_root = root.join("python");
    std::fs::create_dir_all(&python_root).unwrap();
    std::fs::write(python_root.join("pip-25.0.1-py3-none-any.whl"), "").unwrap();

    let runtime = EmbeddedRuntime::from_root(root.clone());
    assert_eq!(bundled_pip_wheel_dir(&runtime), Some(python_root));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn contains_pip_wheel_ignores_non_pip_wheels() {
    let root = temp_dir_unique("pip-wheel-missing");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("setuptools-1.0.0-py3-none-any.whl"), "").unwrap();

    assert!(!contains_pip_wheel(&root));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn process_table_register_and_is_running() {
    // 注册一个会立即退出的进程（true/exit 0），验证 is_running 在退出后返回 None 且自动清表。
    let table = PluginProcessTable::new();
    #[cfg(unix)]
    let mut cmd = {
        use std::os::unix::process::CommandExt;
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg("true");
        unsafe {
            c.pre_exec(|| {
                libc_setsid();
                Ok(())
            });
        }
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg("exit 0");
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        c.creation_flags(CREATE_NEW_PROCESS_GROUP);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn().expect("测试进程应能 spawn");
    let pid = table.register("test-plugin", child, "1000Z".to_string());
    assert!(pid > 0, "注册应返回有效 pid");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while table.is_running("test-plugin").is_some() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(
        table.is_running("test-plugin").is_none(),
        "进程退出后 is_running 应返回 None 并清表"
    );
}

#[test]
fn process_table_stop_plugin_kills_running_process() {
    let _guard = crate::code_assistant::process_tree_test_lock();
    // take + kill_child_tree 应能杀掉一个运行中的长进程。
    let table = PluginProcessTable::new();
    #[cfg(unix)]
    let mut cmd = {
        use std::os::unix::process::CommandExt;
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg("sleep 30");
        unsafe {
            c.pre_exec(|| {
                libc_setsid();
                Ok(())
            });
        }
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let node = match find_binary("node") {
            Some(binary) => binary,
            None => {
                eprintln!("[skip] 宿主无 node，跳过进程停止测试");
                return;
            }
        };
        let mut c = std::process::Command::new(node);
        c.args(["-e", "setInterval(() => {}, 1000)"]);
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        c.creation_flags(CREATE_NEW_PROCESS_GROUP);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn().expect("测试长进程应能 spawn");
    let _pid = table.register("long-plugin", child, "2000Z".to_string());
    // 取出并杀。
    let (mut killed_child, _) = table.take("long-plugin").expect("应能取出注册的进程");
    let started = std::time::Instant::now();
    kill_child_tree(&killed_child);
    let _ = killed_child.kill();
    let _status = killed_child.wait().expect("wait 应能回收");
    const STOP_TEST_TIMEOUT_MS: u128 = 3_000;
    let elapsed = started.elapsed().as_millis();
    assert!(
        elapsed < STOP_TEST_TIMEOUT_MS,
        "停止长进程耗时异常：{elapsed}ms"
    );
    // 二次 take 应 None（已取出）。
    assert!(
        table.take("long-plugin").is_none(),
        "已 take 的进程不应再可取"
    );
}

#[test]
fn process_table_take_nonexistent_returns_none() {
    let table = PluginProcessTable::new();
    assert!(table.take("ghost").is_none());
    assert!(!table.is_running("ghost").is_some());
}

/// 生成唯一临时目录名（避免并发测试冲突）。
fn temp_dir_unique(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "lf-runner-{prefix}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

// === delete_plugin_dir 测试 ===

/// 构造临时 PluginStore（anchor_root 在 temp_dir 下，隔离测试）。
fn temp_store_for_delete(name: &str) -> PluginStore {
    let root = std::env::temp_dir().join(format!(
        "lf-runner-delete-{name}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&root);
    PluginStore::new(&root).expect("PluginStore 构造应成功")
}

#[test]
fn delete_plugin_dir_removes_existing_directory() {
    let store = temp_store_for_delete("existing");
    let id = "my-plugin";
    let dir = store.ensure_plugin_dir(id).unwrap();
    std::fs::write(dir.join("manifest.json"), r#"{"id":"x","name":"x"}"#).unwrap();
    let table = PluginProcessTable::new();

    delete_plugin_dir(&store, &table, id).unwrap();

    assert!(!dir.exists(), "插件目录应被删除");
}

#[test]
fn delete_plugin_dir_nonexistent_is_idempotent() {
    let store = temp_store_for_delete("missing");
    let table = PluginProcessTable::new();
    // 不存在的 plugin_id 删除应幂等成功（不报错）。
    delete_plugin_dir(&store, &table, "never-existed").unwrap();
}

#[test]
fn delete_plugin_dir_rejects_traversal_id() {
    let store = temp_store_for_delete("traversal");
    let table = PluginProcessTable::new();
    // 穿越 plugin_id 被 sanitize_plugin_id 拒绝（防 ../ 越出 plugins_root）。
    let err = delete_plugin_dir(&store, &table, "../escape").unwrap_err();
    assert!(err.contains("plugin_id") || err.contains("非法") || err.contains("不合法"));
}

// === wait_for_crash 测试 ===

#[test]
fn wait_for_crash_detects_immediate_exit() {
    // 秒退进程：cmd /c exit 1（Windows）/ sh -c "exit 1"（Unix），立即退出。
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/c", "exit 1"]).stderr(Stdio::piped());
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", "exit 1"]).stderr(Stdio::piped());
        c
    };
    let mut child = cmd.spawn().expect("spawn 测试进程应成功");
    let result = wait_for_crash(&mut child, Duration::from_millis(500));
    assert!(result.is_some(), "秒退进程应被检测为崩溃");
    let err = result.unwrap();
    assert!(
        err.starts_with("plugin_crashed:"),
        "崩溃错误应含 plugin_crashed: 前缀"
    );
}

#[test]
fn wait_for_crash_returns_none_for_long_running() {
    let _guard = crate::code_assistant::process_tree_test_lock();
    // 存活进程：sleep 10（不会在 500ms 内退出）。
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/c", "ping -n 10 127.0.0.1 > nul"])
            .stderr(Stdio::piped());
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", "sleep 10"]).stderr(Stdio::piped());
        c
    };
    let mut child = cmd.spawn().expect("spawn 测试进程应成功");
    let result = wait_for_crash(&mut child, Duration::from_millis(300));
    assert!(result.is_none(), "存活进程不应判为崩溃");
    // 清理测试进程。
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn truncate_stderr_long_text_is_cut() {
    let long = "x".repeat(3000);
    let t = truncate_stderr(&long, 100);
    assert!(t.contains("已截断"), "超长 stderr 应截断并标注");
    assert!(t.chars().count() < long.chars().count());
}
