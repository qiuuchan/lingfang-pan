# Refresh project docs to match current architecture - Implementation

## Ordered Checklist

1. Refresh the main entry doc.
   - Update `README.md` to describe the current architecture, product flow, directory structure, and technology stack.
   - Remove or replace current-state claims about local CLI assistant injection and deleted `code_assistant` modules.

2. Rewrite the primary architecture docs.
   - Update `docs/01-vision-and-architecture.md` to describe the current desktop, backend, relay, billing, and plugin flow.
   - Update `docs/02-domain-and-plugins.md` to reflect the current domain objects and plugin lifecycle instead of `PluginDraft` / `LlmGatewayBinding`.
   - Update `docs/04-engineering.md` so the monorepo layout and engineering notes match the present repo.

3. Fix current operational docs that still drift from code.
   - Update `docs/collab-api.md` to remove deleted endpoints and keep the billing/relay surface accurate.
   - Update `docs/collab-platform.md` if it still frames the platform as being in a Rust-server-to-NestJS migration state.
   - Touch `docs/collab-desktop-client.md`, `docs/collab-admin-guide.md`, or `docs/collab-deployment.md` only if the consistency pass finds current-state conflicts.

4. Annotate root historical docs that are easy to misread as current authority.
   - Add a prominent status note to `docs/03-backend-and-llm.md`.
   - Add a prominent status note to `docs/billing-and-relay-design.md`.
   - Link those notes to the current authority docs rather than rewriting the full historical narrative.

5. Run the documentation validation pass.
   - Search the current-state doc set for removed terms and stale endpoints.
   - Manually spot-check headings, links, and cross-references after the rewrites.

## Validation

- `rg -n "code_assistant|LlmGatewayBinding|PluginDraft|Rust \\+ axum|sqlx|SQLite|BYOK|relay-docs" README.md docs/01-vision-and-architecture.md docs/02-domain-and-plugins.md docs/04-engineering.md docs/collab-api.md docs/collab-platform.md`
- `rg -n "当前实现|历史|权威" docs/03-backend-and-llm.md docs/billing-and-relay-design.md`
- Manual review of the top-level docs index in `README.md`

## Risk Points

- `README.md`, `docs/01-vision-and-architecture.md`, and `docs/02-domain-and-plugins.md` are narrative-heavy and can accidentally mix current facts with historical product language.
- `docs/collab-platform.md` and `docs/collab-api.md` must stay synchronized with actual runtime/controller boundaries.
- `docs/billing-and-relay-design.md` contains useful implementation rationale; status notes should preserve that value without leaving stale current-state claims.

## Rollback Points

- README rewrite.
- Architecture/domain/engineering doc rewrites.
- Historical status-note additions in `docs/03-backend-and-llm.md` and `docs/billing-and-relay-design.md`.
