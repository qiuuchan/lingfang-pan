# 执行计划：删 architecture 区 + 拓扑动画重构

> 设计依据：`design.md`（本目录）。纯前端改动。

## 执行清单

- [ ] **T1. 新增 LandingTopology.tsx** `apps/collab-admin/src/components/landing/LandingTopology.tsx`
  - 结构见 design.md §三。
  - SVG 三节点（desktop/admin → collab-api → PostgreSQL，viewBox 900×360）+ 流动光点。
  - 移动端纵向卡片栈（`md:hidden`）。
  - 契约侧标横条卡片。
  - 节点入场用 `motion.tsx` 的 `StaggerContainer`/`StaggerItem`（一次性）。
  - **验证**：typecheck 通过。

- [ ] **T2. 删 LandingArchitecture.tsx** `apps/collab-admin/src/components/landing/LandingArchitecture.tsx`
  - 整文件删除。
  - **验证**：删除后无残留引用（grep `LandingArchitecture`）。

- [ ] **T3. 改 Landing.tsx** `apps/collab-admin/src/components/landing/Landing.tsx`
  - 删 `import { LandingArchitecture }`，加 `import { LandingTopology }`。
  - section 顺序改：Hero → Topology → Features → Footer（Topology 插在 Hero 后、Features 前）。
  - **验证**：typecheck 通过，页面结构正确。

- [ ] **T4. 改 LandingNav.tsx** `apps/collab-admin/src/components/landing/LandingNav.tsx`
  - `NAV` 数组删「架构」项（见 design.md §六）。
  - **验证**：导航只剩「功能 / 下载 / 更新日志」。

- [ ] **T5. 改 LandingFooter.tsx** `apps/collab-admin/src/components/landing/LandingFooter.tsx`
  - `STATIC_NAV` 删「架构」项（`{ label: '架构', href: '#lf-architecture' }`）。
  - **仅删项**，多列重构归 footer-revamp 子任务（本任务先确保无死链）。
  - **验证**：页脚无 #lf-architecture 死链。

- [ ] **T6. 追加 landing.css** `apps/collab-admin/src/components/landing/landing.css`
  - `lf-flow` keyframe + `.lf-flow-dot` 类（见 design.md §五）。
  - reduce 显式降级（带 `!important`），放在全局 reduce 规则之后。
  - **验证**：CSS 无语法错误，build 通过。

## 验证门

- [ ] `pnpm -C apps/collab-admin typecheck` 通过。
- [ ] `pnpm -C apps/collab-admin build` 通过。
- [ ] grep `LandingArchitecture` 全仓零匹配（彻底删除）。
- [ ] grep `#lf-architecture` 全仓零匹配（无死链）。
- [ ] 手动冒烟：dev server 打开首页，topology 动画区在 Hero 下方渲染，光点流动，移动端降级纵向栈，reduce-motion 静态展示，导航/页脚无架构项。

## 风险点

1. **offset-path 浏览器兼容**：现代浏览器（Chrome/Edge/Firefox/Safari 16+）支持，Tauri 2 webview 基于系统 WebView2/WKWebView，需确认版本。若不支持，降级用 `transform: translateX` 沿水平连线动画（topology 连线可改为水平为主）。
2. **SVG viewBox 缩放**：`w-full h-auto` 让 SVG 等比缩放，移动端隐藏 SVG 改纵向栈，避免文字挤到不可读。
