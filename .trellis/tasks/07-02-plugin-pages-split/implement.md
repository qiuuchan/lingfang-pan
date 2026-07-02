# Implementation Plan

1. Inspect current `Plugins` and `PluginCreatorHome` composition and locate shared app-shell entry points.
2. Add local segmented mode switch in the plugin area while keeping run mode rendering unchanged.
3. Refactor creator presentation to Claude-style dark layout without changing session, draft, upload, or data helpers.
4. Verify layout with typecheck, tests, and build commands from the desktop frontend spec.
5. Review changed files for accidental data-flow changes and update task notes if needed.
