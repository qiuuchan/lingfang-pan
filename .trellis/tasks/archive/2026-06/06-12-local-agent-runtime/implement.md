# 本地代码助手运行时实施计划

## Steps

1. Read specs:
   - `.trellis/spec/lingfang-desktop/backend/index.md`
   - `.trellis/spec/lingfang-desktop/backend/capability-gateway.md`
   - `.trellis/spec/lingfang-desktop/backend/quality.md`

2. Dependencies
   - Add process/PTY/storage dependencies to `apps/desktop/src-tauri/Cargo.toml`.
   - Prefer direct process invocation; only add PTY if required by real CLI behavior.

3. Module scaffolding
   - Add `code_assistant.rs`.
   - Add adapter/store/registry submodules if module size requires.
   - Register state and commands in `main.rs`.

4. Tool detection
   - Implement binary lookup.
   - Implement version checks.
   - Implement model defaults.

5. Real probe
   - Implement minimal prompt probe for Claude Code.
   - Implement minimal prompt probe for Codex.
   - Implement minimal prompt probe for OpenCode.
   - Capture stdout/stderr/exit/elapsed.

6. Sessions
   - Start session.
   - Stream output events.
   - Stop session.
   - Persist transcript.
   - List/read transcripts.

7. Cleanup
   - Register running process.
   - Cleanup on startup and stop.
   - Test stale registry behavior.

8. Tests
   - Unit-test command arg construction.
   - Unit-test registry serialization.
   - Unit-test path/config handling.
   - Real CLI tests are in `real-cli-verification`, not unit tests.

## Validation Commands

```bash
cargo test -p lingfang-desktop
```

## Manual Checks

- Detect all three tools.
- Run real probe for each installed tool.
- Stop sessions cleanly.
- Inspect transcript files.

## Risky Files

- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/src-tauri/src/capability.rs`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/src/code_assistant.rs`

## Done When

- Commands/events exist.
- Real probes can be triggered.
- Transcripts persist.
- Process registry cleanup works.
- Rust tests pass.
