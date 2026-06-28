# Platform plugin creation and billing UI fixes design

## Scope

This task targets `apps/desktop` and the desktop/Tauri plugin creation boundary. It covers five user-visible fixes in one integration pass:

- plugin creation payload handling and draft save errors
- transaction detail overlay backdrop blur
- money rounding for billing deductions and balances
- model billing tier display in the frontend
- Settings update beta page polish

## Data Flow

### Plugin creation

User request -> creator UI -> plugin draft parsing/building -> local draft/plugin creation API or Tauri command -> plugin files/draft storage -> preview/draft list.

The boundary that needs protection is the structured plugin payload. Multiline source code must be handled as data, not reconstructed through fragile JSON string fragments in UI code. Validation should identify the specific field or file that failed.

### Billing and transaction display

Backend/API wallet records -> desktop API helpers/types -> wallet/settings UI formatting.

Money must be rounded at the shared money formatting/calculation boundary before being rendered. If a persisted/server value already contains floating-point noise, the UI should normalize it for display. If the desktop side performs local debit math, that same helper must round to cents before storing derived values.

### Model request tier display

Backend/API model billing record -> desktop types -> transaction/model request rows.

Tier display should consume an existing tier/type field when present. If the field is missing, the UI should avoid inventing a tier and show the existing neutral state.

### Update beta page

Settings update tab -> update status/check/install UI.

The page should keep the update-only boundary from the spec: no backend URL editing controls in Settings -> Update. Visual polish should use existing primitives, lucide icons, semantic tokens, and restrained workbench layout.

## Compatibility

- Keep existing import surfaces stable where possible, especially `@/lib/plugin-draft`.
- Do not change the plugin runtime contract unless the failing creation path requires it.
- Do not hide backend/API failures by turning them into success states.
- Existing records without model tier data remain readable.

## Validation Strategy

- Add or update focused tests around plugin draft payload handling and money rounding if suitable helpers exist.
- Run `pnpm -C apps/desktop typecheck`.
- Run focused frontend tests for touched helper modules when present.
- Read IDE lints for changed files after substantive edits.
