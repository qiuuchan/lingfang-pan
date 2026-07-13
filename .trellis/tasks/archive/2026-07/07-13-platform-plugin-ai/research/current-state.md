# Current-State Research

## Existing AI Paths

- `packages/plugin-sdk/src/index.ts` already exposes `sdk.llm.chat()` and `sdk.image.generate()` without upstream key, URL, or provider parameters.
- HTML plugins call the injected iframe bridge; `apps/desktop/src/pages/plugins-runtime.ts` forwards with the desktop login token to `/api/relay/v1/*`.
- Node/Python plugins receive only `LINGFANG_PLUGIN_BRIDGE_URL` and a scoped one-time bridge token. `apps/desktop/src-tauri/src/plugin_llm_bridge.rs` keeps the backend URL and JWT in host memory, checks manifest capabilities, and supports SDK-shaped plus OpenAI-compatible chat/image routes.
- Platform channel credentials are encrypted in `Channel.encryptedUpstreamKey` and decrypted only inside `apps/collab-api`; they are distinct from team `lf_...` relay keys.

## Confirmed Gaps

- The desktop still exposes team `lf_...` key creation/rotation in `TeamApiKeysTab.tsx`; collab-api also exposes team/admin management endpoints, API-key auth in `DualAuthGuard`, permissions, contract types, and the `PlatformApiKey` database model.
- Creator prompts forbid custom AI credentials and endpoints, but creator validation and server artifact inspection do not scan source/config/dependencies for the same policy. Node/Python processes remain soft-isolated, so the agreed scope is a hard upload/publish policy gate, not an OS network sandbox.
- Creator Agent `RunPlugin` passes `capabilities: []`, while manual preview passes manifest capabilities. Automated development tests therefore cannot exercise platform chat/image.
- Bridge errors collapse relay failures to strings, and current bridge tests do not cover successful chat/image forwarding, current-team billing, or real Node/Python OpenAI-compatible clients.

## Team Attribution Defect

- `AuthService.sessionFor()` and relay JWT auth independently select the newest ACTIVE membership by `joinedAt`; JWT contains no team claim.
- A user may have multiple ACTIVE memberships. A long-running plugin can therefore be charged to a different team after membership ordering changes.
- The secure boundary is a signed JWT team claim plus exact ACTIVE membership and ACTIVE team validation at relay time. Team-context changes must issue a new token and invalidate old bridge sessions.

## Decisions From Product Review

- Remove external relay access and all `lf_...` key functionality completely, including stored keys and log relations.
- Development tests and production calls both use platform relay and current-team credits; tests are marked in audit/log data but are not free.
- Keep `fast` / `premium` as platform aliases; upstream model/provider details stay hidden.
- Permit standard Node/Python OpenAI-compatible clients only through host-injected localhost bridge values.
- Do not require a second team-admin approval for AI capabilities; manifest declaration and existing plugin access remain required.
- Use shared creator/server policy checks. Do not add OS-level network isolation in this task.

## Relevant Specs

- `.trellis/spec/plugin-sdk/frontend/sdk-runtime.md`
- `.trellis/spec/desktop/frontend/api-streaming-and-runtime.md`
- `.trellis/spec/lingfang-desktop/backend/capability-gateway.md`
- `.trellis/spec/collab-api/backend/quality-and-contracts.md`
- `.trellis/spec/contract/backend/schema-contracts.md`
- `.trellis/spec/guides/cross-layer-thinking-guide.md`
