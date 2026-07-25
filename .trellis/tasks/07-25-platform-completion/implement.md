# Implementation Plan

1. Inspect and test existing auth, Action runtime, scheduler, workflow and process-table seams.
2. Implement administrator reset-token parsing and reset form, with component tests.
3. Add a desktop scheduler-to-Action adapter and replace the Rust `PLUGIN_ACTION` placeholder; add failure/timeout recording.
4. Make multi-plugin state explicit in the desktop shell while preserving current-plugin navigation.
5. Add workflow-instance plugin contract/adapter and wire workflow nodes to plugin Action targets; cover recursion and invocation tests.
6. Hide/deprecate Cloud schedule creation/execution paths without deleting compatibility models.
7. Add management/dashboard status and roadmap document.
8. Run contract, desktop, collab-admin, API and Rust checks; fix cross-layer drift.

## Validation Commands

- `pnpm -C packages/contract typecheck`
- `pnpm -C apps/desktop typecheck`
- `pnpm -C apps/desktop test`
- `pnpm -C apps/collab-admin typecheck`
- `pnpm -C apps/collab-api typecheck`
- `cargo test -p lingfang-desktop`
