# 输出渲染美化与代码块适配 — 技术设计

> 子任务：`06-13-output-rendering-polish`
> 父任务：`06-13-plugin-creator-conversational-revamp`（对应 R4 输出渲染美化）
> 撰写日期：2026-06-13
> 撰写依据：父任务 PRD（`apps/desktop` 现状精确行号 + react-markdown v10 生态结论 + Tauri 体积约束）

---

## 1. 背景与目标

### 1.1 呼应父 PRD R4

父任务 PRD 第 42-46 行明确「R4 输出渲染美化」子任务四项目标：

1. 引入 `rehype-highlight`（`github-dark` 主题），代码块语法高亮覆盖 Node/Python/HTML/JS/TS 等常见语言。
2. 区分 inline code 与 fenced code block（react-markdown v10 用 className 正则，非已废弃的 `inline` prop）。
3. fenced 代码块带复制按钮（挂 pre 层、`navigator.clipboard`）、最大高度约束、横向滚动。
4. 流式过程中的 assistant 内容复用同一 Markdown 组件（含高亮），与最终态观感一致。

### 1.2 本子任务目标

为插件创建对话流提供「生产级代码块观感」：让 AI 回复中的 fenced 代码块获得语法高亮、一键复制、横向滚动、最大高度约束；让 inline code 与 fenced 代码块在视觉上明确区分；让流式增量渲染与最终态观感一致，且不引入超出 Tauri 桌面壳体积预算的高亮方案。

### 1.3 非目标（Out of Scope）

- 不跟随亮/暗主题切换高亮主题（父 PRD 决策 4：固定 `github-dark`）。
- 不为 LiveProcess 的 stdout/stderr 日志加语法高亮（其语义是「运行时日志」，非「代码」，保持纯 `pre`）。
- 不引入 token 级增量高亮引擎（仅当下游实测超长内容卡顿才作为后续优化）。
- 不承担 capabilities 契约修复、多轮 send_input、Node/Python 执行等其他子任务职责（本子任务「独立，可与其它并行」，见父 PRD 子任务地图第 71 行）。

---

## 2. 现状与问题

### 2.1 依赖现状

`apps/desktop/package.json:23-24`：

```json
"react-markdown": "^10.1.0",
"remark-gfm": "^4.0.1",
```

- 已有 `react-markdown` v10 与 `remark-gfm`。
- **缺失**：无 `rehype-highlight` / `prism` / `shiki` / `rehype-highlight` / `hljs` 任一高亮依赖。
- 无 `highlight.js`（rehype-highlight 的运行时依赖，pnpm 会作为间接依赖带入）。

### 2.2 Markdown 组件现状（`apps/desktop/src/components/markdown.tsx`）

`markdown.tsx:6-18` 的 `COMPONENTS` 映射：

- `code`（第 15 行）：`bg-black/10 px-1 py-0.5 font-mono text-[0.85em]` —— 不区分 inline / fenced，所有 code 元素同一灰底药丸样式。
- `pre`（第 16 行）：`overflow-auto rounded-md bg-black/10 p-2.5 font-mono text-xs` —— 无最大高度、无复制按钮、无横向滚动条策略、无语法高亮。
- `ReactMarkdown`（第 23 行）：仅 `remarkPlugins={[remarkGfm]}`，**无 `rehypePlugins`**。

问题：fenced 代码块（如 AI 产出的 manifest JSON、plugin.py、index.js）与 inline code 观感无差异，无高亮、无复制、长代码溢出无法约束。

### 2.3 消费方现状

- `apps/desktop/src/components/chat/Bubble.tsx:9`：assistant 走 `<Markdown>{content}</Markdown>`；user / error 走纯文本 `whitespace-pre-wrap`。
- `apps/desktop/src/components/chat/LiveProcess.tsx:23`：流式输出走纯 `<pre className="whitespace-pre-wrap break-words font-mono">`，**不经 Markdown**，且其语义为「运行日志」。
- 父 PRD R4 第 46 行要求「流式过程中的 assistant 内容复用同一 Markdown 组件（含高亮），与最终态观感一致」——即 assistant 气泡的流式态需走 Markdown，而非 LiveProcess 的日志 `pre`。

> 说明：LiveProcess 是「Node/Python 预览执行」的 stdout/stderr 终端面板（由 `06-13-node-python-local-exec` 子任务负责），语义与 assistant 对话气泡不同。本子任务只保证「assistant 气泡的流式态」走 Markdown；LiveProcess 不在本子任务改造范围。

### 2.4 react-markdown v10 关键事实（研究结论，已确认）

- react-markdown v9/v10 **已移除 `inline` prop**（react-shiki 官方文档 / shiki#829 确认）。旧的 `code({node, inline, ...props})` 写法在 v10 下编译报错或 `inline` 恒为 undefined。
- v10 的 fenced 代码块：外层 `pre` → 内层 `code` 带 `className="language-(\w+)"`；inline code 的 `code` 元素**无** `language-` 前缀 className。
- v10 PR#909 已 memoize unified processor，rehype-highlight 为同步轻量插件，逐 token 重渲染通常可接受；超长内容（>1 万行）才需 token 级增量优化。

### 2.5 体积对比结论（Tauri 桌面壳敏感）

| 方案                                                 | 体积                                | 备注                                                                                                                                 |
| ---------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **rehype-highlight**（lowlight + highlight.js 子集） | 核心 ~30KB + 按语言增量             | 默认捆绑 37 common 语言，含 js/ts/python/bash/json/html/css/sql/yaml/markdown/go/java/c/cpp/rust/php，与 react-markdown 同生态零摩擦 |
| shiki                                                | WASM(oniguruma) + grammar 500KB-1MB | 过重，Tauri 体积敏感场景排除                                                                                                         |
| react-syntax-highlighter (Prism)                     | 全量更重                            | 过重，排除                                                                                                                           |

**结论**：选 `rehype-highlight`，弃 shiki。

---

## 3. 技术方案

### 3.1 边界

- 改造文件：`apps/desktop/src/components/markdown.tsx`（核心）。
- 新增依赖：`rehype-highlight`（+ 其带入的 `lowlight` + `highlight.js` 子集）。
- 新增资源：`highlight.js/styles/github-dark.css`（Vite 原生支持 CSS import）。
- 消费方联动：`apps/desktop/src/components/chat/Bubble.tsx` 无需改（已走 `<Markdown>`）；assistant 流式态由调用方（`06-13-conversational-multiturn` 子任务 / PluginCreatorHome 的流式渲染分支）决定是否走 Markdown——本子任务提供「同一 Markdown 组件可用于流式」的能力保证，并明确语义边界（见 3.4）。

### 3.2 契约 / 接口

本子任务**不涉及 packages/contract 契约变更**（纯前端渲染层改造）。Markdown 组件对外签名保持不变：

```ts
// apps/desktop/src/components/markdown.tsx
export function Markdown({ children }: { children: string }): JSX.Element;
```

内部增强（对调用方透明）：

- 注入 `rehypePlugins`。
- `code` / `pre` 组件映射重写。

### 3.3 数据流

````
AI 文本（含 ```lang 围栏）
  → ReactMarkdown（remark-gfm 解析 GFM）
  → rehype-highlight（同步遍历 hast，对带 language-* 的 code 注入 hljs-* class span）
  → components 映射
      ├─ pre（fenced 容器）：max-h-96 overflow-auto、横向滚动、右上角 Copy 按钮
      └─ code：
           ├─ 有 language-X className → fenced 代码：hljs span 接管着色（仅设透明背景/继承字体）
           └─ 无 language-* className → inline 代码：bg-black/10 rounded px-1
  → highlight.js/styles/github-dark.css（全局生效，给 .hljs / .hljs-keyword 等上色）
````

### 3.4 组件拆分与改造点（`markdown.tsx`）

#### A. 依赖与样式 import（顶部）

```ts
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
// 固定 github-dark 主题（父 PRD 决策 4：暂不跟随亮/暗切换）
import 'highlight.js/styles/github-dark.css';
```

#### B. 复制按钮子组件（新增，模块内私有）

新增 `CodeBlockActions`（或内联于 pre 映射）：

- 用 `useState<'idle' | 'copied'>` 切换 `CopyIcon` / `CheckIcon`（lucide-react 已在依赖中，`lucide-react ^1.17.0`，见 `apps/desktop/package.json:19`）。
- 复制动作：`navigator.clipboard.writeText(text)`；成功 → `toast.success('已复制代码')`；失败 → 回退（见 6.x 风险项）。
- 提取文本：从 pre 的子节点递归读取 `textContent`，**不依赖单 span**（研究结论：复制按钮误挂 code 内会取不到完整文本，必须 pre 层 + 读 textContent）。

实现文本提取的工具函数（模块内私有，避免重复造轮子；如 utils 已有则复用，本子任务检索确认 `apps/desktop/src/lib/utils.ts:1-7` 仅有 `cn`，故新建私有 helper）：

```ts
function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    // 递归读取 React 元子的 children
    return extractText((node as React.ReactElement).props?.children);
  }
  return '';
}
```

#### C. `code` 组件映射重写（区分 inline / fenced）

```ts
code: ({ className, children, ...props }) => {
  // react-markdown v10：fenced code 带 language-(\w+) className；inline code 无。
  const match = /language-(\w+)/.exec(className || '');
  if (match) {
    // fenced 代码：交给 hljs span 着色，code 元素只设继承字体，不再加背景药丸
    return (
      <code className={cn('font-mono text-xs', className)} {...props}>
        {children}
      </code>
    );
  }
  // inline 代码：维持原灰底药丸观感
  return (
    <code className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/10" {...props}>
      {children}
    </code>
  );
},
```

#### D. `pre` 组件映射重写（复制按钮 + 最大高度 + 横向滚动）

```ts
pre: ({ children }) => (
  <div className="group relative my-1.5">
    <CodeBlockActions getText={() => extractText(children)} />
    <pre className="max-h-96 overflow-auto rounded-md bg-[#0d1117] p-3 text-xs font-mono leading-relaxed">
      {children}
    </pre>
  </div>
),
```

要点：

- 复制按钮挂在外层 `<div>`（pre 的包装层），**不挂 code 内**——避免每个 hljs span 重复挂按钮、避免取不到完整文本。
- `max-h-96`（384px）约束纵向高度，超长代码纵向滚动。
- `overflow-auto`（含 `overflow-x-auto`）横向滚动长行，**不 wrap**（去掉原无 wrap 但无横向滚动条的问题；配合全局滚动条策略，本子任务保证 `overflow-auto` 即可见性由 R5 全局滚动条策略负责，但本子任务的 pre 必须先给到 `overflow-auto` 才能滚动）。
- `bg-[#0d1117]` 对齐 github-dark 主题底色（github-dark CSS 默认透明背景，需显式给底色保证 inline 暗色块观感）。
- `group` + 按钮 `opacity-0 group-hover:opacity-100` 仅 hover 显形，避免常态视觉干扰。

#### E. `ReactMarkdown` 注入 rehypePlugins

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
  components={COMPONENTS}
>
  {children}
</ReactMarkdown>
```

- `detect: false`：不自动猜测无 lang 标注的代码语言（避免误判，符合「fenced 才高亮」语义）。
- `ignoreMissing: true`：未识别语言不抛错（容错，配合 6.x 风险「流式未闭合代码块可能抛 illegal token」）。
- 注：`ignoreMissing` 是 lowlight/highlight.js 未注册语言时的容错；流式中途的「未闭合围栏」由 react-markdown 自身解析容错（不完整围栏会被当普通文本渲染，下一 token 补全后重渲染）。

### 3.5 流式高亮策略

- assistant 气泡流式态：调用方对同一份累积文本反复渲染 `<Markdown>{streamingText}</Markdown>`。rehype-highlight 同步执行，每 token 重渲染。react-markdown v10 PR#909 已 memoize processor，重渲染成本可接受。
- 超长内容（实测 >1 万行）若出现卡顿，预留节流降级点：调用方对 streamingText 做 50-100ms 节流后再渲染（**本子任务不实现节流**，仅在 design 标注为后续优化入口；若 R3/R1 子任务实测卡顿再补）。
- LiveProcess（`LiveProcess.tsx:23`）保持纯 `pre`，**不加高亮**（语义为运行日志）。

---

## 4. 关键决策与权衡

### 4.1 已确认的用户决策（父 PRD）

| 决策项   | 决策内容                                                                           | 出处                                   |
| -------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| 高亮主题 | 固定 `github-dark`，暂不跟随亮/暗切换                                              | 父 PRD 决策 4（第 18 行）、R4 第 43 行 |
| 区分方式 | react-markdown v10 用 className 正则（`language-(\w+)`），非已废弃的 `inline` prop | 父 PRD R4 第 44 行                     |

### 4.2 本子任务的技术权衡

| 决策点         | 选择                                      | 理由                                                                                                                   |
| -------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 高亮引擎       | rehype-highlight（非 shiki / 非 Prism）   | Tauri 体积敏感；rehype-highlight ~30KB 级，与 react-markdown 同生态零摩擦；shiki WASM 500KB-1MB 过重                   |
| 复制按钮挂载层 | pre 包装层 `<div>`（非 code 内）          | code 内会随每个 hljs span 重复挂载且取不到完整文本；pre 层 + `extractText(children)` 才能拿到整块代码                  |
| 文本提取       | 递归读 React 节点 `props.children`        | react-markdown v10 传给 pre 的是 React 元子树（含 hljs span），非纯字符串，必须递归                                    |
| 最大高度       | `max-h-96 overflow-auto`                  | 384px 足够覆盖常见代码块，超长纵向滚动，不撑爆气泡                                                                     |
| 横向滚动       | `overflow-auto`（含 x），不 wrap          | 长行代码 wrap 会破坏可读性与对齐，横向滚动 + 可见滚动条策略                                                            |
| inline 背景    | 维持 `bg-black/10`（dark: `bg-white/10`） | 保持现有 inline 观感不变，仅 fenced 走暗色高亮块                                                                       |
| fenced 底色    | 显式 `bg-[#0d1117]`                       | github-dark CSS 默认透明，需显式底色保证暗色块观感（桌面壳固定浅色主题，见 `sonner.tsx:8` 注释「桌面壳固定浅色主题」） |
| 语言探测       | `detect: false` + `ignoreMissing: true`   | 不误猜、未注册语言不抛错，容错流式中途状态                                                                             |

### 4.3 复用优先（呼应父 PRD 约束第 58 行）

- 复用 `cn`（`apps/desktop/src/lib/utils.ts:4`）做 className 合并。
- 复用 `lucide-react` 的 `CopyIcon` / `CheckIcon`（已在依赖，`lucide-react ^1.17.0`）。
- 复用 `sonner` 的 `toast`（`apps/desktop/src/components/ui/sonner.tsx` 已 export，`App.tsx:236/281` 已挂载 `Toaster`，全局可用）。
- 复用 `react-markdown` + `remark-gfm` 既有管线，仅追加 `rehype-highlight` 一个插件。
- **不**重复造轮子：不引入 `react-syntax-highlighter` / `prism-react-renderer` 等重复高亮库。

---

## 5. 兼容性 / 迁移 / 回滚形状

### 5.1 对外接口兼容

- `Markdown({ children })` 签名不变，所有消费方（`Bubble.tsx:9` 等）零改动。
- `COMPONENTS` 内部从常量改为带状态的 `pre` 映射（因复制按钮需 `useState`），需将 `pre` 从对象字面量静态映射改为「在组件函数体内构造」或「抽成独立 `<PreBlock>` 组件」。本子任务采用**抽成独立 `PreBlock` 组件**（hooks 必须在组件函数体内调用，不能在模块级静态映射里用 hook）。

> 实现注意：react-markdown 的 `components` 中每个映射值必须是组件函数。`pre: PreBlock`（传组件引用）即可，PreBlock 内部用 `useState` 合法。

### 5.2 破坏性变更

- 无契约破坏（纯前端渲染层）。
- fenced 代码块观感从「灰底药丸」变为「暗色高亮块 + 复制按钮」——这是预期改进，非回退项。

### 5.3 回滚形状

回滚 = 移除 `rehype-highlight` 注入 + 还原 `code`/`pre` 映射为 `markdown.tsx:15-16` 原样 + 移除 CSS import + 卸载依赖。具体：

1. 删除 `markdown.tsx` 中 `rehypeHighlight` import、`rehypePlugins` prop、`PreBlock` 组件、`CodeBlockActions`、`extractText`。
2. 还原 `code` / `pre` 映射为原始两行。
3. 删除 `'highlight.js/styles/github-dark.css'` import。
4. `pnpm remove rehype-highlight`（lowlight / highlight.js 作为间接依赖随之移除）。
5. `pnpm typecheck` 通过即回滚完成。

回滚零数据风险、零契约联动。

---

## 6. 安全与风险

> 父任务 PRD 第 40 行明确「安全边界：本轮 sandbox 仅软隔离（用户权限运行），design 必须标注后续 OS 级隔离为独立大任务」——该约束针对 R3（Node/Python 执行），**本子任务（R4 渲染）不涉及子进程执行**，无执行面安全风险。以下为本子任务自身的渲染面风险。

### 6.1 风险清单

| #   | 风险                                                                       | 触发条件                             | 缓解                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | react-markdown v10 无 `inline` prop，旧写法编译报错                        | 直接照搬 `code({node, inline, ...})` | 用 className 正则 `language-(\w+)` 区分（见 3.4-C）                                                                                                                        |
| R2  | 复制按钮误挂 code 内 → 重复挂载 / 取不到完整文本                           | 在 `code` 映射里放按钮               | 按钮只挂 pre 包装层 `<div>`，用 `extractText(children)` 递归取整块文本（见 3.4-B/D）                                                                                       |
| R3  | 忘记 import `highlight.js/styles/github-dark.css` → 有 hljs class 但无颜色 | 仅装依赖不引 CSS                     | 显式 `import 'highlight.js/styles/github-dark.css'`（见 3.4-A）                                                                                                            |
| R4  | Tailwind v4 preflight 重置 `.hljs` 类样式                                  | Tailwind v4 base reset 覆盖 hljs CSS | Vite CSS import 顺序：hljs CSS 在 Tailwind 之后引入，或用 `@layer`；实测若被覆盖，用具体性更高的选择器或 `!` 前缀。验证步骤含此检查（见 7.x）                              |
| R5  | `navigator.clipboard` 在 Tauri webview 不可用                              | webview 非 secure context            | Tauri `tauri://` 协议通常满足 secure context；回退 `document.execCommand('copy')`（含隐藏 textarea），再不行静默 + toast 提示「复制失败，请手动选取」（见 3.4-B 失败分支） |
| R6  | 流式中途未闭合围栏 / 非法 token 抛错                                       | token 切在 ``` 中间                  | `rehype-highlight` 传 `ignoreMissing: true` + `detect: false`；react-markdown 自身对未闭合围栏按普通文本渲染，下 token 补全后重渲染（见 3.4-E）                            |
| R7  | 超长内容（>1 万行）流式卡顿                                                | manifest 巨大 / 长代码               | 预留调用方节流降级点（50-100ms），本子任务不实现，仅标注（见 3.5）                                                                                                         |
| R8  | hljs 默认 37 语言不含目标语言（如纯 shell 无 `sh` 别名）                   | 某语言未注册                         | `ignoreMissing: true` 容错降级为无高亮纯文本；常见语言（js/ts/python/bash/json/html/css/sql/yaml/go/java/c/cpp/rust/php）已含，覆盖本任务需求                              |

### 6.2 软隔离边界声明（呼应父 PRD 安全约束）

- 本子任务**不执行任何子进程**，不涉及 Node/Python 代码运行。
- 代码块内容仅被「渲染 + 复制到剪贴板」，无 eval、无 iframe srcdoc 执行。
- 复制到剪贴板的内容由 AI 产出，用户主动粘贴使用，无自动注入执行面。
- OS 级沙箱隔离属于 R3（`06-13-node-python-local-exec`）的独立大任务，本子任务不触碰。

---

## 7. 验证策略（本地可重复）

### 7.1 类型检查

```powershell
pnpm --filter @lingfang/desktop typecheck
```

预期：零错误。重点验证 `code` / `pre` 映射签名符合 react-markdown v10 `Components` 类型（无 `inline` prop）。

### 7.2 依赖安装与产物体积

```powershell
pnpm --filter @lingfang/desktop add rehype-highlight
pnpm --filter @lingfang/desktop build
```

预期：`vite:build` 成功；产物含 highlight.js 子集，体积增量在 ~30-50KB 量级（非 shiki 的 500KB+）。

### 7.3 渲染验证（手动，本地可重复）

在 PluginCreatorHome 触发一次 assistant 回复（含 fenced 代码块），人工核验：

1. **fenced 高亮**：`python / `javascript / `json / `typescript 代码块有 github-dark 配色（关键字着色）。
2. **inline 区分**：行内 `` `code` `` 仍是灰底药丸，非暗色高亮块。
3. **复制按钮**：hover fenced 块右上角出现 Copy 图标 → 点击 → 图标变 Check → toast「已复制代码」→ 粘贴验证内容完整（含多行）。
4. **最大高度**：粘贴一段 >40 行代码，块纵向出现滚动条，不撑爆气泡。
5. **横向滚动**：单行超长代码横向滚动，不 wrap。
6. **流式一致**：流式过程中 fenced 块已高亮（每 token 重渲染），最终态观感与流式一致。
7. **LiveProcess 不受影响**：Node/Python 预览 stdout 仍为纯 `pre` 日志观感（无高亮）。

### 7.4 回归验证

- `apps/desktop/src/components/chat/Bubble.tsx` 渲染 assistant / user / error 三态无回归（user 仍纯文本、error 仍 `whitespace-pre-wrap`）。
- 其它使用 `<Markdown>` 的位置（grep 全仓 `<Markdown` 确认消费面）无回归。

### 7.5 Tailwind v4 preflight 覆盖检查（风险 R4）

```powershell
pnpm --filter @lingfang/desktop dev
```

打开 devtools → Elements → 选中 `.hljs` 元素 → Computed 核验 `color` 来自 highlight.js CSS 而非被 Tailwind reset 覆盖为 inherit。若被覆盖，按 6.1-R4 缓解调整 CSS 引入顺序。

### 7.6 剪贴板回退验证（风险 R5）

在 Tauri webview 内运行（`pnpm --filter @lingfang/desktop dev` 启动 Tauri），点击复制按钮：

- 正常：`tauri://localhost` 满足 secure context，`navigator.clipboard.writeText` 生效。
- 异常（极少数 webview 配置）：回退 `execCommand`，验证仍能复制；最终 toast 反馈成功/失败。

### 7.7 失败即止

父 PRD 约束第 61 行「失败即止，禁带缺陷交付」：7.1 typecheck 失败、7.2 build 失败、7.3 任一人工核验项不过 → 立即停止，回到设计修正，不进入归档。
