# Technical Design

## Boundaries

1. `collab-admin` owns administrator-facing reset-password state, overview cards, and roadmap navigation.
2. `desktop` React owns multi-plugin selection and schedule/workflow forms; Tauri owns process isolation and scheduler dispatch.
3. `packages/contract` remains the source of truth for local scheduler and workflow instance payloads.
4. Existing desktop Action runtime is the single invocation boundary. Scheduler dispatch calls it through an event/command adapter rather than duplicating capability or grant checks.
5. Cloud automation remains readable for compatibility, but creation and execution are rejected with an explicit deprecated error.

## Data Flow

```text
Schedule tick -> Tauri executor -> action invocation adapter -> installed plugin Action
                                      |-> output/error -> local run record

Workflow editor -> contract validation -> immutable workflow plugin release
Workflow run -> workflow-engine plan -> Action target resolver
             -> plugin Action OR nested workflow instance -> run result
```

## Compatibility

- Keep `/api/auth/reset-password` and existing token format unchanged.
- Add only additive fields/variants to shared contracts; snake_case is required.
- Existing local schedules remain readable. Cloud schedule rows are not migrated or deleted.
- Existing single-plugin UI calls should continue to use the current `runningPlugin` convenience field while an internal map tracks all running plugins.

## Risk Controls

- Never bypass Action permission and grant evaluation from scheduler or workflow code.
- Enforce per-plugin process keys and reject duplicate starts for the same id only.
- Bound workflow nesting, expanded nodes and parallelism using existing workflow-engine constants.
- Use explicit `DEPRECATED`/`cloud_disabled` errors instead of fake success.
