# Implementation Plan

- [x] 添加 Tauri dialog plugin、capability 和 `selectPluginArtifact()` helper。
- [x] 增加 tagged workspace file read command/helper，修复 binary 写入与 reload round trip。
- [x] 将 import-local 上限与 v4 1500 entries 对齐并停止排除 dist/build，更新 tests/copy。
- [x] 扩展 DraftWorkspace/StagedPlugin provenance 与旧 ledger 默认值。
- [x] 抽取 Rust shared artifact uploader，新增 `publish_local_artifact` 和来源 headers。
- [x] 扩展 desktop registry API：manage list/detail、publish target、submit/withdraw、status actions。
- [x] 实现共享 PublishPluginDialog 与可恢复的 market partial-failure 状态。
- [x] 将 DraftPlugins 改为本地草稿/已发布工作台并加入生命周期操作。
- [x] 将 CreatorDraftPanel 接入共享发布 Dialog，保留现有未提交创建器布局改动。
- [x] 更新 PluginCenter 导入 picker、catalog/version history 发布来源展示。
- [x] 补 Rust/frontend tests 与 Playwright；运行 cargo/desktop 质量门。

## Validation

- `cargo test -p lingfang-desktop`
- `pnpm -C apps/desktop test`
- `pnpm -C apps/desktop typecheck`
- `pnpm -C apps/desktop vite:build`
- targeted Playwright specs at desktop and mobile-sized viewports
