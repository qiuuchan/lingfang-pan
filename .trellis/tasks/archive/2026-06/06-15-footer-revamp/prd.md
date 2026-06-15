# 页脚美化

## Goal

美化 `LandingFooter.tsx`，删 architecture 死链（已由 topology-revamp 删项，本任务在干净基础上重构），多列结构化布局。

## Requirements

- 多列布局：品牌列（logo + slogan + 版本徽标）+ 产品列（功能 / 下载 / 更新日志）+ 资源列 + 关于列。
- 列标题用 `lf-section-label`（#title mono 小字 accent 色），与 Hero/Features section label 呼应。
- 链接 hover：`--lf-fg-muted` → `--lf-fg`（现有 hover class 已对）。
- 禁用项（文档/协议等占位）用 `aria-disabled` + `opacity-60` + `cursor-not-allowed`（非可点死链，复用 DownloadPage.tsx:153-157 平台卡不可用态范式）。
- 顶部渐变分隔（`borderImage: linear-gradient(to right, transparent, var(--lf-border-bright), transparent)`）。
- 版本徽标：从 `/api/releases/latest` 取版本号（复用 Hero 已有的 ping 点 + 版本模式），或纯静态 mono 文字。
- **不加社交图标**（CLAUDE.md 明确无 GitHub / 外部仓库链接，Gitee 是私有仓库，不放公开社交入口）。
- 移动端 `md:grid-cols-[...]` 降级单列，每列纵向堆叠。
- 版权条（© 2026 LingFang. MIT License.）保留底部。

## Constraints

- 删 architecture 项后 STATIC_NAV 只剩「功能」1 项，grid 失衡必须重构。
- 版本徽标的数据获取须有 aborted 标志（组件卸载后 promise 不 setState，对齐 LandingHero.tsx:17-23 模式）。
- 不引新依赖。

## Acceptance Criteria

- [ ] 页脚多列结构正确渲染，列标题 + 链接层级清晰。
- [ ] 无死链（架构项已删，禁用项 aria-disabled 不可点）。
- [ ] 版本徽标正确显示（API 可用）或静态降级（API 不可用）。
- [ ] 无社交图标。
- [ ] 移动端单列降级。
- [ ] `pnpm -C apps/collab-admin typecheck` + `build` 通过。

## Notes

- 依赖 topology-revamp 先删 architecture 项（避免冲突）。
- design 并入本 prd（轻量任务，无需独立 design.md）。
