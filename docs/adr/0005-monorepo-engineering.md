# ADR-0005：统一 Monorepo 布局与工程规范

- **状态**：Accepted
- **日期**：2026-06-09
- **关联**：[工程规范](../04-engineering.md)

---

## 背景

旧版目录组织混乱，给人「乱、没框架」的观感：

- 根目录堆了 `.agents / .claude / .codex / .cursor / .trellis` **5 套 AI 工具配置**；
- `platform/`（原始资料规划的产品目录）与 `apps/`（实际代码）**双轨并存、职责重叠，platform/ 形同废弃**；
- `night_runs/`、`release/` 等**运行/打包产物混入仓库**；
- `node_modules` 疑似被纳入交接。

注意：旧版的 `apps/packages/docs/test` 本身是规范的 monorepo——乱在「配置污染 + 双轨命名 + 产物散落」，不在核心源码。

## 决策

采用单一布局哲学（详见 [工程规范](../04-engineering.md)）：

- **只用 `apps/`**（`desktop` + `server`）+ `packages/`（`contract`/`plugin-sdk`/`ui-tokens`）+ 独立 `plugins/` + `docs/` + `tools/`。**不再有 `platform/` 双轨。**
- **AI 工具配置不入仓**：`.gitignore` 排除个人 AI 工具目录；团队级约定集中单一入口。
- **产物外置**：`target/`、`dist/`、`release/`、`night_runs/`、`node_modules/` 全部 gitignore。
- **密钥永不入仓**：走环境变量 / `.env`（本地）/ KMS（生产）。
- **契约先行 + 本地强制验证**：见 06。

## 理由

- `git clone` 后根目录应当干净，只见项目本体——这是「工程规范」最直观的验收。
- 单一布局降低认知负担，杜绝「这文件该放 platform 还是 apps」的反复。
- 产物/配置/密钥外置是卫生底线。

## 取舍 / 代价

- 团队成员需把个人 AI 工具配置放在被 ignore 的位置（轻微约束，收益远大于成本）。

## 后果

- 仓库结构与 [工程规范](../04-engineering.md) 的目录树一致；偏离即视为规范缺陷。

> 现状补记（2026-08）：本 ADR 记录的是当时的决策，`apps/` 后来按职责拆开了，
> 现为 `desktop` / `collab-api`（即决策里说的 server）/ `collab-admin` / `web` /
> `plugin-preview`，`packages/` 增加了 `workflow-engine`。以 `pnpm-workspace.yaml`
> 为准。拆分属于同一布局哲学下的自然演进，不构成对本 ADR 的偏离。
