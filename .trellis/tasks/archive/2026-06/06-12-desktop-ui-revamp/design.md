# Design — 桌面端 UI 整改与页面接入

## 架构边界

本次改动限定在 `apps/desktop/src/`（React 前端），不触碰 `src-tauri/` Rust 层与后端 API。改动分五条主线：

1. 视觉令牌（`index.css` + 主题挂载）
2. 大文件拆分（`PluginCreatorHome.tsx`）
3. 文案清理（多页面）
4. 原生元素 shadcn 化（多页面）
5. 路由接线与页面接入（`App.tsx` / `Sidebar.tsx` / `types.ts`）

遵守 `.trellis/spec/desktop/frontend` 约定：新增/调整页面同步改 `View` 类型、`App.tsx` 分支、`Sidebar NAV` 三处；样式用语义 token（`bg-background`/`text-muted-foreground` 等），不写 hex；列表用 `divide-y rounded-lg border`。

## 路由接线设计

### View 类型（`lib/types.ts`）

当前：`'home' | 'team' | 'team-manage' | 'plugins' | 'settings' | 'generator' | 'market' | 'wallet' | 'review'`

变更：移除 `'generator'`。其余 `market`/`wallet`/`review` 已存在，无需新增。TenantSelect 不进 View（纯 Dialog）。

```ts
export type View = 'home' | 'team' | 'team-manage' | 'plugins' | 'settings' | 'market' | 'wallet' | 'review';
```

### App.tsx 分支（`apps/desktop/src/App.tsx`）

main 内容区 switch 补三个分支：

```ts
if (view === 'home') body = <PluginCreatorHome />;
else if (view === 'plugins') body = <Plugins />;
else if (view === 'team-manage') body = <TeamManage />;
else if (view === 'market') body = <Market />;
else if (view === 'wallet') body = <Wallet />;
else if (view === 'review') body = session.isPlatformAdmin ? <Review /> : <Plugins />;
else if (view === 'settings') body = <Settings />;
else body = <TeamHome />;
```

Review 做双保险守卫：Sidebar 过滤 + App 分支内 `isPlatformAdmin` 判断，非管理员回退到 Plugins。

### Sidebar 导航（`components/Sidebar.tsx`）

`NAV` 数组新增三项，并扩展过滤条件：

```ts
interface NavItem { v: View; label: string; icon: LucideIcon; teamAdminOnly?: boolean; platformAdminOnly?: boolean }

const NAV: NavItem[] = [
  { v: 'home', label: '创建插件', icon: SparklesIcon },
  { v: 'team', label: '团队空间', icon: HomeIcon },
  { v: 'team-manage', label: '团队管理', icon: UsersIcon, teamAdminOnly: true },
  { v: 'plugins', label: '插件', icon: PackageIcon },
  { v: 'market', label: '市场', icon: StoreIcon },
  { v: 'wallet', label: '钱包', icon: WalletIcon },
  { v: 'review', label: '审核', icon: ShieldCheckIcon, platformAdminOnly: true },
  { v: 'settings', label: '设置', icon: SettingsIcon },
];

const items = NAV.filter((n) =>
  (!n.teamAdminOnly || session.role === 'TEAM_ADMIN') &&
  (!n.platformAdminOnly || session.isPlatformAdmin)
);
```

导航按钮由原生 `<button>` 换为 shadcn `Button variant="ghost"`（active 态用 `variant="secondary"` 或 className 叠加）。

### TenantSelect Dialog 接入

用户区 Popover（已有）内新增"切换团队"`DialogTrigger`，`DialogContent` 包裹 `<TenantSelect />`。TenantSelect 内部用 `applySession` 切换后，Dialog 通过监听 session 变化自动关闭（或切换成功后手动 `setOpen(false)`）。

`TenantSelect.tsx` 调整：去掉外层 `<Card className="mx-auto w-full max-w-lg">` 的居中约束，改为适配 DialogContent 的内容结构（Card 保留但去 `mx-auto max-w-lg`，由 DialogContent 控制宽度）。

## PluginCreatorHome 拆分设计

当前 1007 行，拆为：

| 新文件 | 内容 | 预估行数 |
|---|---|---|
| `pages/PluginCreatorHome.tsx` | 主框架：状态编排、Tauri 事件监听、布局、Sheet 容器 | ~240 |
| `lib/plugin-draft.ts` | 类型（CliProbeResult/AssistantSessionState 等）+ 工具函数（safePluginId/parseManifest/previewSrcDoc/buildLocalDraft/parseTranscript/transcriptText 等）+ 常量（PROVIDERS/EXAMPLES/STATUS_LABEL） | ~280 |
| `components/creator/Composer.tsx` | 输入区 + provider/model 选择 + 发送/停止 | ~110 |
| `components/creator/DetailsPanel.tsx` | Sheet 内容容器，组合各子面板 | ~90 |
| `components/creator/panels/SessionStatusPanel.tsx` | 长任务状态 | ~80 |
| `components/creator/panels/CreationStatusPanel.tsx` | 创建状态 + 诊断 | ~70 |
| `components/creator/panels/PreviewPanel.tsx` | iframe 预览 | ~50 |
| `components/creator/panels/SourcePanel.tsx` | 源码 Tabs | ~55 |
| `components/creator/panels/CloudSharePanel.tsx` | 云端上传/市场提交 | ~75 |
| `components/creator/panels/RecentPlugins.tsx` | 最近插件列表 | ~45 |
| `components/chat/Bubble.tsx` | 对话气泡（user/assistant/error） | ~30 |
| `components/chat/LiveProcess.tsx` | 流式生成过程卡片 | ~50 |

详情入口合并：Composer 不再传 `onOpenDetails`，主框架仅保留 header 的 `<SheetTrigger>`。

## 深色主题与令牌

### 主题挂载（`main.tsx`）

项目已装 `next-themes`。在 `App` 外层包 `<ThemeProvider attribute="class" defaultTheme="dark">`，`attribute="class"` 会在 `<html>` 加 `.dark`，命中 `index.css` 的 `.dark` 变量块。

### index.css 调整

```css
@layer base {
  * {
    scrollbar-width: none;          /* firefox */
  }
  *::-webkit-scrollbar {
    display: none;                  /* webkit/tauri webview */
  }
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground; }
  html { @apply font-sans; }
}
```

`:root` 的 `--radius: 0.625rem` → `0.5rem`（收紧）。其余 token 不动，依赖 `.dark` 块。

### 圆角规约

| 类 | 用途 |
|---|---|
| `rounded-md` | Input/Textarea/小图标按钮 |
| `rounded-lg` | 列表项、`divide-y border` 容器、pre 块 |
| `rounded-xl` | Card（对齐 card 组件默认）、Sheet/Dialog |
| `rounded-full` | 头像、badge 圆角、图标圆背景 |

全局清理：`rounded-2xl`/`rounded-3xl`/`rounded-4xl` 全部降级到 `rounded-xl`。

## 文案清理策略

删除类别：
1. 产品定位 badge（"AionUI 式单对话 · 本地代码助手 · 右侧详情"）
2. 空状态长说明句（"直接自然描述目标……都在右侧详情里查看。"）
3. 解释卡片用途的 `CardDescription`（"插件 iframe 预览。""团队共享和公共市场审核。""发送需求后显示本地代码助手的运行状态。"）
4. 首屏废话副标题（"本地内置插件、你发布的插件、从市场安装的插件都在这里运行。"）

保留类别：
- 数据展示（"团队名 · 角色"、"⭐ 评分 · 下载数"——但 emoji 要换 lucide icon）
- 必要操作提示（表单 placeholder、错误处理提示）
- Dialog 内说明（发布到市场的价格说明，属必要交互信息）

判定原则：一句话能从卡片标题 + 内容推断出来的，删；解释"这是什么"而非"怎么操作"的，删。

## 原生元素替换映射

| 原生 | shadcn | 位置 | 备注 |
|---|---|---|---|
| `<button>` | `Button variant="ghost"/"outline"` | Sidebar NAV、RecentPlugins、Market 列表 | active 态用 className |
| `<details>/<summary>` | `Collapsible` | LiveProcess 思考过程 | 需 `npx shadcn@latest add collapsapsible` |
| `<input type=checkbox>` | `Checkbox` | Auth 管理员申请 | 需 `npx shadcn@latest add checkbox` |
| `<table>` | `Table`/`TableHeader`/`TableRow`/`TableCell` | TeamManage | 需 `npx shadcn@latest add table` |
| ⭐⬇ emoji / ★☆ 字符 | `Stars`（基于 `lucide` `StarIcon`） | Market | 新建小组件 |

pre 块的 `overflow-auto`（调试性日志/源码）保留，仅隐藏其滚动条。

## 数据流

不变。本次纯 UI 层改造：
- 页面继续用本地 state + `useEffect` + `api()`。
- `AppContext` 不新增字段（TenantSelect 已用现有 `applySession`）。
- 路由跳转通过现有 `setView`。

## 权衡

- **深色默认 vs 主题切换**：选择 `next-themes` 默认 dark 但保留切换能力（用户可能要浅色）。成本：包一层 ThemeProvider。
- **TenantSelect 用 Dialog vs 独立 View**：Dialog 更轻、不占导航位、符合"切换"的临时性。
- **Generator 删除 vs 保留为备选**：删除。它走后端流式，而 PluginCreatorHome 走本地 CLI，两者并存会混淆用户。后端流式能力若未来需要，再按新结构加。
- **圆角收紧到 4 档**：牺牲部分视觉层次换一致性，符合 Codex 紧凑风。

## 兼容性与回滚

- 纯前端改动，无数据迁移。
- 回滚点：每个步骤独立提交，可按步骤 revert。
- 风险点：`View` 类型收窄可能导致遗漏的 `setView('generator')` 调用报 TS 错误——typecheck 会捕获。