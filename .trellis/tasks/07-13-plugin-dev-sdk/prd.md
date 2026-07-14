# 完整插件开发 SDK 工具链（Child A）

> 父任务：`.trellis/tasks/07-13-doc-and-sdk-overhaul`
> 调研依据：`bg_29d37e4e`（运行时链路）、`bg_8ff02d63`（插件清单）

## Goal

把 `packages/plugin-sdk` 从"运行时能力客户端"扩展为"完整插件开发 SDK"。插件作者无需阅读源码即可：起一个符合平台契约的工程 → 写代码时有类型 → 本地校验 → 打包 → 发布。

## Background

**现状（已勘探确认）**：
- `packages/plugin-sdk` v0.0.6，292 行，只是 `__lingfangInvoke` 桥的 8 组类型化包装 + localhost fallback。
- **现有 8 个插件全部不 `import @lingfang/plugin-sdk`**：`client` 走宿主注入的 `window.sdk`，`nodejs`/`python` 自己内联 fetch 桥客户端。
- **没有任何 CLI、模板、manifest 校验器**。
- `sdk.plugin.upload()` 在运行时直接抛错（"运行中的插件不能发布制品"）——只供 AI 创建器用。
- 真正的发布端点是 `POST /api/plugin-registry/releases`（plugin-registry.controller.ts），不在 SDK 包装里。

## Scope

### 必交付（MVP）

1. **运行时客户端（保留 + 兼容）**：现有 `sdk.*` 8 组 API 与 `PluginAiError` **签名与行为不变**，现有 `index.spec.ts` 全部继续通过。
2. **manifest 类型与校验器**：
   - 从 `@lingfang/contract` 透传 `PluginManifest`、`CapabilityKind`、`RuntimeType`、`PluginCapability` 类型
   - 新增 `validateManifest(input: unknown): { success: true; manifest: PluginManifest } | { success: false; errors: ManifestError[] }`，基于 Zod `PluginManifest` 加业务规则（见 design.md §3）
3. **CLI 脚手架 `lingfang-plugin`**：
   - `create [name] [--runtime client|nodejs|python] [--id <id>]`：交互式 + 一行式新建工程
   - `validate [path]`：校验 manifest.json + 目录结构 + entry 文件存在
   - `build [path] [--out <file>]`：打包为 `.lfplugin` v4 制品（与桌面壳 `inspect_artifact` 兼容的 zip 结构）
   - `publish [path] --base <api-base> --token <jwt>`：调用 `POST /api/plugin-registry/releases` 上传
4. **3 套插件模板**：`client` / `nodejs` / `python`，均带 manifest.json（字段顺序规范化）+ 入口文件 + README.md + `.gitignore`
5. **TypeScript 入口契约**：导出 `ClientPluginEntry` 类型（描述 `window.sdk` 的形状），让 TS client 插件作者可写 `declare const sdk: ClientPluginEntry` 拿到补全

### 不交付（明确出范围）

- `dev` 命令的桌面壳热重载集成（v1 仅输出"复制到 builtin-plugins/ 手动测"指引）
- `cloud` runtime 模板（桌面壳视为 `client`，无独立运行时）
- npm 发布到公共 registry（仓库 private；CLI 在 monorepo 内通过 `pnpm exec lingfang-plugin` 或根脚本调用）
- IDE 插件 / VS Code 集成
- 插件市场评论 / 评分相关 API

## Requirements

### 功能性

- R1：`pnpm plugin:create my-plugin --runtime nodejs` 在仓库任意位置生成一个可被 `lingfang-plugin validate` 通过的工程。
- R2：`lingfang-plugin validate` 对 8 个现有插件（summarizer / ai-demo / videodl / ai-example / ai-python-example / game-2048 / calculator / notes）全部判定合法（不破坏既有）。
- R3：`lingfang-plugin build` 产出的 `.lfplugin` 能被桌面壳 `inspect_artifact`（plugin_package_manager.rs:849）成功解析。
- R4：`lingfang-plugin publish` 调用 `/api/plugin-registry/releases`，返回 release id。
- R5：模板生成的 `client` 插件在桌面壳内置插件目录下能直接被 `load_builtin_plugins_from_dirs` 加载运行。
- R6：`import { validateManifest, type PluginManifest } from '@lingfang/plugin-sdk/manifest'` 在 Node.js 与 Vite 项目中可用。
- R7：模板的 `manifest.json` 默认包含所有 6 个字段（id/name/version/description/runtime_type/entry）+ visibility + 空 capabilities 数组，且字段顺序统一。

### 非功能性

- N1（向后兼容）：`packages/plugin-sdk/src/index.ts` 的导出签名**逐字不变**。`PluginAiError` 的字段、`sdk.*` 8 组的方法名与参数对象形状、`invokeScriptBridge` 行为均不动。
- N2（契约一致）：manifest 校验以 `packages/contract/src/plugin.ts` 的 `PluginManifest` Zod schema 为唯一真源。SDK 不重新定义字段。
- N3（不破坏运行时）：不动 `apps/desktop` / `apps/collab-api` / `packages/contract` 的运行时代码。仅扩 `packages/plugin-sdk`。
- N4（零依赖原则）：CLI 优先用 Node.js 标准库 + 已在 monorepo 中的依赖（zod）。如必须新增，仅允许小而稳的依赖（如 `jszip` 打包）。所有新增依赖必须经 design.md §6 论证。
- N5（测试覆盖）：新增的 validator、CLI 各命令、manifest 透传类型必须有单测（Vitest），覆盖率 ≥ 80%。
- N6（跨平台）：CLI 必须在 Windows / macOS / Linux 上同样工作（不使用 PowerShell-only 路径处理；用 path.join / posix 风格）。
- N7（中文文案）：CLI 输出、模板 README、错误信息均使用简体中文。

### 约束

- C1：不引入 Rust / Go / Python 作为 SDK 实现语言。CLI 是 Node.js + TypeScript。
- C2：不修改 `packages/contract/src/plugin.ts` 的字段定义。如发现契约缺陷，单独立项修契约。
- C3：不复制现有 `apps/desktop/src-tauri/src/plugin_package_manager.rs::inspect_artifact` 的 Rust 打包逻辑到 JS——而是匹配其读取的文件结构（manifest.json + entry + 可选 meta）。
- C4：模板不得引用未在 `CapabilityKind` 枚举（`packages/contract/src/plugin.ts:14-19`）中声明的能力。

## Acceptance Criteria

- [ ] `pnpm -C packages/plugin-sdk typecheck` 通过
- [ ] `pnpm -C packages/plugin-sdk test` 通过（含新增测试 + 既有 `index.spec.ts` 全绿）
- [ ] `pnpm -C packages/plugin-sdk exec lingfang-plugin create demo --runtime nodejs` 在临时目录生成合法工程
- [ ] `pnpm -C packages/plugin-sdk exec lingfang-plugin validate <demo>` 返回 0 退出码 + 成功输出
- [ ] `pnpm -C packages/plugin-sdk exec lingfang-plugin build <demo>` 生成 `demo.lfplugin` 文件
- [ ] `pnpm -C packages/plugin-sdk exec lingfang-plugin validate plugins/summarizer` 等 8 个现有插件全部通过
- [ ] `pnpm -r typecheck` 全仓不破坏（含 desktop / collab-api / collab-admin / contract）
- [ ] `pnpm -r test` 全仓既有测试不破坏
- [ ] 新增导出 `validateManifest` / `ClientPluginEntry` 类型 / 3 套模板的目录结构在 design.md 中明示

## Open Questions

- OQ1：`.lfplugin` v4 制品的精确格式（zip 内部结构 / meta.json 字段）需在 design.md 中以 `inspect_artifact` 的 Rust 代码为唯一真源反推出来，不能猜。**实施第一步必须做这件事**。
- OQ2：`publish` 是否需要支持 `--visibility private|tenant`？答案：是，因为契约允许这两个值，但 public 由市场审核赋予。

## Dependencies

- 无前置子任务依赖（Child A 是基础）
- 阻塞 Child B（docs/sdk-guide 要描述真实 CLI 形态）与 Child C（README 要加插件开发章节）

## Notes

- 现有 SDK 包消费方式调研结论：**client 插件用宿主注入的 `window.sdk`**，**nodejs/python 插件用 SDK 的 `invokeScriptBridge` 走 env 桥**——这意味着新 SDK 还要让 nodejs/python 模板的 `import { sdk } from '@lingfang/plugin-sdk'` 干净地工作（现有 ai-demo / ai-python-example 都是内联桥客户端，是因为 SDK 当时未对脚本插件场景做透出）。这是 design.md 要解决的一个具体问题。
