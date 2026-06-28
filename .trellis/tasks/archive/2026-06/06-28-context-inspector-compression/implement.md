 # Context inspector and compression - Implementation

## Ordered Checklist

1. Add a visible context entry point in `apps/desktop/src/components/creator/FloatingCreator.tsx`.
   - Keep the existing bottom usage-bar trigger.
   - Add a top-toolbar button with the same context-open action so the window is easier to find.
   - Disable or soften the button when no breakdown exists yet.

2. Add focused compression regression coverage.
   - Create a small vitest spec for `apps/desktop/src/lib/plugin-creator/context-compress.ts`.
   - Assert `turnHasPackage()` matches fenced package blocks and ignores ordinary text.
   - Mock `chatComplete()` and assert `buildContextMessages()` summarizes older turns, preserves package-bearing turns, and populates the breakdown fields.

3. Verify the context window still renders the same breakdown data.
   - No schema changes.
   - No persistence changes.

## Validation

- `pnpm -C apps/desktop typecheck`
- `pnpm -C apps/desktop test`

If the toolbar/UI changes affect layout or import wiring, also run:

- `pnpm -C apps/desktop vite:build`

## Risk Points

- Keep the existing `ContextInspector` dialog contract unchanged.
- Do not change the `ContextBreakdown` shape or the context compression state format.
- Avoid touching unrelated creator history or skill dialogs.

## Rollback Points

- Toolbar entry-point changes in `FloatingCreator.tsx`.
- New vitest spec under `apps/desktop/src/lib/plugin-creator/`.
- Any accidental change to `context-compress.ts` summary logic.

