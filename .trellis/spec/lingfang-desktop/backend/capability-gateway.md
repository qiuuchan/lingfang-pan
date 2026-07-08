# Capability Gateway

## Validation Chain

Local capability execution has three steps:

1. the plugin declared the capability in its manifest
2. scope is valid for the capability, such as `fs.read` path prefixes
3. the real OS operation runs

Reference file:
- `apps/desktop/src-tauri/src/capability.rs`

Unsupported capabilities must return an explicit `CapError`; do not add stub implementations that return success.

## Current Capabilities

Implemented in the Rust gateway (`capability.rs`):

- `fs.read`: reads a file or lists a directory, restricted by manifest path prefixes
- `fs.write`: writes a file, restricted by manifest path prefixes (parent-directory scope check; 1 MiB cap)
- `system.info`: returns OS, architecture, hostname, CPU/memory, and uptime
- `clipboard`: read/write system clipboard text (`arboard`); `{op:'read'}` → `{content}`, `{op:'write', text}` → `{}`
- `system.screenshot`: captures the primary monitor and returns a PNG data URL (`xcap`). Privacy-sensitive — the TS runtime gates it behind `requestSystemPermission('screenshot')` before forwarding to the gateway.

Implemented elsewhere (not in the Rust gateway, listed for completeness):
- `net.fetch`: builtin plugins via the `plugin_net_fetch` Tauri command (`main.rs`), bypassing webview CORS
- `storage.kv`: client plugins via TS `localStorage` keyed `lf:plugin-storage:{pluginId}:{key}` (`plugins-runtime.ts`)
- `system.notify` / `system.requestPermission`: handled in TS `invokeRuntime` (`plugins-runtime.ts`)
- `ui.view` / `fs.pick` / `llm.chat` / `image.generate` / `plugin.*`: handled in TS `invokeRuntime` or the host bridge

Removed from the contract: `code-assistant.run` / `code-assistant.session` were vestiges of a deleted local AI CLI subsystem; AI capabilities route through the platform relay (`llm.chat`). They are no longer declarable.

### OpenAI-Compatible Bridge Routes (no new capability kind)

The host bridge (`plugin_llm_bridge.rs`) also serves OpenAI-compatible routes so third-party SDKs (openai-python, `@ai-sdk/openai`) can point `base_url` at `LINGFANG_PLUGIN_BRIDGE_URL` directly: `POST /v1/chat/completions` and `POST /v1/images/generations` pass the relay response through **unwrapped** (raw OpenAI shape), plus `GET /v1/models` for connectivity probing. These routes **reuse the existing `llm.chat` / `image.generate` capability gates** (`allow_llm_chat` / `allow_image_generate`) — no new `CapabilityKind` was added. The legacy SDK-shaped routes (`/llm/chat` → `{content}`, `/image/generate` → `{images}`) remain for `@lingfang/plugin-sdk`'s `invoke()`. Method dispatch is per-route: only `GET /v1/models` accepts GET; all others are POST-only.

## Path Scope

`expand_path()` supports `$HOME`. `fs_read()` must canonicalize the requested path and each allowed prefix before checking `requested.starts_with(prefix)` as `PathBuf`s. String prefix checks are forbidden because `Documents2` and `Documents/../Secrets` can bypass them.

If changing path authorization, keep explicit errors:
- missing path -> `Exec("缺少 path 参数")`
- undeclared capability -> `NotDeclared`
- out of scope -> `OutOfScope`

## Scenario: Canonical `fs.read` Scope

### 1. Scope / Trigger
- Trigger: changing local file capabilities, path expansion, or manifest scope interpretation.

### 2. Signatures
- `invoke(registry, plugin_id, "fs.read", args) -> Result<Value, CapError>`
- `args.path` is required and is expanded with `$HOME` before canonicalization.

### 3. Contracts
- Requested path must exist and canonicalize successfully.
- Allowed prefixes that do not canonicalize are ignored.
- A request is allowed only when canonical requested path starts with a canonical allowed prefix.

### 4. Validation & Error Matrix
- Missing `path` -> `Exec("缺少 path 参数")`
- Capability undeclared -> `NotDeclared`
- Existing path outside canonical scope -> `OutOfScope`
- Existing file inside scope -> file read result
- Existing directory inside scope -> directory listing result

### 5. Good/Base/Bad Cases
- Good: `$HOME/Documents/note.txt` allowed by `$HOME/Documents`.
- Base: allowed directory itself can be listed.
- Bad: `$HOME/Documents/../Secrets/key.txt` or `$HOME/Documents2/file.txt` must fail.

### 6. Tests Required
- Parent traversal sibling rejection.
- Same-prefix sibling directory rejection.
- Authorized child path success when adding broader coverage.

### 7. Wrong vs Correct
Wrong: `requested_string.starts_with(allowed_string)`.

Correct: `requested.canonicalize()?.starts_with(allowed.canonicalize()?)`.

## Scenario: `fs.write` Scope

`fs.write` reuses the path-prefix scope model but, because the write target may not yet exist, it canonicalizes and checks the target's **parent directory** against the allowed prefixes (not the target itself). Writes use the user-requested path verbatim once the parent is confirmed in scope.

- Missing `path` -> `Exec("缺少 path 参数")`
- Parent directory does not exist or is outside canonical scope -> `OutOfScope`
- `content.len()` over `MAX_FS_WRITE_BYTES` (1 MiB) -> `Exec`
- Authorized parent -> file written at requested path; returns `{ ok, bytes }`
