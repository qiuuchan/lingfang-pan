# Implement — 统一插件启动页与一键AI修复

执行顺序按「低风险暖身 → 最高价值打通 → 体验统一」。D（AI 修复打通）是用户核心诉求，
A 最简单可先做。每块独立可验证、可单独提交。

## 完成状态（2026-06-25）

- 阶段 A 删除插件图标：✅ 完成。
- 阶段 D 一键 AI 修复链路：✅ 完成（含 use-plugin-runner-actions.spec.ts 6 项单测通过）。
- 阶段 C 完善启动报错：✅ 完成（HTML 错误改 ErrorBubble + entry_load_failed kind + 让 AI 修复）。
- 阶段 B 统一启动中转页：✅ 完成（四类走 PluginRunner，PluginLaunchScreen，本地脚本改打开进中转页）。
- 我改动的所有文件本身 typecheck 干净；新增单测通过。

## ⚠️ 外部阻塞（非本任务范围）

全量 `pnpm typecheck` / `vite:build` 当前**失败**，错误在 `FloatingCreator.tsx:515,526`：
`TS2304: Cannot find name 'upsertToolPart'` —— 这是**另一项进行中工作**（插件创建器草稿面板 /
CreatorDraftPanel / 工具卡片重构 / import-local）留下的未定义函数，不是本任务改动。
用户已确认「不管它，由那边补齐」。待 upsertToolPart 补齐后，全量构建即可恢复绿色，
本任务无需再改动。

## 阶段 0：准备

- [ ] 前端校验命令（apps/desktop/package.json 已确认）：
      `pnpm --filter @lingfang/desktop typecheck`（tsc --noEmit）+
      `pnpm --filter @lingfang/desktop vite:build`（vite 前端构建，比 `build`=tauri build 轻量）。
- [ ] 测试命令：`pnpm --filter @lingfang/desktop test`（vitest run，已有 *.spec.ts）。

## 阶段 A：删除插件图标（低风险）

- [ ] `LocalPluginRow.tsx`：`LocalPluginSummary` 删 `<PluginIcon>`，收紧左侧布局。
- [ ] `TeamPluginRow.tsx`：删 `<PluginIcon>`（行 78）+ import。
- [ ] `MarketplacePluginsSection.tsx`：删 `<PluginIcon>`（行 119）+ import。
- [ ] `Sidebar.tsx`：删 `<PluginIcon>`（行 309）+ import，固定/最近项改纯文字名。
- [ ] `meta-actions.tsx`：删图标上传/编辑 UI（行 96 `<PluginIcon>` + icon state + 上传逻辑），
      保留 manifest.icon 字段写回不破坏（不主动清空已有 icon）。
- [ ] `shared.tsx`：保留 `readPluginIcon`；`PluginIcon` 若全无引用则删，否则保留。
- [ ] 验证：列表/侧栏/市场无图标且布局不塌；编辑器无图标控件；旧插件（带 icon）不报错。
- [ ] 提交 A。

## 阶段 D：一键 AI 修复打通（最高价值）

- [ ] `App.tsx`：扩展 AppContext —— 用结构化 `pendingAutoFix: { prompt; plugin } | null` +
      `setPendingAutoFix` 替换（或并存）`pendingAutoFixPrompt`。更新 interface（行 76）+ state（行 285）+
      ctx 装配（行 624）。
- [ ] `use-plugin-runner-actions.ts`：`handleAutoFix(stderr)` 改为构造 `{ prompt, plugin }`，
      `autoFixPrompt` 升级带 plugin id/name/runtime + 报错（见 design 模板）。调 `setPendingAutoFix`。
- [ ] `FloatingCreator.tsx`：`useApp()` 取 `pendingAutoFix`/`setPendingAutoFix`；加 effect：
      非空时 `setInput(prompt)` + `setReferencedPlugin(plugin)` + `setPendingAutoFix(null)`；依赖 `[pendingAutoFix]`。
- [ ] 验证端到端：脚本插件 crash → 点「让 AI 修复」→ 创建器开 → 输入框预填报错+提示词 +
      引用 chip 显示插件名 → 点发送 → relay 请求 systemPrompt 含插件源码。**不自动发送**。
- [ ] 单测：`autoFixPrompt` 文案（含 plugin 信息）。
- [ ] 提交 D。

## 阶段 C：完善启动报错（依赖 creator-error，已存在）

- [ ] `PluginRunner.tsx` `RunnerBody`：HTML 加载错误纯文本 → `ErrorBubble`（toCreatorError）。
      必要时在 `creator-error.ts` 加 kind（如 `entry_read_failed`）或复用 `unknown` 带 raw。
- [ ] 错误态统一挂「让 AI 修复」按钮（仅 AI 可修 kind：plugin_crashed/run_failed/manifest_missing）。
- [ ] 验证：HTML 入口缺失/读取失败时显示具体错误卡片（标题+建议+可展开 raw），非单行文本。
- [ ] 提交 C。

## 阶段 B：统一启动中转页（行为变更，风险最高，放最后）

- [ ] 提炼 `StartProgressView`（现 ScriptPreviewPanel 内）为共享组件 `PluginStartProgress.tsx`。
- [ ] `PluginRunner.tsx` 引入 `LaunchState`（launching/ready/error）状态机：- client：loadPluginDocument 期间 launching；成功 ready→iframe；失败 error。- script：startPlugin onProgress 驱动 launching.stage；成功 running；失败 error。- cloud：launching 一闪 → ready（notice）。
- [ ] `LocalPluginRow.RunButton`：脚本类「运行」改为「打开」进 Runner 中转页（统一入口），
      下线行内 `startPlugin + toast` 直跑路径（保留 running 态行内「停止」可选）。
- [ ] 中转页错误态接 C 的 ErrorBubble + D 的「让 AI 修复」。
- [ ] 验证四类插件：client/nodejs/python/cloud 启动都先进中转页；成功进本体；失败进错误态。
- [ ] 回归：脚本插件启动/停止/重启正常；HTML 启动无明显卡顿（中转一闪）。
- [ ] 提交 B。

## 阶段 收尾

- [ ] 类型检查 `pnpm --filter @lingfang/desktop typecheck` 通过。
- [ ] 前端构建 `pnpm --filter @lingfang/desktop vite:build` 通过。
- [ ] 运行测试 `pnpm --filter @lingfang/desktop test` 通过。
- [ ] 清理临时文件。
- [ ] 自检 PRD 全部 AC 勾选。

## 风险点 / 回滚

- B 的入口行为变更影响最大 → 单独提交，问题可单独 revert。
- D 的 AppContext 结构化替换 → 生产端+消费端必须同批提交。
- 全程检查 `pendingAutoFixPrompt` 残留引用（grep 确认仅 App.tsx + use-plugin-runner-actions）。

## 验证命令

```bash
pnpm --filter @lingfang/desktop typecheck
pnpm --filter @lingfang/desktop vite:build
pnpm --filter @lingfang/desktop test
```

</content>
