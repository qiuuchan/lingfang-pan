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

Implemented today:

- `fs.read`: reads a file or lists a directory, restricted by manifest path prefixes
- `system.info`: returns OS, architecture, hostname, CPU/memory, and uptime

Known but not implemented locally: `fs.write`, `net.fetch`, `clipboard`, `storage.kv`, screenshots, notifications. These should fail unless a real implementation and manifest scope validation are added.

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
