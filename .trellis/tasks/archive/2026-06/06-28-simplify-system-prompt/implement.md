# Simplify system prompt - Implementation

## Ordered Checklist

1. Shorten `apps/desktop/src/lib/agent/run.ts`.
   - Keep the agent role and tool rules.
   - Remove plugin-structure details that already live in skills.
   - Keep the prompt readable on its own for debugging.

2. Shorten `apps/desktop/src/components/creator/FloatingCreator.tsx`.
   - Reduce `SYSTEM_PROMPT` to creator-specific context only.
   - Keep thinking mode, referenced plugin, and current draft injection.
   - Keep the visible prompt aligned with the runtime agent prompt.

3. Reword `apps/desktop/src/lib/skills.ts` only if needed.
   - Preserve existing skill IDs and activation defaults.
   - Adjust wording only where the base prompt is trimmed and the skill now needs to carry the rule.

4. Verify that the context inspector still renders the same `ContextBreakdown`.
   - No shape changes.
   - No persistence changes.

5. Add or update a focused test only if the prompt refactor creates a real regression risk.
   - Prefer a small `assembleSystemPrompt` or prompt-fragment test over broad snapshot coverage.

## Validation

- `pnpm -C apps/desktop typecheck`
- `pnpm -C apps/desktop test`

If the code changes alter UI assembly or the shared creator flow, also run:

- `pnpm -C apps/desktop vite:build`

## Risk Points

- `run.ts` and `FloatingCreator.tsx` both describe the agent. Keep them conceptually aligned even if their wording differs.
- Avoid changing any skill IDs. Existing state and defaults should continue to work.
- Do not touch `ContextInspector`, `buildContextMessages`, or the localStorage keys that store conversation history.

## Rollback Points

- Prompt text changes in `run.ts`.
- Prompt text changes in `FloatingCreator.tsx`.
- Any wording tweak in `skills.ts`.
