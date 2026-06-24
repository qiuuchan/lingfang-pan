# Desktop Backend and UI Fixes Design

## Boundaries

This task spans three packages:

- `apps/collab-api`: backend DTO/controller/service contracts for billing, resource pools, channels, team roles, and relay model metadata.
- `apps/collab-admin`: admin UI for billing, pools, model access, channel tests, navigation labels, and readable role/team/pool metadata.
- `apps/desktop`: runtime API base configuration, settings UI, profile/team UI, creator chat history/status, and streaming/non-streaming relay handling.

Changes should remain compatible with existing routes and data shapes. Add optional fields and ID-targeted update endpoints where needed instead of removing existing behavior.

## Backend Contracts

- Add a partial pool update DTO for `PATCH /admin/billing/pools/:id` so resource pool edits can omit create-only fields.
- Add `PATCH /admin/billing/pricing/:id` for explicit pricing updates. Keep existing `POST /pricing` upsert for compatibility and creation.
- Include readable team metadata on pool and channel pool references when a pool is dedicated to a team.
- Include readable role metadata for team member lists when available.
- Extend relay model metadata with resource pool display information when it can be derived without schema changes.

## Admin UI Contracts

- Pricing edit decides between create/upsert and ID-targeted update based on whether a selected pricing record exists.
- Pool/team display uses team names where available and falls back to IDs only when the name is unknown.
- Model access replaces channel-management wording in visible UI. Existing internal route IDs can stay if changing them would create churn.
- The model access dialog should be wider and use tabs to group access settings and pricing settings.
- Status badges should be clear at compact table density and use restrained admin styling.

## Desktop Contracts

- API base initialization prefers persisted backend URL, then packaged config, then an empty/default local value. Saving persists normalized URLs; clearing removes persisted state.
- Settings lets users view/edit/test/save the backend/update endpoint instead of presenting it as built in when configurable.
- Close-window enum values are mapped to localized labels in the selected trigger and items.
- Creator conversations are stored locally, scoped to signed-in user/tenant when available. Stored history includes title, timestamps, turns, and selected conversation ID.
- Creator turns carry explicit status so UI state never depends only on empty content.
- Relay chat parses SSE when delivered and falls back to common non-streaming JSON response shapes.

## Compatibility and Tradeoffs

- Avoid database migrations. Prefer include/mapping changes and optional API fields.
- Preserve existing backend routes and frontend route IDs where removing them would risk breakage.
- Keep conversation history local for this task; server sync is a separate product decision.
- Merge model access and pricing conservatively through tabs and co-located controls rather than a full billing-domain redesign.

## Rollback Shape

- Backend route additions are additive and can be reverted independently.
- Admin UI changes are isolated to billing/model access components and navigation labels.
- Desktop chat history is localStorage-backed; reverting code leaves stored JSON inert.
