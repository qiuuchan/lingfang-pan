 # Simplify system prompt - Design

## Architecture

The creator flow has three prompt layers today:

1. `apps/desktop/src/components/creator/FloatingCreator.tsx` builds the user-visible creator context prompt.
2. `apps/desktop/src/lib/skills.ts` appends reusable skill fragments for reusable behavior rules.
3. `apps/desktop/src/lib/agent/run.ts` builds the actual OpenAI Agents instructions and appends the creator-specific extra instructions.

This task keeps that layering, but makes each layer shorter and less repetitive.

Target shape:

- `FloatingCreator` owns only the context-specific prompt pieces: creator role, short workflow, thinking mode, referenced plugin, and current draft.
- `skills.ts` remains the home for reusable rules that should not live in the base prompt: output constraints, plugin structure checks, runtime-specific guidance, and incremental refactor behavior.
- `run.ts` keeps a compact agent core prompt for the stable agent role and tool behavior, but stops repeating detailed plugin-structure instructions that already live in skills.

## Boundaries

- Do not change `ContextInspector` or `buildContextMessages` behavior.
- Do not change the `ContextBreakdown` shape, persistence format, or localStorage keys.
- Do not change tool contracts, `CreatorAgentCallbacks`, or `assembleSystemPrompt` signatures.
- Do not add new skill IDs unless the refactor proves a clear need.

## Data Flow

1. User input is still combined with the visible creator prompt in `FloatingCreator`.
2. Active skills are still appended through `assembleSystemPrompt(base, activeIds)`.
3. The resulting prompt still feeds both the context inspector and `runPluginCreatorAgent`.
4. `buildPluginAgent` still receives `extraInstructions` and appends them after the compact agent core prompt.

## Compatibility

- Existing conversations, staged drafts, and context breakdowns remain valid.
- Default skill activation stays unchanged unless a text-only prompt change requires a wording tweak.
- The creator still supports AskQuestion, CreatePlugin, Read/Edit/Write, ListTeamPlugins, and Check with the same flow.

## Tradeoffs

- Keeping the base prompt short reduces duplication and makes the prompt easier to reason about.
- Some rule text will remain duplicated between the visible context prompt and the runtime agent prompt so that each surface stays understandable on its own.
- Avoiding a new skill surface keeps the change smaller and reduces future maintenance cost.

## Rollout / Rollback

- Update prompt literals first, then verify with typecheck and the existing test suite.
- If behavior regresses, rollback is limited to restoring prompt text and skill wording; no data migration is required.

