# Example Plugin

## Package Shape

The summarizer plugin uses the generated-plugin layout:

- `plugins/summarizer/manifest.json`
- `plugins/summarizer/ui/index.html`

`manifest.json` declares plugin metadata, `entry`, visibility, and capabilities. `ui/index.html` is a standalone HTML UI.

Reference files:
- `plugins/summarizer/manifest.json`
- `plugins/summarizer/ui/index.html`

## Capability Declaration

The UI uses:

- `sdk.fs.pick`
- `sdk.fs.read`
- `sdk.llm.chat`

The manifest declares matching capabilities:

- `fs.pick`
- `fs.read`
- `llm.chat`
- `ui.view`

Keep this alignment strict. If UI calls a capability not declared in manifest, runtime should fail.

## UI Rules

The example consumes host design tokens:

- `var(--lf-font-sans, system-ui)`
- `var(--lf-color-text, #1a1a1a)`
- `var(--lf-color-primary, #2563eb)`
- `var(--lf-spacing-md, 14px)`
- `var(--lf-radius-md, 10px)`

Plugin UI should be self-contained and user-facing copy should be Simplified Chinese. Do not embed platform secrets, gateway URLs, or provider-specific LLM details in plugin UI.

## SDK Import

The example imports:

```js
import { sdk } from '@lingfang/plugin-sdk';
```

Generated draft previews currently use a shimmed global `sdk` in the desktop app; published/builtin execution paths are bridged by the host. Keep plugin code written to the SDK contract, not to the host implementation details.

