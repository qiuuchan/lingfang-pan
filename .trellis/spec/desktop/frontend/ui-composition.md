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
- Auth and tenant selection are centered full-screen states.
- The generator page is a full-height two-column tool surface.
- Other pages live in a centered `max-w-5xl` content column.
- Lists commonly use `divide-y rounded-lg border` instead of nested cards.

Reference files:
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/pages/Generator.tsx`
- `apps/desktop/src/pages/Market.tsx`
- `apps/desktop/src/pages/Plugins.tsx`

## Copy And Language

User-facing copy is Simplified Chinese and aimed at non-technical users. Keep technical details out of primary UI text unless the current page is explicitly settings/debug oriented.

Examples:
- `Settings.tsx` explains API key handling without exposing the key.
- `Generator.tsx` gives a short generation failure in toast and keeps detailed model output in the conversation area.

## Styling Source

Global theme tokens live in `apps/desktop/src/index.css`. shadcn component variants should use semantic Tailwind tokens like `bg-background`, `text-muted-foreground`, `border`, `primary`, and `destructive` instead of one-off hex colors.

