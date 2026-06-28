# Platform plugin creation and billing UI fixes implementation plan

## Checklist

1. Locate plugin creation save/build path, especially tool/plugin payload parsing and draft storage.
2. Reproduce or reason through the failing multiline Python/Tkinter plugin payload shape.
3. Fix plugin creation payload handling and improve error messages at the narrowest shared boundary.
4. Locate wallet transaction detail overlay and add backdrop blur/dim styling consistent with Dialog/Sheet surfaces.
5. Locate shared money helpers and billing deduction display/calculation paths; round to cents before rendering or storing derived desktop values.
6. Locate model billing/request UI and types; show fast/advanced tier labels when API data includes tier information.
7. Polish the Settings update beta page while preserving update-only controls.
8. Add focused tests for helper-level behavior when practical.
9. Run validation: focused tests, `pnpm -C apps/desktop typecheck`, and ReadLints for changed files.

## Review Gates

- Before code edits: confirm applicable desktop frontend/backend specs are read.
- Before finishing: verify no unrelated user changes were reverted.
- If backend contract changes are required, stop and reassess scope before broad cross-package edits.

## Rollback Points

- Plugin creation fix should be isolated behind parser/builder/helper changes so it can be reverted without touching UI polish.
- UI polish changes should be separable from money rounding behavior.
