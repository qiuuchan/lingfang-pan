use super::*;

#[test]
fn real_codex_session_lifecycle_when_enabled() {
    if std::env::var("LINGFANG_REAL_CODEX_SESSION_TEST")
        .ok()
        .as_deref()
        != Some("1")
    {
        return;
    }

    let root = std::env::temp_dir().join(format!(
        "lingfang-real-codex-session-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let state = CodeAssistantState {
        store: AssistantStore::new(root).expect("assistant store should initialize"),
        processes: Arc::new(Mutex::new(HashMap::new())),
        configs_root: std::env::temp_dir().join(format!(
            "lingfang-real-codex-configs-{}",
            std::process::id()
        )),
    };
    let record = start_session(
        NoopEventSink,
        state.clone(),
        StartSessionInput {
            tool: CodeAssistantTool::Codex,
            model: None,
            workspace_dir: Some(env!("CARGO_MANIFEST_DIR").into()),
            prompt: "Reply with exactly: lingfang-long-session-ok".into(),
            system_prompt: None,
            effort: None,
            plugin_id: None,
            cli_config: None,
        },
        // session_id 由调用方提前生成（与生产路径 main.rs 一致）。
        new_session_id(CodeAssistantTool::Codex),
        // 真实 codex 测试走降级（不注入平台 key），验证 CLI 默认配置路径仍可跑（lingfang-long-session-ok）。
        Vec::new(),
    )
    .expect("codex session should start");

    let deadline = Instant::now() + std::time::Duration::from_secs(180);
    while Instant::now() < deadline {
        if let Some(done) = list_sessions(&state)
            .into_iter()
            .find(|item| item.session_id == record.session_id && item.status != "running")
        {
            let transcript = read_transcript(
                &state,
                ReadTranscriptInput {
                    session_id: record.session_id.clone(),
                },
            )
            .expect("transcript should exist");
            println!(
                "lingfang-real-codex-session evidence session_id={} status={} exit_code={:?} transcript_path={} command={} registry_remaining={}",
                record.session_id,
                done.status,
                done.exit_code,
                done.transcript_path,
                done.command_preview.join(" "),
                state.store.list_registered_processes().len()
            );
            assert_eq!(done.exit_code, Some(0));
            assert!(transcript.contains("lingfang-long-session-ok"));
            assert!(state.store.list_registered_processes().is_empty());
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    let _ = stop_session(
        NoopEventSink,
        &state,
        StopSessionInput {
            session_id: record.session_id.clone(),
        },
    );
    panic!(
        "codex session did not finish before timeout: {}",
        record.session_id
    );
}

#[test]
fn real_codex_session_stop_when_enabled() {
    if std::env::var("LINGFANG_REAL_CODEX_STOP_TEST")
        .ok()
        .as_deref()
        != Some("1")
    {
        return;
    }

    let root =
        std::env::temp_dir().join(format!("lingfang-real-codex-stop-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let state = CodeAssistantState {
        store: AssistantStore::new(root).expect("assistant store should initialize"),
        processes: Arc::new(Mutex::new(HashMap::new())),
        configs_root: std::env::temp_dir().join(format!(
            "lingfang-real-codex-stop-configs-{}",
            std::process::id()
        )),
    };
    let record = start_session(
        NoopEventSink,
        state.clone(),
        StartSessionInput {
            tool: CodeAssistantTool::Codex,
            model: None,
            workspace_dir: Some(env!("CARGO_MANIFEST_DIR").into()),
            prompt: "Write a detailed LingFang plugin design with at least 20 sections. Do not be brief.".into(),
            system_prompt: None,
            effort: None,
            plugin_id: None,
            cli_config: None,
        },
        new_session_id(CodeAssistantTool::Codex),
        Vec::new(),
    )
    .expect("codex session should start");
    assert_eq!(state.store.list_registered_processes().len(), 1);
    std::thread::sleep(std::time::Duration::from_secs(3));

    stop_session(
        NoopEventSink,
        &state,
        StopSessionInput {
            session_id: record.session_id.clone(),
        },
    )
    .expect("codex session should stop");

    let session = list_sessions(&state)
        .into_iter()
        .find(|item| item.session_id == record.session_id)
        .expect("session should be stored");
    let transcript = read_transcript(
        &state,
        ReadTranscriptInput {
            session_id: record.session_id.clone(),
        },
    )
    .expect("transcript should exist");
    println!(
        "lingfang-real-codex-stop evidence session_id={} status={} exit_code={:?} transcript_path={} command={} registry_remaining={}",
        record.session_id,
        session.status,
        session.exit_code,
        session.transcript_path,
        session.command_preview.join(" "),
        state.store.list_registered_processes().len()
    );
    assert_eq!(session.status, "stopped");
    assert!(transcript.contains("stopped"));
    assert!(state.store.list_registered_processes().is_empty());
}
