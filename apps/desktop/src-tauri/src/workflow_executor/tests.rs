use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use super::{
    ensure_python_venv, execute_installed_action_binding, InstalledActionBinding, RuntimeResolver,
};
use crate::plugin_runner::python_venv_dir;

#[derive(Deserialize)]
struct ConformanceFixture {
    cases: Vec<ConformanceCase>,
}

#[derive(Deserialize)]
struct ConformanceCase {
    id: String,
    input: Value,
    expected_output: Option<Value>,
    expected_error: Option<String>,
}

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "lingfang-action-conformance-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).expect("create conformance temp dir");
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fixture() -> ConformanceFixture {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../action-adapter-conformance/fixtures.json");
    serde_json::from_slice(&std::fs::read(path).expect("read shared action fixture"))
        .expect("parse shared action fixture")
}

fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|value| {
        std::env::split_paths(&value)
            .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
            .find(|candidate| candidate.is_file())
    })
}

fn runtime_binary(env_key: &str, names: &[&str], bundled: &str) -> PathBuf {
    std::env::var_os(env_key)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| {
            let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(bundled);
            candidate.is_file().then_some(candidate)
        })
        .or_else(|| find_on_path(names))
        .unwrap_or_else(|| panic!("missing real runtime for {env_key}"))
}

#[cfg(not(windows))]
fn test_resolver(root: &Path) -> RuntimeResolver {
    use std::os::unix::fs::symlink;

    let python = runtime_binary(
        "LINGFANG_ACTION_TEST_PYTHON",
        &["python3", "python"],
        "../runtimes/python/bin/python",
    );
    let node = runtime_binary(
        "LINGFANG_ACTION_TEST_NODE",
        &["node", "nodejs"],
        "../runtimes/nodejs/bin/node",
    );
    let python_dir = root.join("python");
    let node_dir = root.join("nodejs");
    std::fs::create_dir_all(python_dir.join("bin")).unwrap();
    std::fs::create_dir_all(node_dir.join("bin")).unwrap();
    symlink(python, python_dir.join("bin/python")).unwrap();
    symlink(node, node_dir.join("bin/node")).unwrap();
    RuntimeResolver::from_dirs(Some(python_dir), Some(node_dir))
}

#[cfg(windows)]
fn test_resolver(_root: &Path) -> RuntimeResolver {
    let python = runtime_binary(
        "LINGFANG_ACTION_TEST_PYTHON",
        &["python.exe"],
        "../runtimes/python/python.exe",
    );
    let node = runtime_binary(
        "LINGFANG_ACTION_TEST_NODE",
        &["node.exe"],
        "../runtimes/nodejs/node.exe",
    );
    RuntimeResolver::from_dirs(
        python.parent().map(Path::to_path_buf),
        node.parent().map(Path::to_path_buf),
    )
}

fn write_handlers(root: &Path) {
    std::fs::create_dir_all(root).unwrap();
    std::fs::write(
        root.join("action.mjs"),
        r#"export async function invoke(input) {
  console.log('node adapter log');
  if (input.mode === 'handler_error') throw new Error('fixture handler error');
  if (input.mode === 'timeout' || input.mode === 'cancel') await new Promise((resolve) => setTimeout(resolve, 60000));
  if (input.mode === 'bad_output') return 'not-an-object';
  const output = { ok: true, echoed: input.message };
  if (input.mode === 'artifact') output.artifact = input.artifact;
  return output;
}
"#,
    )
    .unwrap();
    std::fs::write(
        root.join("action.py"),
        r#"import asyncio

async def invoke(payload):
    print('python adapter log')
    if payload['mode'] == 'handler_error':
        raise RuntimeError('fixture handler error')
    if payload['mode'] in ('timeout', 'cancel'):
        await asyncio.sleep(60)
    if payload['mode'] == 'bad_output':
        return 'not-an-object'
    output = {'ok': True, 'echoed': payload['message']}
    if payload['mode'] == 'artifact':
        output['artifact'] = payload['artifact']
    return output
"#,
    )
    .unwrap();
}

fn align_test_venv_home(resolver: &RuntimeResolver, release: &Path) {
    let venv = python_venv_dir(release);
    let cfg = venv.join("pyvenv.cfg");
    let host_home = resolver
        .python()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .expect("test python home");
    let content = std::fs::read_to_string(&cfg).expect("read test pyvenv.cfg");
    let mut found = false;
    let mut lines = Vec::new();
    for line in content.lines() {
        if line.starts_with("home = ") {
            lines.push(format!("home = {}", host_home.display()));
            found = true;
        } else {
            lines.push(line.to_string());
        }
    }
    if !found {
        lines.push(format!("home = {}", host_home.display()));
    }
    std::fs::write(cfg, format!("{}\n", lines.join("\n"))).unwrap();
}

fn error_code(error: &str) -> &str {
    error.split(':').next().unwrap_or(error)
}

#[test]
fn node_and_python_execute_shared_conformance_fixture_in_real_processes() {
    let fixtures = fixture();
    let required: HashSet<&str> = [
        "good",
        "base",
        "artifact",
        "bad_output",
        "handler_error",
        "timeout",
        "cancel",
    ]
    .into_iter()
    .collect();
    assert!(required
        .iter()
        .all(|id| fixtures.cases.iter().any(|case| &case.id == id)));

    let temp = TestDir::new("matrix");
    let resolver = test_resolver(&temp.0.join("runtime"));
    let release = temp.0.join("release");
    write_handlers(&release);
    ensure_python_venv(&resolver, &release, None).expect("prepare real Python adapter venv");
    align_test_venv_home(&resolver, &release);

    for (runtime, entry) in [("nodejs", "action.mjs"), ("python", "action.py")] {
        for case in fixtures
            .cases
            .iter()
            .filter(|case| required.contains(case.id.as_str()))
        {
            let binding = InstalledActionBinding {
                runtime: runtime.to_string(),
                release_path: release.clone(),
                entry: entry.to_string(),
                callable: "invoke".to_string(),
                timeout_seconds: if case.id == "cancel" { 10 } else { 1 },
            };
            let scratch = temp.0.join(format!("scratch-{runtime}-{}", case.id));
            let cancel = Arc::new(AtomicBool::new(false));
            let cancel_thread = if case.id == "cancel" {
                let cancel = Arc::clone(&cancel);
                Some(std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(150));
                    cancel.store(true, Ordering::Release);
                }))
            } else {
                None
            };
            let result = execute_installed_action_binding(
                &resolver,
                &binding,
                &case.input,
                &scratch,
                None,
                (case.id == "cancel").then_some(cancel.as_ref()),
            );
            if let Some(thread) = cancel_thread {
                thread.join().unwrap();
            }
            match (&case.expected_output, &case.expected_error) {
                (Some(expected), None) => assert_eq!(
                    result.unwrap_or_else(|error| panic!("{runtime}/{}: {error}", case.id)),
                    *expected,
                    "{runtime}/{} output drift",
                    case.id
                ),
                (None, Some(expected)) => {
                    let error = result.expect_err(&format!("{runtime}/{} should fail", case.id));
                    assert_eq!(
                        error_code(&error),
                        expected,
                        "{runtime}/{} error drift",
                        case.id
                    );
                }
                _ => panic!("fixture case {} has invalid expectation", case.id),
            }
        }
    }
}

#[test]
fn cloud_and_workflow_bindings_are_exactly_unavailable_without_fallback() {
    let temp = TestDir::new("unavailable");
    let resolver = RuntimeResolver::from_dirs(None, None);
    for runtime in ["cloud", "workflow"] {
        let binding = InstalledActionBinding {
            runtime: runtime.to_string(),
            release_path: temp.0.clone(),
            entry: "must-not-run".to_string(),
            callable: "must_not_run".to_string(),
            timeout_seconds: 1,
        };
        assert_eq!(
            execute_installed_action_binding(
                &resolver,
                &binding,
                &serde_json::json!({}),
                &temp.0.join(format!("scratch-{runtime}")),
                None,
                None,
            ),
            Err("action_runtime_unavailable".to_string())
        );
    }
}
