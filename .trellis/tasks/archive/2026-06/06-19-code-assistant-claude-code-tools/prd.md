# 对标 Claude Code 扩展插件助手工具能力

## Goal

Upgrade the desktop plugin creator's built-in code assistant from a four-tool, workspace-only SDK loop into a local development assistant experience that can handle real user project migration requests such as "move O:\AI换衣 into this platform" without asking the user to manually copy files first.

The target product feel is close to Claude Code: the assistant should have a clear set of local tools, visible tool activity, explicit failures, and enough file/command capability to inspect, copy, adapt, and package an existing local project into a LingFang plugin.

## Requirements

- The assistant must be able to inspect user-provided local paths outside the current generated plugin workspace when the user asks it to migrate/import an existing project.
- The assistant must support more Claude-Code-like local tools than the current `scan_workspace`, `list_directory`, `read_file`, and `write_file`.
- MVP tool permissions must follow the recommended boundary:
  - read, list, search, and import/copy from user-provided absolute local paths;
  - write only inside the generated plugin workspace;
  - run commands only in the plugin workspace or a workspace subdirectory created by importing the source project;
  - expose command/tool failures directly instead of retrying with hidden fallbacks.
- Tool failures must surface clearly in transcript/tool output. Do not add mock success, silent fallback, or fake "copied" behavior.
- The implementation must respect the existing SDK Runtime architecture: Rust calls model APIs directly, executes local tools, persists transcripts, and streams `stdout` / `thought` / `tool` / `stderr` events to the frontend.
- The UI should make tool activity understandable to the user instead of presenting a plain text blob.
- The solution must preserve existing plugin generation behavior: generated plugin files still land in the session plugin workspace and are scanned into a draft.
- Existing user or in-progress changes in the working tree must not be reverted.

## Acceptance Criteria

- [ ] A user can ask the assistant to use an absolute local path such as `O:\AI换衣`, and the assistant can inspect/copy the requested project into the plugin workspace through real local tools.
- [ ] The assistant exposes a documented local tool set that covers at least project discovery, directory listing, file reading, text search, workspace file writing, source project import/copy, and controlled command execution.
- [ ] Tool calls and tool results are visible in the conversation UI as tool activity, and failed tool calls include explicit error text.
- [ ] Rust tests cover path handling, out-of-workspace access behavior, and copy/import safety for the new tools.
- [ ] Existing SDK Runtime tests still pass for Anthropic and OpenAI tool definition construction.
- [ ] Frontend tests cover transcript/tool projection changes if the rendered tool activity schema changes.

## Notes

- Confirmed code facts:
  - Current tool executor is `apps/desktop/src-tauri/src/code_assistant/engine/tools.rs`.
  - Current tool set is exactly `list_directory`, `read_file`, `write_file`, and `scan_workspace`.
  - Current path validation rejects absolute paths, `..`, empty path segments, and hidden segments, so `O:\AI换衣` cannot work today.
  - Both Anthropic and OpenAI-compatible request builders derive tool definitions from the same local tool definition list.
  - Frontend already has separate `tool` stream rendering plumbing, but the current tool text is only `name arguments`.
- Scope decision:
  - User selected the recommended MVP boundary: inspect/copy external paths, write generated files only inside the plugin workspace, and add controlled command execution.
