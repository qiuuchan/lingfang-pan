# Context inspector and compression

## Goal

Make the creator's context view easy to discover and verify that automatic compression still behaves as intended.

## Requirements

- Keep the existing `ContextInspector` dialog as the main display surface for the creator context.
- Add a clearer, always-discoverable entry point in the creator UI so users can open the context view without hunting for the bottom usage bar.
- Keep the context view showing the current system prompt, summary, retained history, current input, and token breakdown.
- Verify the compression pipeline still summarizes old turns, preserves package-bearing turns, and feeds the breakdown shown in the inspector.
- Add focused test coverage for the compression helper so the summary and retained-turn behavior do not regress.

## Acceptance Criteria

- [ ] The creator UI has a visible context entry point outside the bottom usage bar.
- [ ] Opening the context view shows the same breakdown data the creator sends to the model.
- [ ] Automatic compression still preserves recent turns and package-bearing turns while summarizing older compressible turns.
- [ ] The compression helper has a focused regression test covering summary generation and retained-turn behavior.
- [ ] `pnpm -C apps/desktop typecheck`, `pnpm -C apps/desktop test`, and any needed build verification pass.

## Out of Scope

- Redesigning the `ContextInspector` layout from scratch.
- Changing the persisted conversation/history shape.
- Rewriting the compression algorithm unless the audit finds a real bug.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
