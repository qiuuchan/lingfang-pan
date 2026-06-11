# Tokens

## File Ownership

The package owns one CSS file:

- `packages/ui-tokens/tokens.css`

It defines host-injected CSS custom properties for plugin containers:

- `--lf-color-primary`
- `--lf-color-bg`
- `--lf-color-text`
- `--lf-color-border`
- `--lf-radius-md`
- `--lf-spacing-md`
- `--lf-font-sans`

## Consumption Pattern

Plugins should consume tokens with fallbacks:

```css
body {
  font-family: var(--lf-font-sans, system-ui);
  color: var(--lf-color-text, #1a1a1a);
}
```

Reference file:
- `plugins/summarizer/ui/index.html`

## Adding Tokens

Add tokens only for values that plugin UIs need across multiple plugins. Keep names prefixed with `--lf-` and document them in this file and any generation prompt that teaches plugins to consume tokens.

Avoid moving app-specific shadcn theme variables from `apps/desktop/src/index.css` into this package unless generated/builtin plugins actually need them.

