use super::*;

fn manager() -> (PluginPackageManager, PathBuf) {
    let root = std::env::temp_dir().join(format!("lingfang-manager-{}", Uuid::new_v4()));
    let store = PluginStore::new(&root).unwrap();
    let manager = PluginPackageManager::new(&store).unwrap();
    (manager, root)
}

fn artifact(root: &Path, version: &str, content: &str) -> (PathBuf, InspectedArtifact) {
    runtime_artifact(root, "demo", version, "python", "main.py", content)
}

fn runtime_artifact(
    root: &Path,
    manifest_id: &str,
    version: &str,
    runtime: &str,
    entry: &str,
    content: &str,
) -> (PathBuf, InspectedArtifact) {
    let workspace = root.join(format!("source-{}", Uuid::new_v4()));
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join("manifest.json"), format!(r#"{{"id":"{manifest_id}","name":"Demo","version":"{version}","runtime_type":"{runtime}","entry":"{entry}"}}"#)).unwrap();
    let entry_path = workspace.join(entry);
    if let Some(parent) = entry_path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(entry_path, content).unwrap();
    let output = root.join(format!("{version}-{}.lfplugin", Uuid::new_v4()));
    let inspected = package_workspace(&workspace, &output).unwrap();
    (output, inspected)
}

fn node_artifact(root: &Path) -> (PathBuf, InspectedArtifact) {
    let workspace = root.join(format!("node-source-{}", Uuid::new_v4()));
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join("manifest.json"), r#"{"id":"node-demo","name":"Node Demo","version":"1.0.0","runtime_type":"nodejs","entry":"index.js"}"#).unwrap();
    fs::write(workspace.join("index.js"), "console.log('ok')").unwrap();
    fs::write(
        workspace.join("package.json"),
        r#"{"dependencies":{"left-pad":"1.3.0"}}"#,
    )
    .unwrap();
    let output = root.join("node-demo.lfplugin");
    let inspected = package_workspace(&workspace, &output).unwrap();
    (output, inspected)
}

#[test]
fn checksum_failure_leaves_ledger_unchanged() {
    let (manager, root) = manager();
    let (path, _) = artifact(&root, "1.0.0", "print('one')");
    let result = manager.install(InstallArtifactInput {
        artifact_path: path.to_string_lossy().to_string(),
        expected_sha256: Some("0".repeat(64)),
        package_id: Some("package-1".to_string()),
        release_id: Some("release-1".to_string()),
        origin: InstallationOrigin::Team,
        protected: false,
    });
    assert!(result.is_err());
    assert!(manager.list_installations().is_empty());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn unsafe_release_id_is_rejected_before_creating_installation_paths() {
    let (manager, root) = manager();
    let (path, artifact) = artifact(&root, "1.0.0", "print('one')");
    let result = manager.install(InstallArtifactInput {
        artifact_path: path.to_string_lossy().to_string(),
        expected_sha256: Some(artifact.sha256),
        package_id: Some("package-1".to_string()),
        release_id: Some("../../escape:release".to_string()),
        origin: InstallationOrigin::Local,
        protected: false,
    });
    assert!(result.is_err());
    assert!(manager.list_installations().is_empty());
    assert!(!root.join("escape:release").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn update_uses_pending_then_activation_and_rollback() {
    let (manager, root) = manager();
    let (first_path, first) = artifact(&root, "1.0.0", "print('one')");
    let installed = manager
        .install(InstallArtifactInput {
            artifact_path: first_path.to_string_lossy().to_string(),
            expected_sha256: Some(first.sha256),
            package_id: Some("package-1".to_string()),
            release_id: Some("release-1".to_string()),
            origin: InstallationOrigin::Team,
            protected: false,
        })
        .unwrap();
    let (second_path, second) = artifact(&root, "1.1.0", "print('two')");
    let pending = manager
        .install(InstallArtifactInput {
            artifact_path: second_path.to_string_lossy().to_string(),
            expected_sha256: Some(second.sha256),
            package_id: Some("package-1".to_string()),
            release_id: Some("release-2".to_string()),
            origin: InstallationOrigin::Team,
            protected: false,
        })
        .unwrap();
    assert_eq!(pending.active_release.version, "1.0.0");
    assert_eq!(pending.pending_release.as_ref().unwrap().version, "1.1.0");
    let activated = manager
        .activate_pending(&installed.installation_id)
        .unwrap();
    assert_eq!(activated.active_release.version, "1.1.0");
    let rolled_back = manager.rollback(&installed.installation_id).unwrap();
    assert_eq!(rolled_back.active_release.version, "1.0.0");
    assert!(Path::new(&rolled_back.data_path).exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn failed_pending_can_be_discarded_without_changing_active_release() {
    let (manager, root) = manager();
    let (first_path, first) = artifact(&root, "1.0.0", "print('one')");
    let installed = manager
        .install(InstallArtifactInput {
            artifact_path: first_path.to_string_lossy().to_string(),
            expected_sha256: Some(first.sha256),
            package_id: Some("package-1".to_string()),
            release_id: Some("release-1".to_string()),
            origin: InstallationOrigin::Team,
            protected: false,
        })
        .unwrap();
    let (second_path, second) = artifact(&root, "1.1.0", "print('two')");
    let pending = manager
        .install(InstallArtifactInput {
            artifact_path: second_path.to_string_lossy().to_string(),
            expected_sha256: Some(second.sha256),
            package_id: Some("package-1".to_string()),
            release_id: Some("release-2".to_string()),
            origin: InstallationOrigin::Team,
            protected: false,
        })
        .unwrap()
        .pending_release
        .unwrap();
    let pending_path = pending.path.clone();
    let restored = manager
        .discard_pending(&installed.installation_id, "dependency failure")
        .unwrap();
    assert_eq!(restored.active_release.release_id, "release-1");
    assert!(restored.pending_release.is_none());
    assert!(!Path::new(&pending_path).exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn protected_installation_cannot_be_uninstalled() {
    let (manager, root) = manager();
    let (path, artifact) = artifact(&root, "1.0.0", "print('one')");
    let installed = manager
        .install(InstallArtifactInput {
            artifact_path: path.to_string_lossy().to_string(),
            expected_sha256: Some(artifact.sha256),
            package_id: Some("builtin.demo".to_string()),
            release_id: Some("builtin-release".to_string()),
            origin: InstallationOrigin::Builtin,
            protected: true,
        })
        .unwrap();
    assert!(manager.uninstall(&installed.installation_id).is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn installed_release_can_be_copied_to_workspace_then_uninstalled_with_data() {
    let (manager, root) = manager();
    let (path, artifact) = artifact(&root, "1.0.0", "print('one')");
    let installed = manager
        .install(InstallArtifactInput {
            artifact_path: path.to_string_lossy().to_string(),
            expected_sha256: Some(artifact.sha256),
            package_id: None,
            release_id: None,
            origin: InstallationOrigin::Local,
            protected: false,
        })
        .unwrap();
    fs::write(
        Path::new(&installed.data_path).join("state.json"),
        "kept out of draft",
    )
    .unwrap();
    let workspace = manager
        .copy_installation_to_workspace(&installed.installation_id)
        .unwrap();
    assert_eq!(
        workspace.source_kind,
        PluginReleaseSourceKind::CopiedInstallation
    );
    assert_eq!(workspace.source_label, "已安装插件副本");
    assert!(Path::new(&workspace.path).join("main.py").is_file());
    assert!(!Path::new(&workspace.path).join("data").exists());

    let installation_root = manager.installed_root().join(&installed.installation_id);
    manager.uninstall(&installed.installation_id).unwrap();
    assert!(manager.list_installations().is_empty());
    assert!(!installation_root.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn node_dependencies_live_outside_the_immutable_release_directory() {
    let (manager, root) = manager();
    let (path, artifact) = node_artifact(&root);
    let installed = manager
        .install(InstallArtifactInput {
            artifact_path: path.to_string_lossy().to_string(),
            expected_sha256: Some(artifact.sha256),
            package_id: Some("package-node".to_string()),
            release_id: Some("release-node".to_string()),
            origin: InstallationOrigin::Local,
            protected: false,
        })
        .unwrap();
    let package = Path::new(&installed.active_release.path);
    let linked = package.join("node_modules");
    let environment = linked.canonicalize().unwrap();
    assert!(!environment.starts_with(package.canonicalize().unwrap()));
    assert!(environment.ends_with(Path::new("environments/release-node/node_modules")));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn bundled_builtins_register_through_the_verified_installer() {
    let (manager, root) = manager();
    let index =
        crate::builtin_plugin_index::parse_builtin_index(crate::builtin_plugin_bundle::INDEX_JSON)
            .unwrap();

    let registered = manager
        .register_builtins(
            crate::builtin_plugin_bundle::INDEX_JSON,
            crate::builtin_plugin_bundle::ARTIFACTS,
        )
        .unwrap();
    assert_eq!(registered, index.artifacts.len());
    let installations = manager.list_installations();
    assert_eq!(installations.len(), index.artifacts.len());
    for installation in &installations {
        assert_eq!(installation.origin, InstallationOrigin::Builtin);
        assert!(installation.protected);
        let indexed = index
            .artifacts
            .iter()
            .find(|artifact| artifact.package_id == installation.package_id)
            .unwrap();
        assert_eq!(installation.active_release.release_id, indexed.release_id);
        assert_eq!(installation.active_release.sha256, indexed.sha256);
        assert!(Path::new(&installation.active_release.path).is_dir());
    }

    assert_eq!(
        manager
            .register_builtins(
                crate::builtin_plugin_bundle::INDEX_JSON,
                crate::builtin_plugin_bundle::ARTIFACTS,
            )
            .unwrap(),
        0
    );
    assert_eq!(manager.list_installations().len(), installations.len());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn installed_hydration_stays_active_until_client_pending_is_explicitly_activated() {
    let (manager, root) = manager();
    let (first_path, first) = runtime_artifact(
        &root,
        "client-demo",
        "1.0.0",
        "client",
        "index.html",
        "<p>one</p>",
    );
    let installed = manager
        .install(InstallArtifactInput {
            artifact_path: first_path.to_string_lossy().to_string(),
            expected_sha256: Some(first.sha256),
            package_id: Some("client-package".to_string()),
            release_id: Some("client-release-1".to_string()),
            origin: InstallationOrigin::Local,
            protected: false,
        })
        .unwrap();
    let (second_path, second) = runtime_artifact(
        &root,
        "client-demo",
        "1.1.0",
        "client",
        "index.html",
        "<p>two</p>",
    );
    manager
        .install(InstallArtifactInput {
            artifact_path: second_path.to_string_lossy().to_string(),
            expected_sha256: Some(second.sha256),
            package_id: Some("client-package".to_string()),
            release_id: Some("client-release-2".to_string()),
            origin: InstallationOrigin::Local,
            protected: false,
        })
        .unwrap();

    let active = manager
        .load_installed_plugin(&installed.installation_id)
        .unwrap();
    assert_eq!(active.manifest["version"], "1.0.0");
    assert_eq!(active.entry_content, "<p>one</p>");
    assert!(active.installation.pending_release.is_some());

    let preview = manager
        .preview_pending_plugin(&installed.installation_id)
        .unwrap();
    assert_eq!(preview.manifest["version"], "1.1.0");
    assert_eq!(preview.entry_content, "<p>two</p>");
    assert_eq!(
        manager
            .installation(&installed.installation_id)
            .unwrap()
            .active_release
            .version,
        "1.0.0"
    );

    let activated = manager
        .activate_pending_client_plugin(&installed.installation_id)
        .unwrap();
    assert_eq!(activated.active_release.version, "1.1.0");
    assert_eq!(
        activated.active_release.dependency_status,
        DependencyStatus::Ready
    );
    assert!(activated.pending_release.is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn script_pending_preview_does_not_activate_without_successful_process_start() {
    let (manager, root) = manager();
    let (first_path, first) = artifact(&root, "1.0.0", "print('one')");
    let installed = manager
        .install(InstallArtifactInput {
            artifact_path: first_path.to_string_lossy().to_string(),
            expected_sha256: Some(first.sha256),
            package_id: Some("script-package".to_string()),
            release_id: Some("script-release-1".to_string()),
            origin: InstallationOrigin::Local,
            protected: false,
        })
        .unwrap();
    let (second_path, second) = artifact(&root, "1.1.0", "print('two')");
    manager
        .install(InstallArtifactInput {
            artifact_path: second_path.to_string_lossy().to_string(),
            expected_sha256: Some(second.sha256),
            package_id: Some("script-package".to_string()),
            release_id: Some("script-release-2".to_string()),
            origin: InstallationOrigin::Local,
            protected: false,
        })
        .unwrap();

    let preview = manager
        .preview_pending_plugin(&installed.installation_id)
        .unwrap();
    assert_eq!(preview.manifest["version"], "1.1.0");
    assert!(manager
        .activate_pending_client_plugin(&installed.installation_id)
        .is_err());
    let unchanged = manager.installation(&installed.installation_id).unwrap();
    assert_eq!(unchanged.active_release.version, "1.0.0");
    assert_eq!(unchanged.pending_release.unwrap().version, "1.1.0");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn draft_migration_rolls_back_directory_and_manifest_when_ledger_write_fails() {
    let (manager, root) = manager();
    let legacy = manager.plugins_root.join("legacy-draft");
    fs::create_dir_all(&legacy).unwrap();
    fs::write(
        legacy.join("manifest.json"),
        r#"{"id":"draft-demo","name":"Draft","version":"0.1.0","runtime_type":"client","entry":"index.html","draft":true}"#,
    )
    .unwrap();
    fs::write(legacy.join("index.html"), "<p>draft</p>").unwrap();
    fs::remove_file(manager.workspaces_path()).unwrap();
    fs::create_dir(manager.workspaces_path()).unwrap();

    assert!(manager
        .migrate_one_legacy_directory("legacy-draft", &legacy)
        .is_err());
    assert!(legacy.is_dir());
    let manifest: Value = read_json(&legacy.join("manifest.json")).unwrap();
    assert_eq!(manifest.get("draft").and_then(Value::as_bool), Some(true));
    assert_eq!(fs::read_dir(manager.workspaces_root()).unwrap().count(), 0);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn legacy_install_migration_stages_source_and_preserves_data() {
    let (manager, root) = manager();
    let legacy = manager.plugins_root.join("legacy-plugin");
    fs::create_dir_all(legacy.join("data")).unwrap();
    fs::write(
        legacy.join("manifest.json"),
        r#"{"id":"legacy-demo","name":"Legacy","version":"1.0.0","runtime_type":"python","entry":"main.py"}"#,
    )
    .unwrap();
    fs::write(legacy.join("main.py"), "print('legacy')").unwrap();
    fs::write(legacy.join("data/state.json"), "preserved").unwrap();

    manager
        .migrate_one_legacy_directory("legacy-plugin", &legacy)
        .unwrap();
    assert!(!legacy.exists());
    let installations = manager.list_installations();
    assert_eq!(installations.len(), 1);
    assert_eq!(installations[0].origin, InstallationOrigin::Local);
    assert_eq!(
        fs::read_to_string(Path::new(&installations[0].data_path).join("state.json")).unwrap(),
        "preserved"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn imported_workspace_is_publishable_the_first_time() {
    let (manager, root) = manager();
    let (artifact_path, _) = artifact(&root, "1.0.0", "print('imported')");
    let workspace = manager.import_workspace(&artifact_path).unwrap();
    assert!(workspace.content_sha256.is_none());
    assert_eq!(
        workspace.source_kind,
        PluginReleaseSourceKind::LocalArtifact
    );
    assert_eq!(workspace.source_label, "本地 .lfplugin 制品");

    let packed = manager
        .pack_workspace(&workspace.workspace_id, None)
        .unwrap();
    assert!(manager
        .ensure_workspace_publishable(&workspace.workspace_id, "1.0.0", &packed.artifact.sha256,)
        .is_ok());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn workspace_provenance_defaults_old_ledgers_and_tracks_creator_updates() {
    let (manager, root) = manager();
    let workspace = manager
        .create_workspace(CreateWorkspaceInput {
            title: "Creator Draft".to_string(),
            manifest_id: "creator-draft".to_string(),
            version: "0.1.0".to_string(),
            runtime: "client".to_string(),
            conversation_id: Some("conversation-1".to_string()),
            source_kind: None,
            source_label: None,
        })
        .unwrap();
    assert_eq!(
        workspace.source_kind,
        PluginReleaseSourceKind::LingfangCreator
    );
    assert_eq!(workspace.source_label, "灵枋创建器");
    assert_eq!(
        serde_json::to_value(&workspace).unwrap()["sourceKind"],
        "LINGFANG_CREATOR"
    );

    let synced = manager
        .sync_workspace_metadata(
            &workspace.workspace_id,
            None,
            Some(PluginReleaseSourceKind::ExternalTool),
            Some("/Users/private/external-plugin".to_string()),
        )
        .unwrap();
    assert_eq!(synced.source_kind, PluginReleaseSourceKind::ExternalTool);
    assert_eq!(synced.source_label, "外部开发工具");

    let mut ledger: Value = read_json(&manager.workspaces_path()).unwrap();
    let item = ledger["workspaces"][0].as_object_mut().unwrap();
    item.remove("sourceKind");
    item.remove("sourceLabel");
    write_json(&manager.workspaces_path(), &ledger).unwrap();
    let restored = manager.list_workspaces().pop().unwrap();
    assert_eq!(restored.source_kind, PluginReleaseSourceKind::Unknown);
    assert!(restored.source_label.is_empty());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn tagged_workspace_reader_roundtrips_utf8_and_binary_bytes() {
    let (manager, root) = manager();
    let workspace = manager
        .create_workspace(CreateWorkspaceInput {
            title: "Binary Draft".to_string(),
            manifest_id: "binary-draft".to_string(),
            version: "0.1.0".to_string(),
            runtime: "client".to_string(),
            conversation_id: None,
            source_kind: Some(PluginReleaseSourceKind::ExternalTool),
            source_label: Some("Cursor workspace".to_string()),
        })
        .unwrap();
    let binary = [0_u8, 159, 146, 150, 255, 10];
    fs::write(Path::new(&workspace.path).join("notes.txt"), "中文 text").unwrap();
    fs::write(Path::new(&workspace.path).join("icon.png"), binary).unwrap();

    let files = manager
        .read_workspace_files(&workspace.workspace_id)
        .unwrap();
    let text = files.iter().find(|file| file.path == "notes.txt").unwrap();
    assert!(!text.binary);
    assert_eq!(text.content, "中文 text");
    let image = files.iter().find(|file| file.path == "icon.png").unwrap();
    assert!(image.binary);
    assert_eq!(
        general_purpose::STANDARD.decode(&image.content).unwrap(),
        binary
    );
    assert!(files.iter().all(|file| file.path != "_meta.json"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn environment_cleanup_errors_are_returned() {
    let root = std::env::temp_dir().join(format!("lingfang-env-cleanup-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let not_a_directory = root.join("environment");
    fs::write(&not_a_directory, "occupied").unwrap();
    assert!(remove_environment_directory(&not_a_directory).is_err());
    let _ = fs::remove_dir_all(root);
}
