# 插件创建首页实施计划

## Steps

1. Read specs:
   - `.trellis/spec/desktop/frontend/index.md`
   - `.trellis/spec/desktop/frontend/app-shell-and-state.md`
   - `.trellis/spec/desktop/frontend/api-streaming-and-runtime.md`
   - `.trellis/spec/desktop/frontend/ui-composition.md`

2. Types and navigation
   - Add view type for creator home if needed.
   - Default post-login view becomes plugin creator home.
   - Sidebar labels reflect plugin creation as primary entry.

3. Component extraction
   - Split `Generator.tsx` or create new components:
     - `PluginCreatorHome`
     - `PluginConversation`
     - `PluginPreviewPanel`
     - `CloudSharePanel`
     - `RecentPlugins`

4. Cloud share wiring
   - Add upload action from valid draft files.
   - Add submit marketplace action.
   - Add review status display.
   - Add rejected continue-edit flow.

5. Real CLI event display
   - Subscribe to Tauri runtime events.
   - Show real stdout/stderr/stage.
   - Link transcript path when available.

6. Recent plugins
   - Implement tenant-scoped local cache.
   - Update cache on run/create/upload/edit.

7. UI polish
   - Hero and prompt-first layout.
   - AionUi-inspired spacing and workbench layout.
   - Keep shadcn/base-ui primitives.

## Validation Commands

```bash
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
```

## Manual Checks

- Login lands on creator home.
- Prompt submits.
- Tool/model selector displays status.
- Preview renders.
- Upload cloud button appears only when valid.
- Recent list updates.

## Risky Files

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/lib/types.ts`
- `apps/desktop/src/components/Sidebar.tsx`
- `apps/desktop/src/pages/Generator.tsx`
- `apps/desktop/src/pages/Plugins.tsx`

## Done When

- Creator home is default.
- Cloud share flow is visible and wired.
- UI builds and typechecks.
- Existing team/settings/plugin runner remain reachable.