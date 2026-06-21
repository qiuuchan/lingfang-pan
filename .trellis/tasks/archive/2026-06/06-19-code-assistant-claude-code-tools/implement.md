# 对标 Claude Code 扩展插件助手工具能力 Implementation Plan

**Goal:** let the plugin creator assistant inspect/import user local projects like `O:\AI换衣` while keeping generated writes inside the plugin workspace.

**Architecture:** extend the Rust SDK Runtime local tool executor with explicit workspace and external-source path domains, then update provider tool definitions, prompt guidance, UI tool projection only if the stream schema changes, and tests.

**Tech Stack:** Rust/Tauri 2 (`apps/desktop/src-tauri`), React/TypeScript/Vitest (`apps/desktop/src`), Trellis specs.

---

## Task 1: Backend Tool Boundary Tests

**Files:**
- Modify: `apps/desktop/src-tauri/src/code_assistant/engine/tools.rs`

**Steps:**
1. Add failing Rust tests for:
   - `list_local_directory` accepts an absolute temp directory.
   - `read_local_file` accepts an absolute UTF-8 temp file.
   - `write_file` still rejects absolute paths.
   - `import_local_project` copies a source directory into workspace root.
   - `import_local_project` skips `node_modules` and `.venv`.
   - `run_command` rejects `cwd` outside workspace/imported source roots.
2. Run targeted tests:
   - `cargo test -p lingfang-desktop code_assistant::engine::tools -- --nocapture`
   - Expected: new tests fail because tools are missing.

## Task 2: Path Helpers And External Read Tools

**Files:**
- Modify: `apps/desktop/src-tauri/src/code_assistant/engine/tools.rs`

**Steps:**
1. Add helper functions for absolute local path validation and canonicalization.
2. Implement `list_local_directory`, `read_local_file`, and `search_local_files`.
3. Keep functions under project limits by extracting helpers for directory entry projection, text read with limit, and recursive search.
4. Run:
   - `cargo test -p lingfang-desktop code_assistant::engine::tools -- --nocapture`
   - Expected: external read/list/search tests pass; import/command tests still fail.

## Task 3: Import/Copy Tool

**Files:**
- Modify: `apps/desktop/src-tauri/src/code_assistant/engine/tools.rs`

**Steps:**
1. Implement `import_local_project(source_path, destination?)`.
2. Resolve `destination` with existing workspace write-path semantics.
3. Recursively copy regular files and directories.
4. Skip generated or high-risk folders by name: `node_modules`, `.venv`, `__pycache__`, `dist`, `build`, `.git`.
5. Return structured counts: copied files, copied bytes, skipped entries, destination path.
6. Run targeted Rust tests until copy behavior passes.

## Task 4: Controlled Command Tool

**Files:**
- Modify: `apps/desktop/src-tauri/src/code_assistant/engine/tools.rs`

**Steps:**
1. Implement workspace-scoped `run_command(command, args?, cwd?)`.
2. Implement `run_command(command, args?, cwd?)` using `std::process::Command`.
3. Allow cwd only inside workspace or a workspace subdirectory.
4. Return exit code plus truncated stdout/stderr with explicit truncation metadata.
5. Do not treat non-zero exit as a tool executor error; preserve the real exit code.
6. Run targeted Rust tests.

## Task 5: Tool Definitions And Prompt Guidance

**Files:**
- Modify: `apps/desktop/src-tauri/src/code_assistant/engine/tools.rs`
- Modify: `apps/desktop/src-tauri/src/code_assistant/engine/anthropic.rs`
- Modify: `apps/desktop/src-tauri/src/code_assistant/engine/openai.rs`
- Modify: `apps/desktop/src/lib/plugin-creator-protocol.ts`

**Steps:**
1. Add Anthropic and OpenAI definitions for all new tools.
2. Update request body tests to assert representative new tools exist after existing ones.
3. Update `DEFAULT_CONVERSATION_SYSTEM_PROMPT` with concise guidance:
   - use local tools for user-provided absolute paths;
   - import/copy source projects before editing;
   - write generated plugin files only through workspace-relative `write_file`.
4. Run:
   - `cargo test -p lingfang-desktop code_assistant::engine -- --nocapture`
   - Expected: provider body and tool tests pass.

## Task 6: Tool Result UI Projection If Needed

**Files:**
- Modify if schema changes: `apps/desktop/src/lib/plugin-draft/tool-cards.ts`
- Modify if schema changes: `apps/desktop/src/components/chat/chat-output-model.ts`
- Modify if schema changes: `apps/desktop/src/components/chat/AssistantChat.tsx`
- Test: `apps/desktop/src/components/chat/chat-output-model.spec.ts`

**Steps:**
1. If runtime continues streaming only call arguments, leave UI code unchanged.
2. If runtime streams call/result JSON lines, add a parser that handles both legacy `"Name {json}"` and JSON-line events.
3. Add Vitest coverage for a successful tool result and failed tool result rendering.
4. Run:
   - `pnpm -C apps/desktop test -- chat-output-model.spec.ts`

## Task 7: Specs And Full Verification

**Files:**
- Modify: `.trellis/spec/lingfang-desktop/backend/sdk-runtime-engine.md`
- Optional modify: `.trellis/spec/lingfang-desktop/backend/capability-gateway.md`

**Steps:**
1. Document the new SDK Runtime local tool boundary.
2. Run verification:
   - `cargo test -p lingfang-desktop`
   - `pnpm -C apps/desktop test`
   - `pnpm -C apps/desktop typecheck`
3. Fix only failures caused by this task.

## Risk Notes

- Existing working tree has unrelated or prior uncommitted changes in `code_assistant` and plugin creator files. Inspect diffs before editing shared files and do not revert them.
- `tools.rs` already exceeds the global 300-line preference; if implementation grows large, split path/copy/command helpers into focused modules under `engine/tools/`.
