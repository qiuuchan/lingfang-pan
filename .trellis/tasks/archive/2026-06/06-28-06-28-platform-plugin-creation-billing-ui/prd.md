# Platform plugin creation and billing UI fixes

## Goal

Fix plugin creation failures and polish billing, model request display, transaction overlay blur, and beta update page.

## Requirements

- Platform plugin creation must handle valid plugin payloads reliably, including Python/Tkinter-style app drafts with multiline source files, quoted strings, and capability metadata.
- Plugin creation failures must surface actionable errors instead of failing as a generic JSON/tool-call formatting problem.
- The transaction-detail overlay behind the wallet/billing flow must visually blur/dim the underlying page.
- Billing deductions must round monetary values to cents, preventing floating-point artifacts such as `-0.0005636999999999999` from appearing or being persisted in user-visible balances.
- Model billing and request records shown in the desktop UI must indicate whether a request used the fast or advanced tier.
- The update page beta experience should look intentional and complete, not like a placeholder.

## Acceptance Criteria

- [ ] Creating/saving a plugin draft with multiline Python/Tkinter code no longer fails due to JSON/string escaping or payload shape issues.
- [ ] Plugin creation errors include the failing field or operation when possible.
- [ ] Transaction detail overlay uses a visible backdrop blur/dim effect consistent with the app's dialog/sheet style.
- [ ] Billing math rounds debits/credits/balances to two decimal places at the shared money boundary.
- [ ] Desktop UI shows a clear fast/advanced label for model-billed requests where request tier data is available.
- [ ] Settings update/beta page is visually polished using existing UI primitives and dark-theme tokens.
- [ ] Focused typecheck/tests or equivalent validation are run and any new lint diagnostics are addressed.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
