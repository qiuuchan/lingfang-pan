# Implement — 桌面端 UI 整改与页面接入

## 前置准备

- [ ] P1 安装缺失 shadcn 组件：
  ```bash
  cd apps/desktop
  npx shadcn@latest add collapsapsible checkbox table
  ```
- [ ] P2 确认 `next-themes` 已装（package.json 已有 `^0.4.6`）

## 执行步骤（有序）

### S1 深色主题与滚动条隐藏

- [ ] S1.1 `main.tsx`：包 `<ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>`
- [ ] S1.2 `index.css`：`@layer base` 加全局 `scrollbar-width:none` + `*::-webkit-scrollbar{display:none}`
- [ ] S1.3 `index.css`：`:root` 的 `--radius` 0.625rem → 0.5rem
- [ ] 验证：`pnpm dev`，应用默认深色、滚动无可见条

### S2 拆分 PluginCreatorHome.tsx

- [ ] S2.1 新建 `lib/plugin-draft.ts`：迁移类型 + 工具函数 + 常量（PROVIDERS/EXAMPLES/STATUS_LABEL）
- [ ] S2.2 新建 `components/chat/Bubble.tsx`、`components/chat/LiveProcess.tsx`
- [ ] S2.3 新建 `components/creator/Composer.tsx`
- [ ] S2.4 新建 `components/creator/panels/{SessionStatusPanel,CreationStatusPanel,PreviewPanel,SourcePanel,CloudSharePanel,RecentPlugins}.tsx`
- [ ] S2.5 新建 `components/creator/DetailsPanel.tsx`（组合各 panel）
- [ ] S2.6 重写 `pages/PluginCreatorHome.tsx`：只留状态编排 + 布局 + Sheet 容器，import 拆分件
- [ ] S2.7 Composer 移除"查看详情"按钮（合并详情入口）
- [ ] 验证：`wc -l apps/desktop/src/pages/PluginCreatorHome.tsx` < 300；typecheck 通过

### S3 清理 AI 说明性文本

- [ ] S3.1 `PluginCreatorHome` 系列：删定位 badge、空状态长说明、各 panel 的废话 CardDescription
- [ ] S3.2 `Plugins.tsx`：删"本地内置插件、你发布的插件…"
- [ ] S3.3 `Review.tsx`：删"作者提交到市场的插件需经审核…"
- [ ] S3.4 `Wallet.tsx`：删"余额用于购买市场上的付费插件…"
- [ ] S3.5 全局 grep `CardDescription` 与空状态 `<p class=text-muted-foreground`，按 design 判定原则清理
- [ ] 验证：`rg "AionUI|本地代码助手 · 右侧详情|都在右侧详情"` 无结果

### S4 原生元素 shadcn 化

- [ ] S4.1 `Sidebar.tsx`：NAV 原生 `<button>` → `Button`
- [ ] S4.2 `components/chat/LiveProcess.tsx`：`<details>` → `Collapsible`
- [ ] S4.3 `Auth.tsx`：`<input type=checkbox>` → `Checkbox`
- [ ] S4.4 `TeamManage.tsx`：`<table>` → `Table` 系列
- [ ] S4.5 `Market.tsx`：emoji ⭐⬇ / ★☆ → 新建 `components/stars.tsx`（lucide StarIcon）
- [ ] S4.6 `RecentPlugins`/Market 列表原生 `<button>` → `Button`
- [ ] 验证：`rg "<button|<details|type=\"checkbox\"|<table|⭐|★"` 排除 pre 调试块后无结果

### S5 Codex 视觉落地与圆角统一

- [ ] S5.1 全局 `rg "rounded-2xl|rounded-3xl|rounded-4xl"` → 降级 `rounded-xl`
- [ ] S5.2 创建插件页：状态/命令/session id 加 `font-mono`
- [ ] S5.3 各页面空状态改克制单行 + icon
- [ ] S5.4 Sheet/Dialog/Card 圆角对齐 `rounded-xl`
- [ ] 验证：`rg "rounded-(2xl|3xl|4xl)"` 无结果

### S6 路由接线与页面接入

- [ ] S6.1 `lib/types.ts`：`View` 移除 `'generator'`
- [ ] S6.2 `App.tsx`：import Market/Wallet/Review；switch 补三分支（review 带 isPlatformAdmin 守卫）
- [ ] S6.3 `Sidebar.tsx`：NAV 加 market/wallet/review；过滤条件加 `platformAdminOnly`
- [ ] S6.4 `Sidebar.tsx`：用户区 Popover 加"切换团队" Dialog 包 TenantSelect
- [ ] S6.5 `TenantSelect.tsx`：去 `mx-auto max-w-lg`，适配 DialogContent
- [ ] S6.6 `Plugins.tsx`：空状态"到市场安装" → `Button` + `setView('market')`（需 `useApp`）
- [ ] S6.7 `Market.tsx`：余额不足提示 → 加跳钱包（`useApp` 拿 `setView`）
- [ ] 验证：`pnpm dev`，Sidebar 各入口可达、切换团队 Dialog 可用、死链跳转生效

### S7 删除 Generator

- [ ] S7.1 删除 `apps/desktop/src/pages/Generator.tsx`
- [ ] S7.2 `rg "Generator"` 确认无残留 import
- [ ] 验证：typecheck 通过

## 验证命令（质量门）

```bash
cd apps/desktop
pnpm typecheck                              # AC11
pnpm vite:build                             # 构建无错
cd ../..
rg "rounded-(2xl|3xl|4xl)" apps/desktop/src # AC8 圆角
rg "AionUI|右侧详情" apps/desktop/src       # AC2 文案
rg "<button|<details|type=\"checkbox\"" apps/desktop/src  # AC9 原生元素
find apps/desktop/src -name "*.tsx" -o -name "*.ts" | xargs wc -l | sort -rn | head  # AC10 行数
```

## 风险与回滚点

| 风险                                | 缓解                                   |
| ----------------------------------- | -------------------------------------- |
| `View` 收窄致 TS 报错               | typecheck 捕获，修复遗漏的 setView     |
| 拆分后 import 路径错                | 每拆一个文件即 typecheck               |
| shadcn add 组件冲突 components.json | 已确认 base-nova style，按现有模式 add |
| TenantSelect Dialog 内 Card 双层    | 去外层 max-w，保留 Card 结构           |

每步独立可 revert。S2（拆分）是最大改动块，单独提交。

## Review Gates

- S2 后：typecheck + 行数检查（确保拆分合规）
- S6 后：人工巡检路由（4 页面可达）
- 全部完成后：完整质量门 + 浏览器巡检截图
