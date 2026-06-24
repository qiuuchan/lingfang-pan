# Desktop Backend and UI Fixes Implementation Plan

## Checklist

1. Backend billing contracts
   - Add/update DTOs for partial pool updates.
   - Add ID-targeted pricing update route/service support.
   - Include team metadata in pool/channel pool references.
   - Include role display metadata in team member responses.
   - Expose resource pool names in relay model metadata where feasible.

2. Admin billing and model access UI
   - Fix pricing edit to call `PATCH /pricing/:id` for existing rows.
   - Replace enabled indicator with readable status styling.
   - Show dedicated resource pool team names and keep team selection usable.
   - Rename channel-management wording to model-access wording in visible UI.
   - Widen model access dialog and add tabs for access and pricing setup.
   - Ensure test-channel/model test status uses actual backend success state.

3. Desktop configuration and settings UI
   - Remove hardcoded packaged platform address or make it configurable.
   - Restore persisted backend URL initialization/save/clear behavior.
   - Update settings update/backend tab copy and controls accordingly.
   - Localize close-window selected value display.

4. Desktop team/profile/UI polish
   - Shrink profile panel spacing/height.
   - Move team profile/basic info into overview and remove duplicate placement.
   - Ensure member role display uses readable names.
   - Add click animation to floating create button.
   - Show resource pool name in desktop model/billing surfaces when available.

5. Desktop AI chat reliability
   - Add local conversation history create/select/switch/continue behavior.
   - Add explicit assistant turn status and visible failed-call state.
   - Support non-streaming relay responses in `streamChat`.
   - Keep abort/cancel behavior consistent with new status model.

6. Review and validation
   - Run type-check/build/test commands for affected packages as time allows.
   - Fix any substantive issues discovered by static review of touched flows.
   - Record any skipped or failing validation honestly in the final answer.

## Validation Commands

```powershell
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test
pnpm -C apps/collab-api build
pnpm -C apps/collab-admin typecheck
pnpm -C apps/collab-admin build
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop test
pnpm -C apps/desktop vite:build
```

## Review Gates

- Do not remove existing API routes.
- Do not introduce a schema migration unless inspection proves it is required.
- Do not perform a broad app-shell redesign.
- Keep UI copy in Simplified Chinese for user-facing labels touched in this task.
