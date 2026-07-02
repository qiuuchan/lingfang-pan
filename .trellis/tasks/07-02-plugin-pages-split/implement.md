# Implementation Plan

1. Inspect current `PluginCenterBody`, `FloatingCreator`, and app-shell entry points.
2. Move the run/develop segmented mode switch into the top `TitleBar`.
3. Split plugin content into independent `run-plugins` and `develop-plugins` main views; use `PageTransition` for switching animation.
4. Remove the bottom-right create FAB and plugin-center dialog route.
5. Refactor creator presentation to Codex App / Claude-style dark layout without changing session, draft, upload, or data helpers.
6. Move model selection into the composer, keep the composer bottom-centered and compact, and render history directly in the creator sidebar.
7. Verify layout with typecheck, tests, build, and in-app browser checks.
