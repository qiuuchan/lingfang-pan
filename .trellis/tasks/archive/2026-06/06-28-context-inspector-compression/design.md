 # Context inspector and compression - Design

## Architecture

The creator already has both pieces we need:

1. `apps/desktop/src/components/creator/ContextInspector.tsx` renders the dialog that shows the current system prompt, summary, retained history, current input, and token breakdown.
2. `apps/desktop/src/lib/plugin-creator/context-compress.ts` builds the breakdown and performs incremental compression before sending a request.
3. `apps/desktop/src/components/creator/FloatingCreator.tsx` owns the trigger state and currently exposes the inspector from the lower usage bar.

This task keeps the inspector dialog and compression algorithm, but improves discoverability and adds a regression test around the compression helper.

Target shape:

- Keep `ContextInspector` as the single display surface for context details.
- Add a clearer entry point in `FloatingCreator`'s top toolbar so the inspector is easier to find.
- Keep the bottom usage bar entry as a secondary affordance if it still helps power users.
- Add focused tests for `buildContextMessages` and `turnHasPackage` to lock down summary generation and package-turn retention.

## Boundaries

- Do not redesign the dialog layout.
- Do not change the `ContextBreakdown` shape, conversation persistence, or context window fetch logic.
- Do not change the compression algorithm unless the audit reveals a real bug.
- Do not add new state stores or persistence for inspector snapshots.

## Data Flow

1. `send()` in `FloatingCreator` builds the current `systemPrompt` and passes conversation turns plus the input to `buildContextMessages`.
2. `buildContextMessages` returns `messages`, `state`, and `breakdown`.
3. `breakdown` is stored in local component state and rendered by `ContextInspector`.
4. The UI button opens the existing dialog using that stored breakdown.

## Validation Plan

- UI verification: the context entry point is visible in the creator header.
- Logic verification: a vitest spec proves compression summarizes older turns, preserves package-bearing turns, and keeps the breakdown fields populated.

## Tradeoffs

- Keeping the existing dialog avoids reworking a known-good inspection surface.
- A top-level entry point improves discoverability without changing the actual data model.
- A focused helper test gives us confidence in the compression path without freezing the entire UI.

