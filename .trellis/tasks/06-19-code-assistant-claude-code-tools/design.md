# 对标 Claude Code 扩展插件助手工具能力 Design

## Architecture

Extend `LocalToolExecutor` into a small local-tool runtime with two explicit path domains:

- **Plugin workspace domain**: generated plugin files. Existing `write_file` and `scan_workspace` stay scoped here. Relative paths remain required for writes.
- **External source domain**: user-mentioned local projects such as `O:\AI换衣`. New read/list/search/import tools accept absolute paths and canonicalize them before use. They never write back to the source path.

The model still talks to the existing SDK Runtime. Rust continues to build Anthropic/OpenAI tool definitions from one shared tool list, execute tool calls locally, append transcripts, and stream tool activity to the frontend.

## Tool Set

Keep existing tools:

- `list_directory`: list relative paths inside the plugin workspace.
- `read_file`: read relative UTF-8 files inside the plugin workspace.
- `write_file`: write relative UTF-8 files inside the plugin workspace.
- `scan_workspace`: scan small UTF-8 files inside the plugin workspace for draft conversion.

Add MVP tools:

- `list_local_directory(path)`: list an absolute local directory outside the workspace.
- `read_local_file(path, max_bytes?)`: read a UTF-8 absolute local file with an explicit byte limit.
- `search_local_files(path, query, include_globs?)`: recursively search UTF-8 text files under an absolute source directory.
- `import_local_project(source_path, destination?)`: copy a source directory or file into the plugin workspace. `destination` is a relative workspace path; default is workspace root. Skips heavy generated folders like `node_modules`, `.venv`, `__pycache__`, `dist`, and `build`, and reports skipped counts.
- `run_command(command, args?, cwd?)`: run a command in the plugin workspace by default, or a subdirectory inside that workspace. It returns exit code, stdout tail, and stderr tail. It does not pretend success on non-zero exit.

## Data Flow

1. Frontend sends prompt and `DEFAULT_CONVERSATION_SYSTEM_PROMPT`.
2. Rust builds model request body with updated tool definitions.
3. Model emits tool call deltas.
4. Runtime emits a `tool` stream event for the requested call, then executes the local tool.
5. Runtime appends tool result into the provider-specific continuation message.
6. Frontend aggregates `tool` stream events into tool cards and shows arguments. If the tool result schema is also streamed, the frontend shows success/error details in the same tool card.
7. `scan_workspace` still provides draft files from the plugin workspace after the turn exits.

## Contracts

- External tools require absolute existing paths. Relative paths are treated as workspace paths only by the original workspace tools.
- Writes remain workspace-relative. Absolute write paths and `..` remain rejected.
- Imported source files land inside the plugin workspace and then can be modified through `write_file`.
- Tool errors are returned as `{ ok: false, error }` from `LocalToolExecutor::execute` and must be preserved in transcript/tool result content.
- Command execution returns structured output on both success and failure; non-zero exit is a successful tool execution with `exitCode != 0`, not a fake success.
- Long reads and command outputs are truncated with explicit `truncated: true` metadata.

## UI Contract

Current frontend tool cards parse `"<name> <json>"` and show arguments. The implementation should preserve that compatibility and may extend tool stream text to include JSON lines:

- `{"phase":"call","name":"read_local_file","arguments":{...}}`
- `{"phase":"result","name":"read_local_file","ok":true,"result":{...}}`

If the JSON-line schema is added, update `tool-cards.ts`, `chat-output-model.ts`, and `AssistantChat.tsx` together so historical plain text tool events still render.

## Safety Boundary

- No arbitrary external write/delete tools in this MVP.
- No command execution in arbitrary external source directories in this MVP. Import first, then run commands inside the workspace copy.
- No silent command shell fallback. If a command cannot spawn, return the spawn error.
- No path prefix string checks. Canonicalize source paths and workspace parents before checking containment.
- Do not copy hidden/system directories unless they are ordinary files needed by the project; defaults skip hidden directories and generated dependency/build outputs.

## Compatibility

- Existing workspace-only plugin generation keeps working.
- Existing transcripts with plain tool stream text keep rendering.
- Existing request body tests must update expected tool names but retain the same shared tool-list behavior.

## Validation

- Rust unit tests for external absolute path acceptance, workspace write rejection, import copy behavior, generated-folder skips, and command cwd restrictions.
- Frontend tests if the tool stream schema changes.
- Full quality checks: `cargo test -p lingfang-desktop`, `pnpm -C apps/desktop test`, and `pnpm -C apps/desktop typecheck`.
