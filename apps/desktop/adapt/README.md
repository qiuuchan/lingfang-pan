# adapt/ — 适配引擎资源目录

本目录下的 `adapt.mjs` 是**构建期生成的单文件产物**，不入库：

- 源：`packages/plugin-sdk/dist/adapt.mjs`（由 `packages/plugin-sdk/scripts/build-adapt.mjs`
  经 esbuild 打包 `src/adapt/bin.ts` 生成）。
- 落地：`scripts/materialize-adapt-engine.mjs` 在 `pnpm runtime:prepare`（dev / build 前）
  把它复制到本目录。
- 打包：经 `apps/desktop/src-tauri/tauri.conf.json` 的
  `"../adapt": "adapt"` 映射，作为 Tauri 资源随安装包分发，运行时位于
  `resource_dir/adapt/adapt.mjs`。

Rust 侧命令 `run_plugin_adapt`（`apps/desktop/src-tauri/src/plugin_adapt.rs`）用内置 Node.js
启动它，通过 stdin/stdout 单行 JSON 协议与引擎交互，把插件目录交给确定性适配引擎做校验 / 改造。

> 不要手动在此目录放 `adapt.mjs`：它会在 `runtime:prepare` 阶段被脚本覆写。
