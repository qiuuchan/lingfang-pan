# 输出渲染美化与代码块适配 — 执行计划

> 子任务：`06-13-output-rendering-polish`
> 父任务：`06-13-plugin-creator-conversational-revamp`（R4）
> 对应设计：`./design.md`
> 撰写日期：2026-06-13

---

## 1. 前置条件与依赖

### 1.1 子任务依赖关系（父 PRD 子任务地图第 71 行）

> 本子任务「独立，可与其它并行」。

- **无硬依赖**：不依赖 R1/R2/R3/R5 任一子任务先行。
- **软依赖**：手动渲染验证（步骤 5）需要一个能产出 fenced 代码块的 assistant 回复——若无 R1/R2 落地，可用「现有对话流 + 手工喂一段含 ```python 的 assistant 文本」做静态验证，不阻塞本子任务独立交付。
- **被依赖方**：R1（conversational-multiturn）的「assistant 流式态复用 Markdown」依赖本子任务提供的「同一 Markdown 组件可用于流式」能力（见 design 3.5）。

### 1.2 环境前置

- 工作目录：`O:/lingfang-platform`。
- 包管理：pnpm（前端）。
- Node/构建：`pnpm --filter @lingfang/desktop typecheck` / `build` 可用。
- 现状已确认：`apps/desktop/package.json:23-24` 有 `react-markdown@^10.1.0` + `remark-gfm@^4.0.1`；无任何高亮依赖。

### 1.3 文件改动清单（全在 `apps/desktop`）

| 文件                                       | 改动类型                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/package.json`                | 新增依赖 `rehype-highlight`                                                                                             |
| `apps/desktop/src/components/markdown.tsx` | 重写：import 依赖/CSS、抽 `PreBlock` + `CodeBlockActions` + `extractText`、重写 `code`/`pre` 映射、注入 `rehypePlugins` |

> 零后端改动、零契约改动、零迁移。`Bubble.tsx` / `LiveProcess.tsx` 不改。

---

## 2. 有序执行 checklist

每步均可独立验证，验证命令紧跟其后。

### 步骤 0：基线快照（验证前置）

- [ ] 记录基线：当前 `pnpm --filter @lingfang/desktop typecheck` 通过（零错误）。
  ```powershell
  pnpm --filter @lingfang/desktop typecheck
  ```
- [ ] 复核现状行号（与 design §2 一致）：`apps/desktop/src/components/markdown.tsx:15`（code）、`:16`（pre）、`:23`（ReactMarkdown 无 rehypePlugins）。

### 步骤 1：安装依赖

- [ ] 在 `apps/desktop` 安装 `rehype-highlight`（pnpm 自动带入 `lowlight` + `highlight.js` 子集）。
  ```powershell
  pnpm --filter @lingfang/desktop add rehype-highlight
  ```
- [ ] 验证：`apps/desktop/package.json` dependencies 出现 `rehype-highlight`；`pnpm-lock.yaml` 更新；`node_modules/highlight.js/styles/github-dark.css` 存在。
  ```powershell
  pnpm --filter @lingfang/desktop typecheck
  ```
  预期：仍零错误（仅装依赖不改代码）。

> Review Gate 1（依赖就绪）：确认 `rehype-highlight` 已入 package.json，highlight.js CSS 文件存在于 node_modules，typecheck 基线未被破坏。通过后再进入步骤 2。

### 步骤 2：改造 `markdown.tsx`（核心实现）

按 design §3.4 逐项落地，顺序如下（每小步后可 typecheck）：

- [ ] **2a** import 依赖与 CSS（design 3.4-A）：
  - 顶部新增 `import rehypeHighlight from 'rehype-highlight';`
  - 顶部新增 `import 'highlight.js/styles/github-dark.css';`
  - 新增 `import { useState } from 'react';`（复制按钮状态）
  - 新增 `import { CopyIcon, CheckIcon } from 'lucide-react';`（已在依赖）
  - 新增 `import { toast } from 'sonner';`（已全局可用）
  - 新增 `import { cn } from '@/lib/utils';`（若文件未引入）

- [ ] **2b** 新增私有工具 `extractText(node)`（design 3.4-B）：递归读 React 节点 `props.children`，返回拼接字符串。

- [ ] **2c** 新增 `CodeBlockActions` 组件（design 3.4-B）：
  - `useState<'idle'|'copied'>('idle')`
  - `onClick`：`navigator.clipboard.writeText(getText())` 成功 → setState 'copied' + `toast.success('已复制代码')` + 1.5s 后回 'idle'；失败 → 回退 `execCommand`，再失败 `toast.error('复制失败，请手动选取')`。
  - UI：`absolute right-2 top-2 opacity-0 transition group-hover:opacity-100`，CopyIcon/CheckIcon 切换。

- [ ] **2d** 新增 `PreBlock` 组件（design 3.4-D）：
  - 外层 `<div className="group relative my-1.5">` → `<CodeBlockActions getText={() => extractText(children)} />` → `<pre className="max-h-96 overflow-auto rounded-md bg-[#0d1117] p-3 text-xs font-mono leading-relaxed">{children}</pre>`。

- [ ] **2e** 重写 `COMPONENTS.code`（design 3.4-C）：
  - 签名 `code: ({ className, children, ...props })`（**不含 `inline`**，v10 已废弃）。
  - `const match = /language-(\w+)/.exec(className || '');`
  - 有 match → fenced：`<code className={cn('font-mono text-xs', className)} {...props}>{children}</code>`
  - 无 match → inline：`<code className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/10" {...props}>{children}</code>`

- [ ] **2f** 重写 `COMPONENTS.pre`：`pre: PreBlock`（传组件引用，使 hook 合法）。

- [ ] **2g** `ReactMarkdown` 注入 rehypePlugins（design 3.4-E）：
  - `<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={COMPONENTS}>{children}</ReactMarkdown>`

- [ ] 验证（步骤 2 整体）：
  ```powershell
  pnpm --filter @lingfang/desktop typecheck
  ```
  预期：零错误。重点：`Components` 类型匹配（无 `inline` prop 报错即说明签名正确）。

> Review Gate 2（代码改造完成）：typecheck 零错误；COMPONENTS 中 `code` 无 `inline` prop；`pre` 指向 `PreBlock` 组件引用（非内联箭头函数）；rehypePlugins 已注入。通过后进入步骤 3。

### 步骤 3：构建验证

- [ ] 全量构建，确认产物正常、CSS 被打包、无体积异常。
  ```powershell
  pnpm --filter @lingfang/desktop build
  ```
  预期：`vite build` 成功；产物含 highlight.js 子集（grep 产物或观察 chunk 体积增量在 ~30-50KB 量级，非 500KB+）。

> Review Gate 3（构建通过）：build 零错误；产物体积增量符合 rehype-highlight 量级（排除误装 shiki 级别体积）。

### 步骤 4：Tailwind v4 preflight 覆盖检查（风险 R4）

- [ ] 启动 dev，devtools 核验 `.hljs` computed color 来源。

  ```powershell
  pnpm --filter @lingfang/desktop dev
  ```
  - Elements → 选中任一 fenced 代码块内 `<span class="hljs-keyword">` → Computed `color` 应来自 `highlight.js/styles/github-dark.css`（如 `#ff7b72`），而非 Tailwind reset 的 inherit。
  - 若被覆盖：调整 CSS import 顺序（确保 hljs CSS 在 Tailwind base 之后），或对关键 hljs 选择器提升具体性。

- [ ] 验证通过后停止 dev（Ctrl+C）。

### 步骤 5：渲染人工核验（design §7.3 全 7 项）

- [ ] 触发一次含 fenced 代码块的 assistant 回复（若无 R1/R2，手工构造一段含 `python / `javascript / `json / `typescript 的 assistant 文本喂入 `<Markdown>`）。
- [ ] 逐项核验：
  - [ ] fenced 高亮（github-dark 配色）。
  - [ ] inline 区分（灰底药丸）。
  - [ ] 复制按钮（hover 显形 → 点击 → Check 图标 → toast → 粘贴内容完整含多行）。
  - [ ] 最大高度（>40 行代码纵向滚动）。
  - [ ] 横向滚动（单行超长不 wrap）。
  - [ ] 流式一致（流式过程已高亮，最终态一致）。
  - [ ] LiveProcess 不受影响（stdout 仍纯 pre 日志观感）。

> Review Gate 4（渲染验收）：design §7.3 的 7 项人工核验全过。任一项不过 → 回步骤 2 对应小步修正，不进入归档。

### 步骤 6：回归验证

- [ ] Bubble 三态回归（`apps/desktop/src/components/chat/Bubble.tsx`）：assistant 走 Markdown / user 纯文本 / error `whitespace-pre-wrap` 均正常。
- [ ] 全仓 `<Markdown` 消费面回归（Grep 确认所有调用点渲染正常，无新增报错）。
  - 用 Grep 工具搜 `<Markdown` 列出消费点，逐一目视。

### 步骤 7：剪贴板回退验证（风险 R5，Tauri webview 内）

- [ ] 在 Tauri webview（`pnpm --filter @lingfang/desktop dev` 启动 Tauri 壳）点击复制按钮：
  - 正常路径：`tauri://localhost` 满足 secure context，`navigator.clipboard` 生效。
  - 异常路径（若触发）：execCommand 回退生效；最终 toast 反馈成功/失败状态正确。

> Review Gate 5（回退容错）：剪贴板在 Tauri webview 可用；异常路径有合理回退与用户反馈。

### 步骤 8：归档前最终核对

- [ ] `pnpm --filter @lingfang/desktop typecheck` 零错误。
- [ ] `pnpm --filter @lingfang/desktop build` 零错误。
- [ ] design §7.3 七项 + 步骤 6 回归 + 步骤 7 剪贴板 全过。
- [ ] 代码注释为简体中文（commit 信息同）。
- [ ] 更新 `check.jsonl`（按 Trellis 规范记录检查结果）。

---

## 3. 契约变更顺序

**本子任务无契约变更。**

- 纯前端渲染层（`apps/desktop/src/components/markdown.tsx`）改造。
- 不触碰 `packages/contract`、不触碰后端、无 Prisma 迁移、无 RuntimeType / capabilities 字段变更。
- 因此**不适用 contract-first 流程**（contract-first 由 R2/R3 子任务负责）。

> 父 PRD 约束第 59 行「契约顺序：contract-first」针对涉及契约的子任务；本子任务属「独立渲染改造」，无契约面。

---

## 4. Review Gate 汇总

| Gate   | 位置      | 通过标准                                                                              | 失败动作                         |
| ------ | --------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| Gate 1 | 步骤 1 后 | rehype-highlight 入 package.json；hljs CSS 存在；typecheck 基线未破                   | 重装依赖 / 排查 pnpm             |
| Gate 2 | 步骤 2 后 | typecheck 零错误；code 无 inline prop；pre 指向 PreBlock 组件引用；rehypePlugins 注入 | 回对应小步（2a-2g）修正          |
| Gate 3 | 步骤 3 后 | build 零错误；体积增量 ~30-50KB 量级                                                  | 排查误装重依赖 / 构建配置        |
| Gate 4 | 步骤 5 后 | design §7.3 七项人工核验全过                                                          | 回步骤 2 对应小步修正            |
| Gate 5 | 步骤 7 后 | Tauri webview 剪贴板可用 + 异常回退有效                                               | 补 execCommand 回退 / toast 反馈 |

每个 Gate 失败即止（父 PRD 第 61 行「失败即止，禁带缺陷交付」），不跳过进入下一步。

---

## 5. 回滚点

### 5.1 回滚触发条件

- 任一 Review Gate 反复失败（连续 3 次，呼应全局 CLAUDE.md「连续三次失败必须暂停」）。
- 体积增量远超预期（如 >200KB，疑似误装全量 highlight.js 或 shiki）。
- Tailwind v4 preflight 覆盖无法解决且影响 inline 观感。

### 5.2 回滚步骤（design §5.3）

1. 还原 `apps/desktop/src/components/markdown.tsx` 为基线版本（`code`/`pre` 映射恢复 `markdown.tsx:15-16` 原样，移除 rehypeHighlight import / rehypePlugins / PreBlock / CodeBlockActions / extractText / CSS import）。
2. 卸载依赖：
   ```powershell
   pnpm --filter @lingfang/desktop remove rehype-highlight
   ```
3. 验证回滚干净：
   ```powershell
   pnpm --filter @lingfang/desktop typecheck
   pnpm --filter @lingfang/desktop build
   ```
   预期：零错误，回到基线观感（灰底药丸 code、无高亮、无复制按钮）。

### 5.3 回滚零风险声明

- 无契约联动、无数据迁移、无后端改动。
- 回滚后消费方（Bubble 等）零改动（Markdown 签名不变）。
- 回滚不阻塞其它子任务（本子任务独立）。

---

## 6. 与父任务 AC 的映射

| 父 AC                                                  | 本子任务贡献                                                                                          | 验证步骤                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------- |
| AC4 输出美化（代码块高亮、一键复制、流式与最终态一致） | 直接交付                                                                                              | 步骤 5（design §7.3 七项） |
| AC5 样式（长内容溢出有可见滚动指示）                   | fenced 块 max-h-96 + overflow-auto 提供滚动容器（可见性策略由 R5 全局滚动条负责，本子任务保证可滚动） | 步骤 5 第 4/5 项           |
| AC8 本地验证可重复                                     | 步骤 0-8 全可重复                                                                                     | 全流程                     |

> 注：AC1/AC2/AC3/AC6/AC7 由其它子任务交付，本子任务不直接贡献，但步骤 5 的「流式一致」与「LiveProcess 不受影响」为 AC2/AC3 提供渲染侧不回归保证。
