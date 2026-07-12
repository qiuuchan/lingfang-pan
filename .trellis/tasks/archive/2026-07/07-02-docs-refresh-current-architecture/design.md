# Refresh project docs to match current architecture - Design

## Architecture

This task is a documentation taxonomy and synchronization pass for `README.md` and `docs/`, driven directly by the current codebase.

The repo currently contains three documentation buckets:

1. Current-state authority docs that should describe the live implementation.
   - `README.md`
   - `docs/01-vision-and-architecture.md`
   - `docs/02-domain-and-plugins.md`
   - `docs/04-engineering.md`
   - `docs/collab-api.md`
   - `docs/collab-platform.md`
   - operational docs that still match current behavior, such as `docs/collab-desktop-client.md`, `docs/collab-admin-guide.md`, `docs/collab-deployment.md`

2. Root-level historical/design docs that can still mislead readers if left unmarked.
   - `docs/03-backend-and-llm.md`
   - `docs/billing-and-relay-design.md`

3. Explicitly historical records that can remain as-is.
   - `docs/adr/*.md`
   - `docs/plugin-workbench-real-cli-test.md`
   - `docs/self-review-v4-ui.md`

The implementation strategy is:

- Rewrite bucket 1 docs so they describe the current product and architecture without depending on removed modules or migration-era terminology.
- For bucket 2, avoid full historical rewrites unless the file is already serving as a current authority doc. Prefer a prominent status note plus links to the live authority docs.
- Leave bucket 3 untouched unless a cross-link is needed from bucket 1.

## Source Of Truth

Each document update must be grounded in code rather than prior docs:

1. Desktop AI creation flow
   - `apps/desktop/src/components/creator/FloatingCreator.tsx`
   - `apps/desktop/src/lib/agent/*`
   - `apps/desktop/src/lib/plugin-creator/creator-tools.ts`

2. Desktop host, runtime, and local execution
   - `apps/desktop/src-tauri/src/main.rs`
   - `apps/desktop/src-tauri/src/plugin_runner.rs`
   - `apps/desktop/src-tauri/src/plugin_script.rs`
   - `apps/desktop/src-tauri/src/capability.rs`
   - `apps/desktop/src-tauri/src/process_util/mod.rs`

3. Backend, pricing, and relay
   - `apps/collab-api/src/modules/relay/*`
   - `apps/collab-api/src/modules/billing.controller.ts`
   - `apps/collab-api/src/modules/user-billing.controller.ts`
   - `apps/collab-api/src/modules/credit.service.ts`
   - `apps/collab-api/src/modules/pricing.service.ts`
   - `apps/collab-api/prisma/schema.prisma`

4. Repo topology and deployment
   - top-level `package.json`
   - package directories under `apps/` and `packages/`
   - `apps/collab-api/.env.example`

## Boundaries

- No code or behavior changes.
- No attempt to preserve outdated claims just because they existed in prior docs.
- No unsupported resume-style metrics or performance claims.
- No broad rewrite of ADRs or Trellis internals.
- No parent/child task split: the deliverable is a single documentation set whose acceptance depends on consistent classification across files.

## Compatibility And Migration Notes

- Historical terms such as `code_assistant`, `LlmGatewayBinding`, `TenantLlmBinding`, `PluginDraft`, Rust `axum` backend, and BYOK must not remain in current-state docs as active architecture.
- Where those terms remain in historical documents, they should be framed as superseded background and linked forward to the current authority docs.
- `docs/collab-platform.md` should stop presenting the repo as being mid-migration from a separate Rust server if that server no longer exists in the tree.
- `docs/collab-api.md` should reflect the current controller surface and remove endpoints already deleted from code.

## Validation Plan

- Search current-state docs for removed architecture markers after editing.
- Manually review that root historical docs have an obvious status note when needed.
- Check that README and the primary architecture docs align on the same stack and generation flow.

## Tradeoffs

- Rewriting all historical docs would create unnecessary churn and risks destroying decision history; targeted status notes are cheaper and safer.
- Treating a few root-level history docs as “annotate, not rewrite” keeps the current authority set concise.
- This remains one task because splitting current-vs-historical classification into child tasks would duplicate the same evidence gathering and review gate.
