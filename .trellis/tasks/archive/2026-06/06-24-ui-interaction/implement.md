# 界面交互优化 · 执行计划（implement.md）

> 配合 `design.md`。推进顺序：低风险快赢（R4/R5/R6）→ R3 Skill → R2 FAB 动画 → R1 插件管理重构（最大、最后）。
> 验证命令（在仓库根，pnpm workspace）：
>
> - 类型检查：`pnpm --filter @lingfang/desktop typecheck`
> - 构建（前端）：`pnpm --filter @lingfang/desktop vite:build`
> - （可选完整）：`pnpm --filter @lingfang/desktop build`（tauri，需 Rust 工具链，慢）
>   每个阶段为一个独立可回滚提交点（rollback point）。Review gate = 人工确认该阶段视觉/交互达标后再进下一阶段。

---

## 阶段 0：基线（rollback point 0）

1. 确认工作区干净（`git status`），从 main 切特性分支：`git switch -c feat/ui-interaction`（用户确认后再提交）。
2. 跑一次基线 `pnpm --filter @lingfang/desktop typecheck` + `vite:build`，确保未改动前即通过。

- **Rollback**：本阶段无改动，作为后续 reset 基点。

---

## 阶段 1：R4 全局动画 token 化 + 调慢（低风险快赢）

> 先做 R4，因为 R2 的 FAB 动画会引用本阶段定义的时长 token。

1. **CSS 变量**：在 `apps/desktop/src/index.css` 的 `:root` 增加 `--lf-dur-fast/base/slow`（见 design §4.1）。同步在 `packages/ui-tokens/tokens.css` 追加同名变量（仅语义对齐，注释说明桌面壳实际读 index.css）。
2. **motion.tsx 常量**：在 `apps/desktop/src/lib/motion.tsx` 顶部新增 `MOTION` 常量对象；把 `FadeIn(0.4→)/SlideIn(0.45→)/ITEM_VARIANTS(0.4→)/PageTransition(0.25→)/StaggerContainer(stagger 0.07→)` 默认值改为引用常量并整体 ×1.4~1.5。`AnimatedNumber`/`Shimmer` 不调或轻调。
3. **Tailwind 工具类时长**：把 `ui/dialog.tsx`、`ui/popover.tsx`、`ui/sheet.tsx`、`ui/select.tsx` 的 `duration-100` 调慢（`duration-300` 或 `duration-[var(--lf-dur-base)]`）。
4. **inline 动画**：`AvatarMenu.tsx:150`(0.15→0.25)、`FloatingCreateButton.tsx:14,19` 适度上调。
5. 保留所有 `useReducedMotion` 降级；tw-animate-css 处按需加 `motion-reduce:animate-none`。

- **验证**：`typecheck` + `vite:build` 通过；`tauri dev` 目视各处入场动画整体变慢且一致。
- **Review gate**：确认动画速度观感统一、无明显卡顿。
- **Rollback point 1**：提交「R4：动画 token 化与统一调慢」。

---

## 阶段 2：R5 个人资料页降高（低风险快赢）

1. `apps/desktop/src/components/PanelDialog.tsx`：新增 `size="auto"` 档（或改 sm 档为 `max-h-[70vh]` 去掉固定 `h`，见 design §5 R5；优先新增 auto 档以不影响其它 sm 使用方——经核实 sm 档当前仅 profile 使用，二者皆可，新增 auto 更稳）。
2. `App.tsx:720` 个人资料 `<PanelDialog>` 改用新档（`size="auto"`）。
3. 可选：压 `ProfilePanel.tsx` 表单 gap / `PanelDialog` body `p-5` 内边距进一步降高。

- **验证**：`typecheck` + `vite:build`；目视个人资料窗高度贴合内容、底部留白消失，其它 PanelDialog（钱包/团队/设置/团队管理）不受影响。
- **Review gate**：确认仅个人资料窗变化，回归其余四个悬浮窗正常。
- **Rollback point 2**：提交「R5：个人资料悬浮窗高度自适应」。

---

## 阶段 3：R6 主题未选中按钮加边框（低风险快赢）

1. `apps/desktop/src/components/AvatarMenu.tsx:187-190` 主题按钮 className：未选中加 `border border-border`，选中加 `border border-transparent`（保持尺寸一致，见 design §5 R6）。

- **验证**：`typecheck` + `vite:build`；目视三主题按钮未选中态有边框、选中态无跳动。
- **Review gate**：确认亮/暗主题下边框对比度均可见。
- **Rollback point 3**：提交「R6：主题未选中按钮加边框」。

---

## 阶段 4：R3 内置 Skill 居中悬浮窗 + 话术 + 扩量

1. **话术改写**：`apps/desktop/src/lib/skills.ts` 改三个 skill 的 `name/description`（去术语，见 design §3.2），**不动 `prompt`**。
2. **扩量**：在 `SKILLS` 追加 1~N 个新 skill（含 `id/name/description/prompt`），新增默认 `defaultActive` 不设或设 `false`（避免改变开箱拼装行为）。
3. **UI 改悬浮窗**：`apps/desktop/src/components/creator/FloatingCreator.tsx:374-395` 把 Skill `Popover` 改为居中 `Dialog`（背景模糊）。
   - 新增本地 `const [skillDialogOpen, setSkillDialogOpen] = useState(false)`；WrenchIcon「Skill」按钮 `onClick={() => setSkillDialogOpen(true)}`。
   - Dialog 内：通俗标题/副标题 + 卡片化 skill 列表（复用 `Checkbox` + `toggleSkill` + `activeSkillIds`，逻辑零改）+ 「完成」关闭。
4. 验证 Esc 行为：Skill Dialog 打开时 Esc 应先关它（`FloatingCreator` 的 Esc 检测 `[role=dialog][data-state=open]`），不连带关创建器。

- **验证**：`typecheck` + `vite:build`；`tauri dev` 实测开关 skill、勾选状态正确传入 `send()` 的 `assembleSystemPrompt`、背景模糊生效、Esc 分层正确。
- **Review gate**：确认话术无开发者术语、扩量 skill 描述通俗、不影响生成流程。
- **Rollback point 4**：提交「R3：Skill 居中悬浮窗 + 话术改写 + 扩量」。

---

## 阶段 5：R2 FAB 点击弹出创建器入场动画

1. `apps/desktop/src/components/creator/FloatingCreator.tsx:326-327`：
   - overlay (`fixed inset-0 ... backdrop-blur-md`) 加 `animate-in fade-in duration-[var(--lf-dur-base)]`。
   - 居中面板加 `animate-in zoom-in-95 fade-in`（可叠 `slide-in-from-bottom-2`），`motion-reduce:animate-none`。
   - 采用 design §5 R2 路线 A（仅入场，tw-animate-css），不引入 AnimatePresence。
2. 可选：`FloatingCreateButton.tsx` 点击态与面板入场时序衔接（FAB ring 与面板升起感）。

- **验证**：`typecheck` + `vite:build`；实测点 FAB → 创建器平滑入场，reduced-motion 下瞬时出现。
- **Review gate**：确认动画平滑、无闪烁、关窗正常。
- **Rollback point 5**：提交「R2：创建器悬浮窗入场动画」。

---

## 阶段 6：R1 插件管理悬浮窗重构（最大、最后 · 路线 A 完全取代主区页）

> ✅ 用户已拍板**路线 A**：悬浮窗完全取代 `plugins/author-center/market` 主区页，删 App 主区分支，清理仅服务这些 view 的体系，插件运行从 view 解耦。详见 design §2（已改写为路线 A）。
> 建议子步骤顺序：先建新组件（不接线）→ 再删 view 改类型（靠 typecheck 暴露所有残留引用）→ 逐个修编译错误 → 最后解耦运行宿主。

6.1 **新容器（不接线）**：新增 `components/plugins/PluginCenterDialog.tsx` —— 自定义 `Dialog`/`DialogContent`（`h-[86vh] w-[94vw] sm:max-w-6xl`），**不复用 PanelDialog**（其 ScrollArea 不适配两栏，且避免动公共组件波及其余五窗）。body 自行分栏滚动。props：`open/onOpenChange/tab/onTabChange`。
6.2 **两栏 body**：新增 `pages/plugins/PluginCenterBody.tsx`，迁入 `Plugins.tsx` 的数据 hooks（`useTeamPluginList/useLocalPluginList/usePluginOpeners`）与 Tabs 内容（复用 `LocalPluginsSection/TeamPluginsSection/MarketplacePluginsSection`）。tab 改为受控（来自 6.1 props）或纯本地 state，不再与 view 同步。
6.3 **侧边栏**：固定常用(`pinnedPlugins`)+历史(`recentPlugins`)分区，点击运行复用 `usePluginOpeners`，固定/取消复用 `pinPlugin/unpinPlugin/isPinned`（design §2.3）。
6.4 **App 顶层状态**：`App.tsx` 新增 `pluginCenterOpen` + `pluginCenterTab` state，`openPluginCenter(tab?)` context 方法（仿 `openTeamAdmin`），顶层 lazy + Suspense 挂载 `<PluginCenterDialog>`（design §2.5）。
6.5 **删 view 改类型（让 typecheck 当安全网）**：

- `lib/types.ts:165`：`View` 联合删 `'plugins' | 'author-center' | 'market'`（核对 `'creator'` 等名存实亡 view，谨慎处理 `setView` 拦截兼容）。
- 删 `lib/plugin-center.ts`（3 函数）+ `lib/plugin-center.spec.ts`；`PluginCenterTab` 类型移入 body/use-plugin-center 内部保留。
- 改 `pages/plugins/use-plugin-center.ts` 的 `usePluginCenterTab` 为纯本地 tab（去 view/setView 同步）。
- 此时 `typecheck` 会在所有残留 `setView('plugins'|'market')`/`isPluginCenterView` 处报错——按报错逐个改（下一步）。
  6.6 **修所有编译错误（入口接线，design §2.4 第 4~8 点 / §2.7）**：
- `App.tsx`：删 `:650` Plugins 主区分支、`:674` `isPluginCenterView && runningPlugin` 分支、`:27` import、`:29` lazy Plugins；改主体区为「`runningPlugin ? 全屏 PluginRunner overlay : 正常 view body`」（§2.6）。
- `Sidebar.tsx`：删 `:27` import；`:36` 插件项 `onClick → openPluginCenter()`；`:124` `activeView` 去 `isPluginCenterView`；`:166-167` preloadView 处置（§风险10）；`:196` recent 点击改为仅 `setRunningPlugin(p)`。
- `Home.tsx:45`、`CommandPalette.tsx:86-87/104/115`、`AvatarMenu.tsx:111`：进插件中心改 `openPluginCenter([tab])`，运行类改 `setRunningPlugin(p)`。
- `lib/view-preload.ts:4,5,8`：删三个 loader 键或改指向新 Dialog 懒入口。
  6.7 **运行宿主解耦（design §2.6，最高风险）**：
- 主体区运行判定从 `view` 改为 `!!runningPlugin`（独立全屏 overlay）。
- `PluginRunner` 的 `onBack` 改为 `setRunningPlugin(null) + openPluginCenter()`（返回即重开插件中心）。
- **必读** `pages/plugins/use-plugin-runner-actions.ts` 核对「继续修改」的 `setView` 跳转目标；若跳 `creator` view 则改为开 `creatorOpen`（设 `currentDraft` + `setCreatorOpen(true)`），确保删 view 后该按钮仍工作。
  6.8 **删 `Plugins.tsx`**（其外壳被 PluginCenterBody 取代）或瘦身；确认无残留 import。
- **验证**：`pnpm --filter @lingfang/desktop typecheck`（必须全绿——是路线 A 的核心安全网）+ `vite:build` + `vitest run`（plugin-center.spec 已删，确认无其它引用）；`tauri dev` 实测：从 Sidebar/AvatarMenu/CommandPalette/Home 各入口打开插件中心、三 Tab、固定/历史分区、点运行 → 全屏 overlay → 返回重开中心、「继续修改」开创建器、租户切换隔离、空态、Esc 关窗。
- **Review gate**：逐条对照 `prd.md` Acceptance Criteria 第 1 条；确认无入口死链、运行不白屏、无残留 view。
- **Rollback point 6**：提交「R1：插件中心悬浮窗取代主区页 + 运行宿主解耦 + 固定/历史侧栏」。

---

## 收尾

1. 全量 `pnpm --filter @lingfang/desktop typecheck` + `vite:build`，可选 `tauri build`。
2. 逐条核对 `prd.md` Acceptance Criteria（R1~R6 + 构建通过）。
3. 清理临时文件；按 git_safety 在用户确认后推分支 / 开 PR。
4. 更新任务 journal / 记忆（如有约定）。

## 关联约束

- 全程仅改 `apps/desktop/**` 与 `packages/ui-tokens/tokens.css`（R4 语义对齐），不动后端/契约/relay。
- 任一阶段 `typecheck`/`vite:build` 失败先修复再进下一阶段；连续两次同类失败按 rules 退一步诊断根因。
