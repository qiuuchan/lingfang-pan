# 文档与插件开发 SDK 整体重构

## Goal

把 LingFang 平台的"插件开发生态"和"对外文档"从"零散可用"提升到"完整自洽"：

- **插件作者**：拿到一条命令（`lingfang-plugin create`）就能起一个符合平台契约的插件工程，写代码时有完整类型与校验，发布时有打包与上传工具。
- **二次开发者 / 集成方**：打开 `docs/` 任意一篇都能拿到与当前代码事实一致的、可执行的信息，覆盖前后端、插件、API、SDK、部署、计费。
- **新读者**：README 30 秒内理解平台定位、5 分钟跑通本地开发、能找到所有深入文档的入口。

## Background

当前现状（2026-07-13 盘点）：

1. `packages/plugin-sdk` 已存在，但**只是运行时能力客户端**（292 行）：8 组类型化能力 + `__lingfangInvoke` 桥 + 脚本插件 localhost fallback。**不是开发 SDK**——没有 CLI、没有 manifest 校验器、没有模板、没有打包工具。插件作者只能"照抄 `plugins/summarizer`"或让 AI 生成。
2. `docs/` 下 14 篇文档 + 5 篇 ADR + evidence/，但：
   - README 文档清单**漏了** `billing-and-relay-design.md` 与 `self-review-v4-ui.md`；
   - 没有系统的插件开发文档、SDK 使用文档、HTTP API 参考；
   - 部分老文档与当前代码（12 个 collab-api 模块、4 类 runtime、新计费/relay）存在漂移，待审计确认。
3. README 整体准确但缺少"插件开发"章节，且文档索引不完整。

## Scope（3 个子任务）

### Child A — `07-13-plugin-dev-sdk`：完整插件开发 SDK 工具链

把 `packages/plugin-sdk` 从"运行时客户端"扩展为"开发 SDK"，包含：

- **运行时客户端**（保留现有 `sdk.*` 8 组 API 与 `PluginAiError`，不破坏向后兼容）
- **CLI 脚手架**：`lingfang-plugin <command>`
  - `create`：交互式 / 一行式新建插件工程（含模板）
  - `validate`：本地校验 `manifest.json` 与目录结构
  - `build`：打包为可上传的插件包
  - `dev`（可选，如桌面端支持）：本地预览对接
  - `publish`：调用 `sdk.plugin.upload / submitMarketplace` 上传到团队/市场
- **manifest 类型与 Zod 校验器**：导出 `PluginManifest` 类型（来自 `@lingfang/contract`）+ 独立可调用的 `validateManifest()` 工具
- **插件模板**：4 类 runtime（`client` / `nodejs` / `python` / `cloud`）各一套最小可跑模板
- **TypeScript 入口契约**：导出 client runtime 的 entry 类型（如 `LingFangPluginEntry`），让 TS 插件作者有类型保障

### Child B — `07-13-docs-rewrite`：docs/ 全量重写 + 新增

- 逐篇重写 `docs/` 下 14 篇文档（不含 ADR），对齐当前代码事实，剔除过时内容
- **新增** 三个文档目录：
  - `docs/plugin-development/`：插件开发指南（quickstart / manifest / 各 runtime / 能力声明 / 调试 / 发布）
  - `docs/api-reference/`：HTTP API 系统参考（鉴权 / 各模块端点 / 请求响应 schema / 错误码）
  - `docs/sdk-guide/`：SDK 使用指南（运行时客户端 / CLI / 模板 / 类型工具）
- ADR 保留为历史决策快照，不重写（如内容过时则在对应新文档中标注）
- 全部简体中文，与项目语言策略一致

### Child C — `07-13-readme-refresh`：README 重写与缺口补全

- 基于现有 README 结构（保留章节顺序与风格）
- **补缺**：文档清单加入 `billing-and-relay-design.md`、`self-review-v4-ui.md`、新增的 `plugin-development/`、`api-reference/`、`sdk-guide/` 目录
- **新增**：插件开发章节（指向 Child B 文档与 Child A SDK）
- **审计**：环境变量、命令、地址、技术栈版本是否与当前 `package.json` / `apps/*` 一致
- **不动**：核心架构描述（已在 Child B 文档里维护）

## Requirements（跨子任务）

### 功能性

- R1：插件作者通过 `pnpm dlx @lingfang/plugin-sdk create my-plugin` 或仓库内 `pnpm plugin:create` 起一个可运行、可校验、可打包、可发布的插件工程，无需查阅源码。
- R2：所有 `docs/` 文档与 `packages/`、`apps/` 代码事实一致；任意"复制粘贴可执行"的命令、路径、字段名经过验证。
- R3：HTTP API 参考覆盖 `apps/collab-api/src/modules/` 下全部 controller 的对外端点；不漏端点。
- R4：README 在 5 分钟内能引导新开发者跑通后端 + 桌面端，并指向所有深入文档。

### 非功能性

- N1（向后兼容）：现有 `packages/plugin-sdk` 的 `sdk.*` API **签名与行为不变**。新功能必须为加法。已发布的 `index.spec.ts` 测试继续通过。
- N2（契约一致性）：SDK、文档、README 引用的 manifest / capability / runtime_type / 错误码一律以 `packages/contract/src/` 为唯一真源。
- N3（语言）：所有新增/重写文档使用简体中文（与项目一致）。代码标识符保持英文。
- N4（不破坏运行时）：不动 `apps/desktop` 运行时行为、不动 `apps/collab-api` 业务逻辑、不动 `packages/contract` schema。仅允许扩 `packages/plugin-sdk` 与新增包/文件。
- N5（链接可循）：所有文档之间的交叉引用、README 指向 docs 的链接必须有效（相对路径，可在 GitHub 与本地双向打开）。

### 约束

- C1：仓库当前为 `private`，文档面向"已授权的二次开发者 / 内部团队 / 平台用户"，不外泄密钥、不写真实凭据。
- C2：CLI 实现优先用 Node.js（与 monorepo 一致），不引入 Rust / Go / Python 作为 SDK 实现语言。
- C3：模板与示例插件不得引用未在 `packages/contract` 中声明的 capability kind。

## Cross-Child Acceptance Criteria

- [ ] Child A 完成：`packages/plugin-sdk` 提供 `lingfang-plugin` CLI，能 `create` → `validate` → `build` → `publish` 一个符合 `plugins/summarizer` 结构的示例插件，且通过新写的单测。
- [ ] Child B 完成：`docs/` 下所有非 ADR 文档与 `apps/` / `packages/` 代码事实一致（交叉验证清单见 Child B 的 `implement.md`），且新增三个文档目录可访问。
- [ ] Child C 完成：README 所有内部链接可达、文档清单完整、新增插件开发章节、`pnpm start` 流程描述与 `tools/start.ps1` 当前行为一致。
- [ ] 跨子任务一致性：SDK 文档（Child B 的 `sdk-guide/`）描述的 CLI/API 与 Child A 实际实现一字不差；README 指向的文档路径在 Child B 中存在。
- [ ] 全仓 `pnpm typecheck` 通过（不破坏既有类型）。
- [ ] 全仓 `pnpm test` 通过（不破坏既有测试，新增 SDK 测试一并绿）。

## Task Map

```
07-13-doc-and-sdk-overhaul (this parent)
├── 07-13-plugin-dev-sdk    —— Child A
├── 07-13-docs-rewrite      —— Child B（依赖 Child A 的 CLI/API 形态作为事实源）
└── 07-13-readme-refresh    —— Child C（依赖 Child A + B 的产出做最终链接与索引）
```

执行顺序建议：

1. 先做 Child A（SDK 形态先定下来，文档才有事实可依）
2. 再做 Child B（文档基于 Child A 的实现 + 当前代码事实）
3. 最后做 Child C（README 索引最终化）

## Out of Scope

- 不重写 ADR（历史决策快照，保留原貌）
- 不改 `apps/collab-api` 业务逻辑
- 不改 `apps/desktop` 运行时行为
- 不改 `packages/contract` schema（如需扩 capability kind 单独立项）
- 不做 i18n / 英文文档（项目语言策略是简体中文）
- 不做面向最终用户的官网内容（管理端落地页是另一条线）

## Notes

- 父任务本身不承载实施工作，只持有需求集 + 跨子任务验收。
- 子任务的 `prd.md` / `design.md` / `implement.md` 各自维护。
- 跨子任务一致性由父任务最终集成 review（`acceptance criteria` 第 4 条）保证。
