# 下载页美化

## Goal

美化 `DownloadPage.tsx`，统一日期展示、签名状态数据驱动、增强平台卡交互、加 release notes 折叠区。

## Requirements

- **日期统一**：`release.publishedAt` 改用 `formatDate()`（releases.ts:83），取代当前 `new Date(release.publishedAt).toISOString().slice(0,10)`（强制 UTC）。与 ChangelogPage 时区一致，避免同一份 release 两页差一天。
- **签名状态数据驱动**：遍历 `release.assets` 检查 `signature` 非空：
  - 全部非空 → 显示「全部已签名 ✓」
  - 部分非空 → 显示「部分产物未签名」
  - 全空 → 隐藏该行
  - 取代当前 DownloadPage.tsx:195-199 静态文案「均提供签名校验」（避免文案承诺与数据不符）。
- **平台卡 hover 顶部 accent 线**：`<span className="absolute top-0 left-0 h-[2px] w-0 bg-[var(--lf-accent)] transition-all duration-300 group-hover:w-full" />`，纯 width 动画走合成线程，reduce 全局规则已兜底。
- **release notes 折叠区**：平台卡下方独立 `<details>` 区，复用升级后的 `renderNotes`（来自 gitee-changelog 子任务）渲染 `release.notes`。**不塞进平台卡**（平台卡已 5 行信息，塞 notes 会臃肿）。
- **不加 sha256 / commitish**：schema.prisma 无 commitish 字段，`signature` 是 Tauri base64 更新签名非 sha256。加需 schema 迁移 + admin 表单，超本次范围。

## Constraints

- release notes 折叠区依赖 gitee-changelog 子任务升级后的 `renderNotes`——若并行，renderNotes 升级归 gitee-changelog 所有，本任务复用（import 或提取到共享 util）。
- 当前 DownloadPage 从 `/api/releases/latest`（DB）取数据，**不改数据源**（下载页版本号必须来自已签名产物，与 Gitee changelog 职责分离）。
- 不引新依赖。

## Acceptance Criteria

- [ ] 发布日期用 formatDate 统一展示。
- [ ] 签名状态按 assets.signature 数据驱动显示（全签名/部分/隐藏）。
- [ ] 平台卡 hover 顶部 accent 线动画正常，reduce-motion 降级。
- [ ] release notes 折叠区正确渲染（升级后的 renderNotes），默认折叠，可展开。
- [ ] 无 sha256/commitish 误导性字段。
- [ ] `pnpm -C apps/collab-admin typecheck` + `build` 通过。

## Notes

- 依赖 gitee-changelog 子任务的 renderNotes 升级（复用）。
- design 并入本 prd（轻量任务，无需独立 design.md）。
