# Refresh project docs to match current architecture

## Goal

重新梳理仓库当前实现，更新项目文档，使公开文档与现有代码主线、技术栈、产品链路和模块边界一致，减少 README / docs 中对旧架构、旧生成链路和已删除模块的误导描述。

## Confirmed Facts

- 当前桌面端插件创建主线已经切到 `OpenAI Agents SDK + relay`，入口与实现位于 `apps/desktop/src/components/creator/FloatingCreator.tsx`、`apps/desktop/src/lib/agent/*`。
- 旧的本地 `code_assistant` CLI 生成链路已经删除，Rust 侧明确注明“AI 能力统一走平台 relay”；对应说明见 `apps/desktop/src-tauri/src/main.rs`、`apps/desktop/src-tauri/src/process_util/mod.rs`、`CHANGELOG.md`。
- README 仍保留 `claude / codex / opencode` 三种 CLI 编码助手、`code_assistant / cli_config / llm_*` 路径等旧描述，和当前代码主线不一致。
- `docs/01-vision-and-architecture.md`、`docs/02-domain-and-plugins.md`、`docs/04-engineering.md`、部分 ADR 仍保留旧的 Rust + axum 后端、`LlmGatewayBinding`、旧插件生成链路等历史内容。
- `docs/collab-api.md` 大体已切换到 relay + 灵石计费架构，但至少仍包含 `/api/admin/billing/relay-docs` 这类与当前控制器不一致的端点描述。
- 当前后端主线为 `NestJS + Prisma + collab-api`，桌面主线为 `Tauri 2 + Rust + React`，计费主线为 `relay + 灵石 + 团队账本 + 插件市场付费`。
- 仓库中确实存在带“历史/迁移脉络”属性的文档与 ADR，不能默认全部改写成“当前实现”而破坏历史语义。
- 用户已确认本次只更新 `README.md` 和 `docs/` 中描述当前实现的文档；不广泛重写 ADR、迁移记录、`.trellis` 内部文档。
- `docs/03-backend-and-llm.md`、`docs/billing-and-relay-design.md` 这类位于 `docs/` 根目录但包含大量历史设计/迁移信息的文档，需要被明确标注为“历史参考”或与当前权威文档建立跳转关系，避免继续被误读为当前实现。

## Requirements

- 重新读取当前代码和核心文档，识别与现状不一致的项目文档内容。
- 明确 `README.md` 与 `docs/` 内哪些文档应更新为“当前实现”，哪些文档应保留“历史/ADR/迁移记录”定位，仅补状态说明或引用跳转。
- 更新选定范围内的文档，使其与当前代码主线保持一致：
  - AI 插件创建链路
  - 桌面端宿主与运行时
  - 后端服务边界
  - 计费/relay/市场能力
  - 目录结构与关键模块说明
- 对仍保留在 `docs/` 根目录、且容易被误读为当前实现的历史文档，补充明显的状态说明，并指向对应的当前权威文档。
- 避免把历史设计文档误写成当前事实，也避免让当前事实继续依赖过期描述。

## Acceptance Criteria

- [x] 形成一份明确的文档更新范围，区分“当前事实文档”“历史但需补状态说明的根文档”“保留原状的历史/ADR 文档”。
- [x] 选定范围内的当前事实文档不再把已删除的 `code_assistant` CLI 方案写成当前主线。
- [x] 选定范围内的当前事实文档不再把旧的 Rust + axum / SQLite / `LlmGatewayBinding` / `PluginDraft` 等历史方案写成当前主线，除非明确标注为历史背景。
- [x] README 与核心架构文档中的技术栈、目录结构、产品主链路可直接用于对外介绍项目，不再与现有代码冲突。
- [x] 对保留历史定位但仍在 `docs/` 根目录的文档，补充足够明显的状态说明或跳转，避免读者误判其为当前实现。

## Out Of Scope

- 不对代码逻辑本身做功能性改动。
- 不重写 Trellis 规范、开发日志或无关任务文档，除非它们被明确纳入本次范围。
- 不承诺把所有历史文档都改造成同一种风格；历史文档允许保留历史语境。
- 不把 `docs/adr/*.md`、`docs/plugin-workbench-real-cli-test.md`、`docs/self-review-v4-ui.md` 这类明显偏 ADR、测试记录、自审记录的文档，整体重写成当前实现说明。

## Open Questions That Still Block Planning

- 当前无阻塞性开放问题。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- 该任务属于复杂文档刷新：当前实现说明与历史文档边界需要统一处理，因此在 `task.py start` 前补充 `design.md` 与 `implement.md`。
