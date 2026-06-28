# Simplify system prompt

## Goal

Reduce the plugin creator prompt to a smaller, modular instruction set that focuses on plugin structure, tool usage, and the minimum constraints the model needs to behave well.

## Requirements

- Keep the base system prompt short and stable.
- Move repeated or feature-specific rules into reusable prompt fragments / skills instead of keeping them all in one blob.
- Preserve the existing creator workflow: ask when needed, create or edit plugin files through tools, and validate before finishing.
- Keep context visibility available so users can see what the model is currently seeing, including the system prompt, any summary, retained history, and token breakdown.
- Align the prompt shape with Claude Code's public pattern: a compact core prompt plus additional dynamic instructions, rather than one large monolith.

## Acceptance Criteria

- [ ] The creator prompt is noticeably shorter and organized into clear sections.
- [ ] Plugin-structure rules are isolated from general agent behavior where possible.
- [ ] The creator still supports tool-driven plugin generation and incremental edits without behavior regressions.
- [ ] The context inspector still exposes the current system prompt and context breakdown to the user.
- [ ] The resulting prompt structure can be extended without growing the base prompt into another monolith.

## Out of Scope

- Rewriting the plugin runtime or tool APIs.
- Changing unrelated desktop UI outside the creator/context view.
- Removing context inspection entirely.

## Open Questions

## Confirmed Direction

- Keep the context inspector as-is for this task.
- Simplify the creator prompt by shrinking the base instruction set and relying on the existing reusable skills for plugin-structure rules.
- Do not introduce new skill IDs or a new prompt surface area unless the refactor shows a clear need.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
