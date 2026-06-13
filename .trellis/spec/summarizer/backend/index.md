# summarizer 插件后端规范

## Scope

`plugins/summarizer` has no backend service, database, migrations, or logging layer. Its backend-facing behavior is expressed by manifest capabilities and host/server runtime support.

## Pre-Development Checklist

- Read [../frontend/example-plugin.md](../frontend/example-plugin.md).
- If capability behavior changes, inspect `.trellis/spec/plugin-sdk/frontend/sdk-runtime.md`, `.trellis/spec/lingfang-desktop/backend/capability-gateway.md`, and `.trellis/spec/server/backend/llm-generation-and-audit.md`.

## Backend Boundary

Do not add plugin-specific backend code under `plugins/summarizer`. Shared runtime services belong to:

- `apps/collab-api` for LLM proxy, audit, authorization, market/install flows
- `apps/desktop/src-tauri` for local file/system capabilities
- `packages/plugin-sdk` for the typed plugin client

## Quality Check

- No package-local backend check exists.
- If capability behavior changed, run affected host checks for `apps/collab-api` or `apps/desktop/src-tauri`.
