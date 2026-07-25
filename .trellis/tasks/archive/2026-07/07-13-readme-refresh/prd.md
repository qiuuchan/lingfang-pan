# README 重写与缺口补全（Child C）

> 父任务：`.trellis/tasks/07-13-doc-and-sdk-overhaul`
> 调研依据：`bg_c9d2b000` 审计 + 仓库盘点

## Goal

基于现有 README 结构（保留章节顺序与风格），重写 README，使其：
- 删除已不存在的引用（`file-explorer`/`system-info`/`todo-list` 内置插件）
- 补全文档索引（含 Child B 新增的 `plugin-development/`、`api-reference/`、`sdk-guide/`）
- 新增"插件开发"章节，指向 Child A 的 SDK 与 Child B 的开发文档
- 校正所有与当前代码事实不一致的描述

## Background

**审计发现的 README 缺口**：

1. **内置插件表错误**（README "内置插件"章节）：
   - 写：`file-explorer` / `system-info` / `todo-list`
   - 实际：`ai-example` / `ai-python-example` / `game-2048` / `calculator` / `notes`
2. **文档索引不完整**（README "文档"章节）：
   - 漏：`billing-and-relay-design.md`
   - 漏：`self-review-v4-ui.md`（注：本篇在 Child B 中归档，最终 README 不需要指向它）
   - 不含：Child B 新增的 `plugin-development/` / `api-reference/` / `sdk-guide/` 三个目录（自然，因为还没建）
3. **缺插件开发章节**：README 没有任何引导读者"如何开发插件"的入口
4. **其他事实点**需对齐：
   - collab-api 模块清单（README 写 12 个，实际 24+ 个 controller）
   - 仓库结构图（README 写"5 篇 ADR"，需确认仍是 5 篇）
   - 环境变量表（README 已较全，但需查 `.env.example` 对齐）

## Scope

### 必交付

1. **修正内置插件表**：替换为实际 5 个内置插件（`ai-example` / `ai-python-example` / `game-2048` / `calculator` / `notes`），加 `plugins/summarizer` / `ai-demo` / `videodl` 一并说明
2. **补全文档索引**：
   - 既有文档加入 `billing-and-relay-design.md`
   - 加入三个新目录：`plugin-development/`、`api-reference/`、`sdk-guide/`
   - 标注 ADR 与归档（如适用）
3. **新增"插件开发"章节**（位置：在"开发指南"之后、"文档"之前）：
   - 一段简短引导：LingFang 是插件平台，开发插件是核心用法
   - `lingfang-plugin create` 一行式 quickstart（指向 `docs/plugin-development/`）
   - 三类 runtime 简表（指向 `docs/plugin-development/02-runtimes.md`）
   - 链接到 `docs/sdk-guide/`
4. **校正事实点**：
   - 模块清单更新（按 24+ controller 整理，按功能分组而非全列）
   - 仓库结构图与实际一致
   - 环境变量与 `apps/collab-api/.env.example` 对齐
   - ADR 数量与实际一致
5. **保留不动**：
   - 整体章节顺序（项目简介 → 功能特性 → 架构概览 → 快速开始 → 部署 → 项目结构 → 环境变量 → 开发指南 → **[新]插件开发** → 文档 → 设计原则 → 贡献指南 → License）
   - badges / banner
   - 设计原则 / 贡献指南 / License 章节

### 不交付

- 不重写为英文（保持中文）
- 不动核心架构描述（详见 `docs/01-vision-and-architecture.md`）
- 不加新 badge（保留现有 9 个）
- 不重制架构图（保留 Mermaid 源码）

## Requirements

### 功能性

- R1：README "内置插件"表列出实际存在的 5 个 builtin + 3 个 plugins/ 示例，名称与 `apps/desktop/builtin-plugins/*/manifest.json` 的 `name` 字段一致。
- R2：README "文档"清单覆盖 docs/ 下全部 12 篇既有文档 + 3 个新目录（plugin-development / api-reference / sdk-guide）。
- R3：README 新增"插件开发"章节，含 `lingfang-plugin create my-plugin --runtime nodejs` 一行式 quickstart。
- R4：README 所有内部链接（指向 docs/）在 GitHub 渲染下可达。
- R5：所有数字（模块数、ADR 数、迁移数）与实际仓库状态一致。

### 非功能性

- N1（不破坏）：README 改动不影响现有脚本 / 配置 / 代码。本任务只动 `README.md` 一个文件。
- N2（与 Child B 协调）：文档索引中的路径必须与 Child B 实际产出的文件路径一致。**Child B 先于 Child C 完成**，或并行同步路径。
- N3（与 Child A 协调）：插件开发章节描述的 `lingfang-plugin` CLI 必须与 Child A 实际实现一致。
- N4（中文风格）：保持现有 README 的中文风格——简体中文 + 表格密集 + 代码块语言标签 + 警告块。
- N5（长度）：README 改后总长度不超过现有 + 30%（避免膨胀失控）。

### 约束

- C1：不动 `docs/` 下任何文件（由 Child B 负责）。
- C2：不动任何代码 / 配置 / package.json。
- C3：不引入新的外部链接（避免链接腐化）。

## Acceptance Criteria

- [ ] README "内置插件"表与 `apps/desktop/builtin-plugins/*/manifest.json` 实际 name 字段逐字一致
- [ ] README "文档"清单覆盖 docs/ 全部既有文件 + 3 个新目录
- [ ] README 新增"插件开发"章节，含 `lingfang-plugin create` quickstart + 三类 runtime 简表 + 链接到 docs
- [ ] README 所有内部链接（`docs/...`）目标文件实际存在（用 grep + 文件存在性检查）
- [ ] README 中无 `file-explorer` / `system-info` / `todo-list` 残留
- [ ] README 中无 `apps/server` 残留
- [ ] README 中无 `4174` 端口残留（如原本就无，跳过）
- [ ] README 中数字（模块数 / ADR 数 / 迁移数）与实际一致
- [ ] README 总长度 ≤ 现有长度 × 1.3

## Open Questions

- 无（其他需用户决策的点已在 Child A / B 解决）

## Dependencies

- **强依赖**：Child A 完成（描述 `lingfang-plugin` CLI）
- **强依赖**：Child B 完成（文档索引路径确定）
- 实际执行顺序：Child A → Child B → Child C

## Notes

- 这是三个子任务中最轻量的，PRD + implement.md 已够，**不需要 design.md**（无技术决策，仅文档维护）。
- 实施时建议对照 Child A 与 Child B 的最终产出再校对一遍链接。
