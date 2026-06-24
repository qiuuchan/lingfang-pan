# Desktop Backend and UI Fixes PRD

## Goal

Fix reported backend/admin/desktop defects around billing, resource pools, model access, settings, team management, and AI chat reliability. Improve the affected workflows without broad unrelated rewrites.

## Requirements

1. Existing billing pricing edits update the selected row instead of creating a new configuration.
2. Resource pool edits do not fail when create-only fields such as scope are omitted.
3. Billing enabled status uses a clear visible indicator.
4. Model test UI reports failure when the backend/test response indicates failure.
5. AI chat provides conversation history selection and switching for continuing previous sessions.
6. Failed model calls update visible state to failure instead of staying in a generating state.
7. The built-in platform address is removed from shipped config or made configurable.
8. General settings close-window behavior displays localized Chinese labels, not raw enum values.
9. Profile panel spacing/height is reduced so logout sits close to profile content.
10. Team member roles display human-readable role names while role search/select remains usable.
11. Team profile information is integrated into the team overview page.
12. Floating create-plugin button has a click animation.
13. Billing/resource pool/team association is clear and operable in backend/admin flows.
14. Admin channel management is renamed to model access and co-located with pricing configuration in a widened tabbed workflow.
15. Desktop app surfaces show resource pool names when available.
16. Desktop client supports non-streaming model responses in addition to streaming responses.
17. Touched system code is reviewed for substantive code-quality, business-logic, and error-handling defects.
18. Avoid micro-optimizations, unnecessary rewrites, and unrelated refactors.

## Acceptance Criteria

- Admin billing pricing edit sends an ID-targeted update and the backend supports updating by ID.
- Admin resource pool edit succeeds when only editable fields change; dedicated pool team information is readable when present.
- Admin model access navigation and dialog copy use model-access wording; access and pricing configuration are exposed together.
- Model/channel test status uses actual backend success/failure state.
- Desktop backend/update endpoint is not silently forced to the old fixed address; saved user configuration is honored and can be cleared.
- General settings selected close-window behavior is displayed with Chinese labels.
- Profile panel no longer has excessive empty space below profile details.
- Team overview contains team profile/basic information; role displays are readable names.
- Creator floating button visibly animates on click.
- AI chat history can be created, selected, persisted, restored, and continued locally.
- Streaming failures, aborted calls, and non-streaming JSON responses update assistant turn status correctly.
- Relevant type-check/build/test commands are run, or any inability to run them is reported.

## Out of Scope

- Full billing product redesign beyond the reported model access/pricing merge.
- Database schema migrations unless existing code inspection proves one is required.
- Server-side conversation sync.
- Broad performance tuning or styling rewrites unrelated to the listed defects.

## Open Questions

None blocking. The user approved proceeding with the existing scope. Conservative assumptions should be used where implementation details are open.
