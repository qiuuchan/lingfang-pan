# e2e 接入评估（T9）

> 关联工单：《LingFang-工单-Beta推进-备份演练与文档-2026-08-11.md》T9 e2e 接入评估
> 关联：《LingFang-Alpha到Beta推进计划.md》第八章 e2e / P1-17·P1-18；`.github/workflows/cargo-test.yml` 已知缺口

## 结论摘要

| 套件目录 | 框架 | 依赖 | headless 可行 | CI 接线建议 |
| --- | --- | --- | --- | --- |
| `apps/collab-admin/e2e` | Playwright | web + `GovernanceApiMock`（内存 mock，无需真后端） | ✅ 可行 | 可接线（新 workflow，action 钉版） |
| `apps/web/e2e` | Playwright | web + 内置 mock 数据 | ✅ 可行 | 可接线 |
| `apps/plugin-preview/e2e` | Playwright | 自带 `createPreviewOriginServer`（node http） | ✅ 可行 | 可接线 |
| `apps/desktop/e2e` | Playwright | **Tauri 桌面窗口 / GUI** | ❌ 不可 headless | **保持已知缺口**，不阻塞其他 job |

总体：web 三套为纯前端 UI 测试，依赖对应 dev server 起服务 + Playwright chromium headless；
desktop 套件依赖真实桌面窗口（Tauri GUI），无法在 headless CI 中稳定实跑，列为已知缺口。

---

## 套件清单与依赖

### 1. `apps/collab-admin/e2e`
- 文件：`plugin-governance.spec.ts`、`governance-api-mock.ts`
- 入口：Playwright `@playwright/test`，`boot()` 用 `GovernanceApiMock` 在页面内拦截 API（内存 mock，不依赖真后端）。
- 断言：管理端插件治理 UI（列表/审核/发布状态流转）。
- 前置：collab-admin dev server 起在 `localhost`；mock 自包含。
- headless：✅ Playwright chromium headless 可跑。

### 2. `apps/web/e2e`
- 文件：`plugin-center.spec.ts`
- 入口：Playwright，内置固定 UUID 测试数据与 fixture。
- 断言：插件中心 UI（卡片/分类/价格展示）。
- 前置：web dev server。
- headless：✅ 可跑。

### 3. `apps/plugin-preview/e2e`
- 文件：`preview-sandbox.spec.ts`
- 入口：Playwright，套件自建 `createPreviewOriginServer`（node `http`）做父子窗口沙箱隔离测试。
- 断言：预览沙箱无法读取父 DOM/storage/token，拒绝非法 handshake。
- 前置：node 起本地 origin server，无外部依赖。
- headless：✅ 可跑（纯 chromium）。

### 4. `apps/desktop/e2e`
- 文件：`plugin-publishing.spec.ts`、`component-visual.spec.ts`、`markdown-bubble.spec.ts`、`tool-card.spec.ts`、`helpers.ts`、`plugin-publishing-fixture.ts` + 多个 `*.png` 截图基线
- 入口：Playwright，但 `helpers.ts`/`plugin-publishing.spec.ts` 通过 `invoke` 调用 **Tauri 命令**（如 `list_plugin_installations`、`plugin:dialog|open`），即依赖**真实桌面窗口与 Tauri 运行时**。
- 断言：桌面端插件发布工作流、组件视觉（对照 `*.png` 基线）。
- 前置：**GUI 桌面窗口 + Tauri 二进制**，无法在 headless 容器稳定实跑。
- headless：❌ 不可行（GUI 依赖）。

---

## CI 接线决策

### 可接线（web 三套）
新增 workflow（如 `.github/workflows/e2e-web.yml`），action 钉版：
- `actions/checkout@v4`
- `pnpm/action-setup@<钉版>` + Node 钉版
- `dtolnay/rust-toolchain@stable`（若 web 构建需 rust，按需）
- 步骤：`pnpm install --frozen-lockfile` → `pnpm prisma:generate`（如需要）→ 起对应 dev server → `playwright test` headless。
- 门禁结构：**绿或失败即红**（非零退出），不影响现有 cargo/vitest/typecheck job。
- 注意：`@playwright/test` 已在 devDependencies（1.61.1），需 `npx playwright install chromium` 装浏览器。

### 不接线（desktop）
- desktop 套件保持**已知缺口条目**（对应 K3 / 第八章 e2e），不强行接入 CI，避免 flaky/阻塞。
- 桌面 GUI 验证建议放在带 GUI 的专用 runner 或手动验收环节。

### 本地实跑验证说明（如实记录）
- 本工单在**隔离 PG 演练环境**中已完成 T4 备份/恢复演练；web 三套 e2e 的 headless 实跑需分别起 collab-admin/web/plugin-preview 的 dev server 与 Playwright chromium，属独立重型集成任务。
- 评估结论基于**套件源码依赖分析**（mock 自包含 / Tauri GUI 依赖），未在本会话逐一启动 dev server 实跑三套 web e2e（避免污染主工作树与长时占用）。
- 若要求在合入前实跑绿，需单独安排：起 dev server + `npx playwright install chromium` + `playwright test`，并确认种子/mock 数据与 dev server 端口对齐。此步**不阻塞**本工单文档交付与 desktop 已知缺口登记。

---

## 验收对应（工单 T9）
- [x] 评估报告存在（`docs/e2e-assessment.md`）：套件清单、可 CI 性、依赖、建议齐备。
- [x] 各 e2e 目录可 CI 性已判定（web 三套可行、desktop 不可 headless）。
- [~] CI 接线：评估给出 web 三套接线方案与钉版建议；是否在本会话实跑以绿合入，取决于 dev server 实跑安排（见上「本地实跑验证说明」）。desktop 明确保持已知缺口，不阻塞。
- 回归：本评估不改动任何测试代码，现有 cargo 309 / collab-api 1056 / collab-admin 140 / web 33 / `pnpm -r typecheck` 不受影响。
