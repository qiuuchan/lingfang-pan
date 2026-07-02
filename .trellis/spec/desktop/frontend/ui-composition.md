# UI Composition

## Component Stack

The app uses React 18, Tailwind v4, `@base-ui/react`, shadcn-generated primitives, `lucide-react`, and `sonner`.

Local component conventions:
- Import UI primitives from `@/components/ui/...`.
- Use `lucide-react` icons inside icon buttons and navigation.
- Use `cn()` from `@/lib/utils` for conditional class composition.
- Use `LoadingButton` for async button actions with visible progress.

Reference files:
- `apps/desktop/src/components/ui/button.tsx`
- `apps/desktop/src/components/loading-button.tsx`
- `apps/desktop/src/components/Sidebar.tsx`

## Layout Pattern

This is a work-focused app. Existing pages use restrained cards and dense lists, not marketing sections.

Current layout rules:
- Auth is a centered full-screen state; tenant switching is a Dialog opened from the Sidebar user area.
- Plugin run and plugin development are independent main-area views. The title-bar segment switches between `run-plugins` (`PluginCenterBody`) and `develop-plugins` (`FloatingCreator` embedded layout), with `PageTransition` handling the simple view animation. `develop-plugins` intentionally takes over the main area and hides the outer app Sidebar while active.
- The develop plugin page uses a Codex App / Claude-like dark workbench: left vertical creator navigation with inline history, centered title area, bottom-centered compact composer, quick chips below the composer, and an optional right-side draft panel when a staged plugin exists. Model selection belongs inside the composer, not in the left sidebar.
- Other pages live in a centered `max-w-5xl` content column.
- Lists commonly use `divide-y rounded-lg border` instead of nested cards.

Reference files:
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/components/TitleBar.tsx`
- `apps/desktop/src/pages/plugins/PluginCenterBody.tsx`
- `apps/desktop/src/components/creator/FloatingCreator.tsx`

## Copy And Language

User-facing copy is Simplified Chinese and aimed at non-technical users. Keep technical details out of primary UI text unless the current page is explicitly settings/debug oriented.

Examples:
- `Settings.tsx` explains API key handling without exposing the key.
- `Generator.tsx` gives a short generation failure in toast and keeps detailed model output in the conversation area.

## Styling Source

Global theme tokens live in `apps/desktop/src/index.css`. shadcn component variants should use semantic Tailwind tokens like `bg-background`, `text-muted-foreground`, `border`, `primary`, and `destructive` instead of one-off hex colors.

## Radius And Scrollbar Conventions

Radius tiers (do not introduce arbitrary `rounded-2xl/3xl/4xl`):
- `rounded-md` — inputs, small icon buttons
- `rounded-lg` — list items, bordered containers, `<pre>` debug blocks
- `rounded-xl` — cards (matches the shadcn Card default), Sheet/Dialog surfaces
- `rounded-full` — avatars, badges, icon backplates

Scrollbars are globally hidden (`scrollbar-width: none` + `*::-webkit-scrollbar { display: none }`) while keeping wheel/trackpad/keyboard scroll. Do not re-add visible scrollbars. The app defaults to dark theme via `next-themes` (`attribute="class"`, `defaultTheme="dark"`) wired in `main.tsx`; `.dark` token block in `index.css` is the source palette.

Reference files:
- `apps/desktop/src/index.css`
- `apps/desktop/src/main.tsx`
