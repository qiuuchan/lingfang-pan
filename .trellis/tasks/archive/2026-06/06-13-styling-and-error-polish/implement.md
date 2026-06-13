# 样式与错误友好化修复 — 执行计划

> 子任务：`06-13-styling-and-error-polish`（父任务 R5）。
> 技术设计见同目录 `design.md`，本文件为可执行 checklist。所有改动限定在 `apps/desktop/src`，零契约变更。

## 1. 前置条件与依赖

### 1.1 前置依赖（子任务间）

| 依赖项 | 来源子任务 | 关系 | 说明 |
|---|---|---|---|
| `Bubble` / `Composer` / `Info` / 各 Panel | 当前既有代码 | 直接改造 | 无需等待 |
| `markdown.tsx` | `06-13-output-rendering-polish`（R4） | **弱耦合** | 本任务只删除 `Bubble.error` 分支，不碰 `markdown.tsx`；R4 改高亮/复制与本任务并行无冲突 |
| `run_plugin_script` 返回结构 | `06-13-node-python-local-exec`（R3） | **接口对接** | 本任务定义 `RunScriptResult` 期望形状（`design.md` §3.3）；R3 实现须对齐。**本任务可先实现 `fromRunResult` 解析器并独立验证，不阻塞于 R3 完成** |
| 后端契约 | `06-13-structured-output-parsing`（R2） | **无** | 本任务无契约面，上传错误的友好映射基于 `ApiError.code`/HTTP status，不依赖契约变更 |

**结论**：本子任务**可与其它并行启动**，仅在与 R3 对接 `RunScriptResult` 形状时需在 review gate 协调（见 §4 G3）。

### 1.2 环境前置

```powershell
# 确认 desktop 依赖已装（包名 @lingfang/desktop）
cd O:\lingfang-platform
pnpm install
```

### 1.3 测试能力现状（重要约束）

- `apps/desktop` **无测试 runner**（无 vitest/jest，见 `apps/desktop/package.json`），仅有 `typecheck`。
- 因此 `creator-error.ts` 的纯函数测试采用**两种补偿**（符合 CLAUDE.md「缺失测试列风险 + 补测计划」）：
  1. 写纯 TS 模块（`creator-error.ts`），保证可在 `node --import tsx` 或临时 `.mjs` 探针中调用。
  2. 提供手动 console 探针脚本（`apps/desktop/scripts/probe-creator-error.mjs`，见 §2 step1），本地 `node` 执行断言。
- **风险记录**：缺乏自动化 runner，纯函数回归依赖手动探针；列入 §4 review gate G2 强检。

## 2. 有序执行 checklist

> 每步完成后执行对应验证命令，**失败即止**（遵循 CLAUDE.md）。
> 包名过滤统一用 `pnpm --filter @lingfang/desktop <script>`。

### Step 1 — 新增错误模型与工厂（`creator-error.ts`）

- [ ] 新建 `apps/desktop/src/lib/creator-error.ts`，导出：
  - 类型：`CreatorErrorLevel`、`CreatorErrorKind`、`CreatorError`、`RunScriptResult`。
  - 文案表：`TITLE_MAP`、`DETAIL_MAP`、`RETRYABLE_MAP`（每种 kind 的固定中文标题/详情/可重试）。
  - 工厂：`toCreatorError(kind, error)`、`toUploadError(error, action)`、`fromRunResult(result)`。
- [ ] 新建手动探针 `apps/desktop/scripts/probe-creator-error.mjs`：动态 import 编译产物或用 `tsx` 跑，对 4 个关键路径断言（见 design §7.2）。
- [ ] **验证**：
  ```powershell
  pnpm --filter @lingfang/desktop typecheck
  node apps/desktop/scripts/probe-creator-error.mjs   # 若用 tsx：pnpm dlx tsx apps/desktop/src/lib/creator-error.ts
  ```
  断言全绿（`cli_start_failed` retryable=true；`interpreter_missing` retryable=false；`timeout` retryable=true；`upload` 409 → level=info）。

### Step 2 — `liveError` 类型升级（`PluginCreatorHome.tsx`）

- [ ] `import { CreatorError, toCreatorError, toUploadError } from '@/lib/creator-error'`。
- [ ] `51` 行 `useState<string | null>(null)` → `useState<CreatorError | null>(null)`。
- [ ] 同步 6 处 `setLiveError`：
  - `142`（`code-assistant://error` 事件）→ `setLiveError(toCreatorError('cli_session_error', new Error(payload.error)))`。
  - `208`（read_transcript 失败）→ `setLiveError(toCreatorError('transcript_failed', error))`。
  - `270`（send 中 start_session 失败）→ `setLiveError(toCreatorError('cli_start_failed', error))`。
  - `288`（stop 失败）→ `setLiveError(toCreatorError('cli_start_failed', error))`（语义归到「会话操作失败」，复用 `cli_start_failed` 或新增 `session_op_failed`——决策：复用，避免 kind 爆炸）。
- [ ] `306`（uploadCloud catch）→ `toast.error(err.title)` + `setLiveError(toUploadError(error, 'upload'))`。
- [ ] `322`（submitMarketplace catch）→ `toast.error(err.title)` + `setLiveError(toUploadError(error, 'submit'))`。
- [ ] `233, 339`（newDraft / 发送前清空）保持 `setLiveError(null)`。
- [ ] **验证**：
  ```powershell
  pnpm --filter @lingfang/desktop typecheck
  ```

### Step 3 — 新增 `ErrorBubble` + 改渲染点

- [ ] 新建 `apps/desktop/src/components/chat/ErrorBubble.tsx`（design §3.5.1）：图标+标题+detail+`<details>` 折叠 raw（`max-h-48 overflow-auto scrollbar-thin`）+条件重试按钮。
- [ ] `PluginCreatorHome.tsx:380`：
  ```tsx
  {!streaming && liveError && <ErrorBubble error={liveError} onRetry={pendingPromptRef.current ? send : undefined} />}
  ```
- [ ] retry 复用 `pendingPromptRef.current`（`238` 行已有 prompt 快照）。
- [ ] **验证**：
  ```powershell
  pnpm --filter @lingfang/desktop typecheck
  ```

### Step 4 — 删除 `Bubble.error` 分支

- [ ] `apps/desktop/src/components/chat/Bubble.tsx`：
  - 删 `error?: boolean` prop（`4` 行）。
  - 删 `error && '…'`（`7` 行）与 error 三元分支（`9` 行），保留 `isUser ? content : <Markdown>{content}</Markdown>`。
- [ ] **验证**：
  ```powershell
  pnpm --filter @lingfang/desktop typecheck   # 确认无残留 error 引用
  ```

### Step 5 — 增强 `Info`（P4）

- [ ] `apps/desktop/src/components/creator/Info.tsx`：
  - 新增 `truncate?: boolean`（默认 false）。
  - `5` 行：`<div className={cn('font-medium', truncate ? 'truncate' : 'break-all')} title={value}>{value}</div>`。
  - 新增 `import { cn } from '@/lib/utils'`。
- [ ] 调用点同步（短值传 `truncate`，长值不传）：
  - `CreationStatusPanel.tsx:17`（状态，短）→ `truncate`；`:18`（文件数，短）→ `truncate`；`:19`（入口，长）→ 不传；`:20`（运行时，短）→ `truncate`。
  - `SessionStatusPanel.tsx:31`（状态）→ `truncate`；`:32`（退出码）→ `truncate`；`:33`（PID）→ 不传；`:34`（Transcript 路径，长）→ 不传。
- [ ] **验证**：
  ```powershell
  pnpm --filter @lingfang/desktop typecheck
  ```

### Step 6 — Composer 贴边修复（P1）

- [ ] `apps/desktop/src/components/creator/Composer.tsx:44`：`p-0` → `px-1`。
- [ ] **验证**：手动预览（§7.3 第 1 项）。

### Step 7 — 诊断项加容器（P2）

- [ ] `apps/desktop/src/components/creator/panels/CreationStatusPanel.tsx:24-26`：裸 `<p>` → 带边框背景的 `div`（pass=emerald、fail=destructive，design §3.5.5）。空态 `26` 行 `<p>` 同步换 muted 行容器。
- [ ] 新增 `import { cn } from '@/lib/utils'`。
- [ ] **验证**：`pnpm --filter @lingfang/desktop typecheck` + 手动预览（§7.3 第 2 项）。

### Step 8 — aside 响应式收缩（P5）

- [ ] `apps/desktop/src/pages/PluginCreatorHome.tsx:407`：`'w-[420px]'` → `'w-full md:w-[420px] z-20'`。
- [ ] `409` 行内层 `'flex h-full w-[420px] flex-col'` → `'flex h-full w-full md:w-[420px] flex-col'`。
- [ ] **验证**：手动预览（§7.3 第 5 项，DevTools 调窗口宽度 < 768 / ≥ 768）。

### Step 9 — 全局滚动条策略（P6）

- [ ] `apps/desktop/src/index.css:120-127`（`@layer base`）：
  - 全局 `* { scrollbar-width: none }` 收紧为 `body, html, .scrollbar-hide`。
  - `*::-webkit-scrollbar { display:none }` 收紧为对应选择器。
  - 新增 `@layer utilities { .scrollbar-thin { … } }`（design §3.5.7）。
- [ ] 应用 `scrollbar-thin` 到功能性滚动元素：
  - `SourcePanel.tsx:18`（源码 `<pre>`）。
  - `SessionStatusPanel.tsx:46-47`（stdout/stderr `<pre>`）。
  - `ErrorBubble` 折叠 raw（Step 3 已含）。
- [ ] **验证**：手动预览（§7.3 第 6 项）—— 确认功能性区域有细滚动条、页面外层无滚动条。

### Step 10 — SourcePanel Tabs 单行横向滚动（P8）

- [ ] `apps/desktop/src/components/creator/panels/SourcePanel.tsx:16`：`'max-w-full flex-wrap'` → `'max-w-full overflow-x-auto overflow-y-hidden scrollbar-thin'`。
- [ ] **验证**：手动预览（§7.3 第 8 项，构造多文件 draft）。

### Step 11 — header padding 决策（P7）

- [ ] `apps/desktop/src/pages/PluginCreatorHome.tsx:349`：保留 `pl-16 pr-4 py-3`，**仅加注释**说明 `pl-16` 为 Sidebar 避让区（design §3.5.8）。
- [ ] **验证**：手动预览（§7.3 第 7 项）。

### Step 12 — 全量回归

- [ ] `pnpm --filter @lingfang/desktop typecheck`（必须 0 error）。
- [ ] `pnpm --filter @lingfang/desktop build`（确认构建通过、产物体积无明显增长）。
- [ ] 手动预览全部 AC5/AC6 项（§7.3 第 1-9 项逐条）。
- [ ] 对接 R3：与 `06-13-node-python-local-exec` 负责人确认 `run_plugin_script` 返回满足 `RunScriptResult` 形状（review gate G3）。

## 3. 契约变更顺序

> **本子任务无契约变更**。

- 不改 `packages/contract`、不改后端 `plugin-package.ts`、不改 Prisma、不改 Rust。
- `CreatorError` / `RunScriptResult` 是 `apps/desktop/src/lib/creator-error.ts` 内的**前端内部类型**，非跨进程契约。
- `RunScriptResult` 是前端对 R3 返回值的**期望形状**（design §3.3），属子任务间接口约定，记录在 design/implement 中由双方对齐，不走 `packages/contract`。

因此**无 contract-first 流程**适用。本节标注「无」以满足模板要求。

## 4. Review Gate（关键检查点）

> 每个 gate 必须通过才能进入下一阶段；未过则回到对应 Step 修正。

### G1 — 错误模型正确性（Step 1 后）

- [ ] `creator-error.ts` typecheck 通过。
- [ ] 探针脚本 4 条断言全绿。
- [ ] 文案表无 TBD/占位（每种 kind 都有标题+详情）。
- **检查者**：实现者自检。

### G2 — 类型与构建（Step 2-5 后）

- [ ] `liveError` 升级后 6 处 `setLiveError` 全部传 `CreatorError`，无残留 `string`。
- [ ] `Bubble` 无 `error` 残留引用（grep `Bubble` 的 `error` 调用为 0）。
- [ ] `ErrorBubble` 渲染点（`380`）类型匹配。
- [ ] `Info` 8 处调用点的 `truncate` 传参符合「短值传、长值不传」。
- [ ] `pnpm --filter @lingfang/desktop typecheck` 0 error。
- **检查命令**：
  ```powershell
  pnpm --filter @lingfang/desktop typecheck
  ```
- **检查者**：实现者自检 + 父任务集成 review。

### G3 — R3 接口对齐（Step 12 前）

- [ ] 与 R3（`06-13-node-python-local-exec`）确认 `run_plugin_script` 返回结构满足 `RunScriptResult`（`ok/stdout/stderr/exitCode/failure/interpreter`）。
- [ ] `failure` 枚举值（`interpreter_missing`/`timeout`/`nonzero_exit`/`spawn_failed`）与 R3 实际产出一致。
- [ ] 若 R3 形状有出入：**修改 `creator-error.ts` 的 `RunScriptResult` 与 `fromRunResult`**，不改 R3 Rust（前端适配）。
- **检查者**：本任务 + R3 负责人协调。

### G4 — 样式与错误友好（AC5/AC6）（Step 12 后）

- [ ] 手动预览 §7.3 第 1-9 项全过。
- [ ] 父 PRD AC5（Composer 不贴边/诊断有容器/溢出有滚动指示/窄窗口不挤压）逐条 ✓。
- [ ] 父 PRD AC6（CLI 失败/上传失败/解释器缺失/超时均气泡或卡片，无裸 toast 或静默）逐条 ✓。
- [ ] toast 仅用于瞬时通知标题，完整错误在对话气泡可回看。
- **检查者**：父任务最终集成 review。

## 5. 回滚点

本子任务改动集中在 `apps/desktop/src` 的 **8 个文件 + 1 个新脚本**，无数据面/契约面影响，回滚即 `git revert`：

| 回滚单元 | 涉及文件 | 回滚方式 |
|---|---|---|
| 错误模型 | `src/lib/creator-error.ts`（新）、`scripts/probe-creator-error.mjs`（新） | 删除两文件 |
| `liveError` 升级 + `ErrorBubble` + `Bubble` 删 error | `src/pages/PluginCreatorHome.tsx`、`src/components/chat/Bubble.tsx`、`src/components/chat/ErrorBubble.tsx`（新） | revert commit |
| `Info` 增强 + 调用点 | `src/components/creator/Info.tsx`、`CreationStatusPanel.tsx`、`SessionStatusPanel.tsx` | revert commit |
| 样式 7 处 | `Composer.tsx`、`CreationStatusPanel.tsx`、`PluginCreatorHome.tsx`、`index.css`、`SourcePanel.tsx` | revert commit |

**建议提交粒度**（小步可回滚）：

1. commit A：`creator-error.ts` + 探针（Step 1）。
2. commit B：`liveError` 升级 + `ErrorBubble` + 删 `Bubble.error`（Step 2-4）。
3. commit C：`Info` 增强 + 调用点（Step 5）。
4. commit D：样式 7 处修复（Step 6-11）。

任一 commit 回滚不影响其它（D 可独立回滚保留错误友好化；B/C 独立）。

> 所有 commit message 使用简体中文（遵循 CLAUDE.md）。例：`style(creator): 修复 Composer 贴边与诊断项无容器问题`、`feat(creator): 统一错误友好化展示为对话气泡与友好卡片`。
