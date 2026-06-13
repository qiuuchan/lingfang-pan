# 代码助手结构化输出与解析 — 技术设计

> 子任务：`06-13-structured-output-parsing`（父任务 `06-13-plugin-creator-conversational-revamp` 的 R2，也是整树的**核心基础**）。
> 本文聚焦「让 CLI 真正产出结构化插件包 + 前端正确解析 + 修复 capabilities 契约 bug」，为 R1 多轮迭代与 R3 Node/Python 语言扩展提供结构化产出底座。

## 1. 背景与目标

### 1.1 呼应父 PRD R2

父 PRD《插件创建对话式重构与语言扩展》R2 要求：

- CLI 真正产出符合契约的结构化插件包（`manifest.json` + 多文件代码），前端解析采用，**不再硬编码兜底覆盖**。
- 采用「文本内约定标记」协议（` ```lingfang-manifest json` / ` ```file path=` / ` ```lingfang-notes`），跨三 CLI 零适配。
- 容错：部分缺失用前端兜底补全，完全失败退回当前行为并标记 `invalid`。
- **修复 capabilities 契约 bug**：产出对象数组 `{kind,reason,risk,requires_admin,scope?}`，kind 命中白名单，**绝不再用裸 `code-assistant`**；`uploadCloud` 流程不再被后端 400 拒绝。

### 1.2 本子任务目标

1. 把模型输出从「纯文本当兜底」升级为「按协议产出三类围栏块 → 前端结构化解析 → CLI 字段优先 + 前端兜底补全」。
2. 新增纯函数 `parseStructuredPackage` 与 `normalizeCapabilities`，集中处理解析与契约收敛。
3. 重构 `buildLocalDraft` 接入新解析器，状态判定细化为 `ready/partial/invalid`，诊断新增 `schema` stage。
4. 替换 `PluginCreatorHome.tsx` 的 `systemPrompt` 为协议化提示，跨三 CLI（claude/codex/opencode）零适配。
5. 修复 capabilities 字符串数组形态导致的 `uploadCloud` 必然 400 的 bug。

### 1.3 非目标（明确排除）

- **不**改后端 `code_assistant.rs`（桌面 Tauri command 层）：systemPrompt 拼接（`code_assistant.rs:285-287`）、`OutputFormat` 分派（`code_assistant.rs:373-374`）、`extract_stream_json_text`（`code_assistant.rs:550`）、`spawn_reader`（`code_assistant.rs:574`）保持不变。后端已支持把 systemPrompt 拼进单字符串 prompt 传给 CLI，协议化只改 prompt 文本即可。
- **不**改 `packages/contract` 的 `PluginManifest`/`PluginCapability`/`CapabilityKind`（契约已正确，bug 在前端产出物，不在契约本身）。
- **不**改后端 `plugin-package.ts` 的 `normalizePluginPackage` 白名单/校验（后端是契约守门人，保持严格）。
- **不**处理多轮（R1）、Node/Python 运行时执行（R3）、输出渲染美化（R4）、样式（R5）。
- **不**改 RuntimeType 四值扩展（属于 R3 契约子任务，本子任务 runtime_type 仅沿用现有 `client|cloud`）。

## 2. 现状与问题（精确 file:line）

### 2.1 前端把 CLI 输出当纯文本兜底，丢弃结构化产出

`apps/desktop/src/lib/plugin-draft.ts`：

- `buildLocalDraft`（`:186-243`）直接 `extractCliText` 取 stdout/stderr 尾部文本（`:187`，经 `tailText` 截断 12000 字符 `:166-168`），作为 `escapedOutput` 塞进固定 `ui/index.html` 的 `<pre>`（`:200-224`）。manifest 在 `:190-199` 硬编码，与 CLI 真正输出无关。
- `extractCliText`（`:119-121`）只取尾部纯文本。
- `parseManifest`（`:255-272`）：从 `files` 里找 `manifest.json` 做 `JSON.parse`，但 `capabilities` 原样透传（`:267`），**不做任何校验/归一化**，字符串数组形态会直接穿透。
- `previewSrcDoc`（`:274-285`）依赖 `parseManifest` 拿到 `entry`，找对应文件内容渲染。

### 2.2 systemPrompt 是纯写作文提示

`apps/desktop/src/pages/PluginCreatorHome.tsx`：

- `systemPrompt`（`:240`）当前为字符串：`'请基于以下需求创建一个 LingFang 插件草稿。请给出插件目标、核心交互、文件结构和关键实现建议。'`，未要求任何结构化产出协议。
- 经 `tauriInvoke('code_assistant_start_session', { input: { ..., prompt: text, systemPrompt } })`（`:241-248`）传给后端。

### 2.3 后端 prompt 拼接（不变，仅说明链路）

`apps/desktop/src-tauri/src/code_assistant.rs`：

- systemPrompt 拼接（`:285-287`）：`format!("{sys}\n\n---\n\n{}", input.prompt)` 作为单字符串 prompt 传给 CLI。systemPrompt 文本只要符合协议即可，后端无需改动。
- `OutputFormat` 分派（`:373-374`）：claude 用 `StreamJson`（经 `extract_stream_json_text` `:550` 提取），codex/opencode 用 `Plain`。**结论：协议不依赖任何 CLI 的特殊输出格式**，统一走 stdout 文本，三类围栏块协议对三 CLI 一视同仁。

### 2.4 契约目标（已正确，无需改）

`packages/contract/src/plugin.ts`：

- `PluginManifest`（`:29-39`）：`id/name/version/description/runtime_type/entry/visibility` + `capabilities: PluginCapability[]`。
- `PluginCapability`（`:19-26`）：`{kind, reason?, risk?, requires_admin?, scope?}`。
- `CapabilityKind` 白名单（`:7-13`）：含 `code-assistant.run`、`code-assistant.session`，**无裸 `code-assistant`**。

### 2.5 后端契约守门（已严格，无需改）

`apps/collab-api/src/modules/plugin-package.ts`：

- `ALLOWED_CAPABILITIES`（`:48-53`）：与契约白名单一致，含 `code-assistant.run/session`，无裸 `code-assistant`。
- `normalizePluginPackage`（`:71-134`）：
  - capabilities 必须是对象数组（`:102-114`），`capability?.kind` 取不到则 `kind=''`，白名单 `has('')` 必 false → `throw badRequest('插件能力不在允许范围内')`（`:104`）。
  - `entry` 必须存在（`:101`，经 `cleanPath` `:61-69` 校验，禁绝对路径/`..`/隐藏段）。
  - 单文件 256KB / 总 80 文件 / 总量 2MB 限制（`:45-47`）。

### 2.6 关键 bug 链路（当前 `uploadCloud` 必然 400）

```
buildLocalDraft 产 capabilities: ['code-assistant']  (plugin-draft.ts:198，字符串数组 + 非法 kind)
  → parseManifest 透传不校验                        (plugin-draft.ts:267)
  → uploadCloud POST /api/plugins/upload            (PluginCreatorHome.tsx:297-300)
  → 后端 capability?.kind 得 undefined              (plugin-package.ts:103)
  → ALLOWED_CAPABILITIES.has('') === false
  → throw badRequest('插件能力不在允许范围内')      (plugin-package.ts:104)
  → 前端 toast.error((error as ApiError).message)   (PluginCreatorHome.tsx:306)
```

**根因**：前端产出物 `capabilities` 用了字符串数组形态（`['code-assistant']`），既不符合契约对象数组形态，其字符串值 `code-assistant` 也不在白名单（白名单是 `code-assistant.run`/`.session`）。

## 3. 技术方案

### 3.1 总体边界

```
┌─────────────────────────────────────────────────────────────┐
│ PluginCreatorHome.tsx (UI 层)                                │
│  - systemPrompt 替换为协议化提示常量(新增 plugin-creator-protocol.ts)│
│  - send() 调用 buildLocalDraft 时传入协议化 systemPrompt        │
│  - uploadCloud 不变(契约修复在产出端)                          │
└──────────────────────────┬──────────────────────────────────┘
                           │ CliProbeResult.stdout/stderr
┌──────────────────────────▼──────────────────────────────────┐
│ plugin-draft.ts (纯函数层)                                    │
│  - parseStructuredPackage(rawText)  [新增] 围栏块解析         │
│  - normalizeCapabilities(parsed, fallback)  [新增] 契约收敛  │
│  - cleanPathFrontend(path)  [新增] 前端版路径校验            │
│  - buildLocalDraft  [重构] 接入新解析器                       │
│  - parseManifest  [复用 normalizeCapabilities]               │
│  - previewSrcDoc  [不变,依赖 parseManifest]                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ 不变
┌──────────────────────────▼──────────────────────────────────┐
│ packages/contract/src/plugin.ts  (契约层,不改)               │
│  PluginManifest / PluginCapability / CapabilityKind (zod)    │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 契约 / 接口定义

#### 3.2.1 协议化提示（新增常量，复用复用优先）

新建 `apps/desktop/src/lib/plugin-creator-protocol.ts`（与 `plugin-draft.ts` 同目录，纯文本常量 + 协议解析纯函数，便于单测）：

```ts
// 提示模型按协议产出的 systemPrompt（跨三 CLI 零适配，仅用 fenced code block）
export const PLUGIN_CREATOR_SYSTEM_PROMPT = `你是一名 LingFang 插件工程师。请严格按以下协议产出插件包，使用三类围栏代码块（fenced code block），不要在块外输出关键信息：

1. manifest 块（必填，恰好一个）：
\`\`\`lingfang-manifest json
{ "id": "...", "name": "...", "version": "0.1.0", "description": "...",
  "runtime_type": "client", "entry": "ui/index.html", "visibility": "tenant",
  "capabilities": [{ "kind": "code-assistant.run", "reason": "...", "risk": "low", "requires_admin": false }] }
\`\`\`

2. 文件块（每个文件一个，至少包含 entry 指向的文件）：
\`\`\`file path="ui/index.html"
<文件内容>
\`\`\`

3. 说明块（可选，给用户的自然语言说明）：
\`\`\`lingfang-notes
<说明>
\`\`\`

约束：
- capabilities 的 kind 必须取自白名单：ui.view / fs.pick / fs.read / fs.write / net.fetch / clipboard / llm.chat / storage.kv / system.info / system.screenshot / system.notify / code-assistant.run / code-assistant.session / plugin.upload / plugin.submitMarketplace；不要用裸 "code-assistant"。
- 文件 path 必须为相对路径，不含绝对路径前缀、..、隐藏段（不以 . 开头）。
- entry 必须指向一个真实产出的文件块。`;

// 围栏块 info string → 类型分类（兼容裸 ``` 无 info 的退化情况）
export type StructuredBlockKind = 'manifest' | 'file' | 'notes' | 'unknown';

export interface StructuredBlock {
  kind: StructuredBlockKind;
  info: string;            // 原始 info string
  language?: string;       // 推断语言(json/html/...)
  path?: string;           // file 块的 path
  content: string;         // 块内文本（去围栏）
  start: number;           // 在原文中的字符偏移（诊断用）
}

// 协议 info string 识别（classifying info string）
export function classifyBlockInfo(info: string): StructuredBlockKind;
```

#### 3.2.2 新增 `parseStructuredPackage`（纯函数）

新增于 `apps/desktop/src/lib/plugin-draft.ts`：

```ts
import { PluginManifest } from '@lingfang/contract';
import type { DraftFile, DraftDiagnostic } from '@/lib/types';

export interface ParsedStructuredPackage {
  manifest: Partial<PluginManifest> | null;  // 解析失败为 null
  files: DraftFile[];                          // 同 path 后者覆盖
  notes: string;                               // notes 块拼接
  rawBlocks: StructuredBlock[];                // 原始块（诊断用）
  diagnostics: DraftDiagnostic[];              // schema stage 诊断
  status: 'ready' | 'partial' | 'invalid';     // 总体判定
  manifestJson: string | null;                 // 序列化的 manifest.json 内容
}
```

**解析算法（确定性、可单测）**：

1. 用正则遍历全文，匹配所有 fenced code block。正则需处理三类结束判定：
   - 规范块：` ```info\n...\n``` `（info 在起始反引号行）。
   - 裸块：` ```\n...\n``` `（无 info），归类 `unknown`，参与兜底归类（见步骤 4）。
   - 围栏嵌套（块内含 ` ``` `）：取**从当前起始到下一个未被消费的结束围栏**，避免误截断；若块内出现 ` ``` ` 导致提前结束，则在 `diagnostics` 标记 `schema/fail: 围栏可能被截断`，并把截断后剩余文本兜底归入 `unknown` 块继续解析。
2. 对每个块，`classifyBlockInfo(info)` 分类：
   - info 以 `lingfang-manifest` 开头 → `manifest`。
   - info 以 `file` 开头 → `file`，从 info 提取 `path="..."`（支持单/双引号与裸 token）。
   - info 以 `lingfang-notes` 开头 → `notes`。
   - 其余 → `unknown`。
3. **manifest 块**：`JSON.parse(content)` → zod `PluginManifest.safeParse`（**复用契约层 zod**，不重复造校验）。多个 manifest 块取最后一个（模型修正），多余的在 diagnostics 标记 warning。`safeParse` 失败则 manifest 置 null 并记 fail。
4. **file 块**：提取 path，经 `cleanPathFrontend`（与后端 `plugin-package.ts:61-69` 对齐：去反斜杠、禁绝对/`~`/盘符、禁空段/`.`/`..`/隐藏段）校验，非法 path 记 fail 并丢弃该块。**同 path 后者覆盖前者**（用 Map 维护）。
5. **unknown 块**：候选归类——若 info 是已知语言标识（`html/js/ts/jsx/tsx/python/py/node`）或内容含 `<html`/`<!doctype`，且当前无 entry 文件，归为 `ui/index.html`；其余按 `snippet-N`（N 自增）命名。保证「模型只输出裸代码块」时也能拿到至少一个文件。
6. **状态判定**：
   - `ready`：manifest 块解析成功 且 entry 指向的文件存在于 files。
   - `partial`：manifest 解析成功但 entry 文件缺失，或 manifest 部分字段缺失（由 buildLocalDraft 兜底补全后可上传）。
   - `invalid`：无 manifest 块或 JSON.parse 完全失败。
7. **字节预算检查**（parse 末尾）：累加所有 file content 的 `Buffer.byteLength`/`new TextEncoder().encode().length`，若总字节超 2MB（与后端 `MAX_PLUGIN_TOTAL_BYTES` `:47` 对齐），status 强制降为 `invalid` 并记 fail（避免产出超大包后端必然 400）。单文件超 256KB 同样降级。

#### 3.2.3 新增 `normalizeCapabilities`（纯函数，契约收敛）

新增于 `apps/desktop/src/lib/plugin-draft.ts`，**`buildLocalDraft`（`:190-199`）与 `parseManifest`（`:267`）都复用此函数**，避免两处分别手写导致再次漂移：

```ts
import { CapabilityKind } from '@lingfang/contract';

// 合法 capabilities 白名单（前端镜像，用于产出端收敛；权威在后端 plugin-package.ts:48-53）
const FRONTEND_CAPABILITY_KINDS = new Set<CapabilityKind>([
  'ui.view', 'fs.pick', 'fs.read', 'fs.write', 'net.fetch',
  'clipboard', 'llm.chat', 'storage.kv',
  'system.info', 'system.screenshot', 'system.notify',
  'code-assistant.run', 'code-assistant.session',
  'plugin.upload', 'plugin.submitMarketplace',
]);

// 合法 risk 取值（前端镜像后端 plugin-package.ts CapabilityRisk；契约 plugin.ts:16）
const FRONTEND_CAPABILITY_RISKS = new Set(['none', 'low', 'medium', 'high']);

const FALLBACK_CAPABILITY = {
  kind: 'code-assistant.run' as const,
  reason: '本地代码助手执行',
  risk: 'medium' as const,
  requires_admin: false,
};

export function normalizeCapabilities(
  parsed: unknown,
  fallback = FALLBACK_CAPABILITY,
): PluginCapability[] {
  // 1. 合法对象数组：过滤掉 kind 不在白名单的项，risk 缺省补 'low'
  if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((c) => c && typeof c === 'object' && typeof c.kind === 'string' && FRONTEND_CAPABILITY_KINDS.has(c.kind as CapabilityKind))) {
    return parsed.map((c: any) => ({
      kind: c.kind,
      reason: typeof c.reason === 'string' ? c.reason : '',
      risk: FRONTEND_CAPABILITY_RISKS.has(c.risk) ? c.risk : 'low',
      requires_admin: Boolean(c.requires_admin),
      ...(c.scope === undefined ? {} : { scope: c.scope }),
    }));
  }
  // 2. 退化形态（字符串数组 / 部分非法）：丢弃并兜底
  return [fallback];
}
```

> 说明：`fallback` 的 `kind` 固定取 `code-assistant.run`（白名单内），`risk: medium`（本地代码助手执行属中等风险）。**绝不**兜底为裸 `code-assistant`（白名单外）。

#### 3.2.4 新增 `cleanPathFrontend`（纯函数）

与后端 `plugin-package.ts:61-69` 行为对齐，复用于 file 块校验：

```ts
// 前端版 cleanPath：与后端 plugin-package.ts:61-69 对齐，产出端提前收敛
export function cleanPathFrontend(path: string): { ok: true; value: string } | { ok: false; reason: string };
```

返回 discriminated union（不 throw，把非法 path 记进 diagnostics 而非中断解析，与「容错」目标一致）。

#### 3.2.5 重构 `buildLocalDraft`（plugin-draft.ts:186-243）

```
buildLocalDraft(input):
  output = extractCliText(input.result)            // 不变
  parsed = parseStructuredPackage(output)           // 新：协议解析
  id = `local-${tool}-${ts}`                        // 不变
  pluginId = safePluginId(prompt)                   // 不变

  // CLI 字段优先 + 前端兜底补全
  manifest = {
    id:          parsed.manifest?.id || pluginId,
    name:        parsed.manifest?.name || prompt.slice(0,24) || '本地代码助手插件',
    version:     parsed.manifest?.version || '0.1.0',
    description: parsed.manifest?.description || `由 ${providerLabel} 本地 CLI 生成的插件草稿`,
    runtime_type: parsed.manifest?.runtime_type || 'client',   // 本子任务仅 client|cloud
    entry:       parsed.manifest?.entry || LOCAL_DRAFT_ENTRY,
    visibility:  parsed.manifest?.visibility || 'tenant',
    capabilities: normalizeCapabilities(parsed.manifest?.capabilities),  // 契约收敛
  }

  // entry 缺失自动兜底页 + warning
  files = parsed.files
  if (!files.find(f => f.path === manifest.entry)) {
    files = [...files, { path: manifest.entry, content: buildFallbackEntryHtml(parsed, manifest) }]
    parsed.diagnostics.push({ stage:'schema', status:'warn', message:`entry ${manifest.entry} 缺失，已生成兜底预览页` })
  }
  files = [{ path:'manifest.json', content: JSON.stringify(manifest, null, 2) }, ...files]

  // status 判定
  status = parsed.status === 'invalid' && !parsed.manifest
    ? (input.result.success && output ? 'partial' : 'invalid')  // 完全失败退回当前行为
    : parsed.status === 'ready' ? 'ready' : 'partial'

  turns = [
    { role:'user', content: prompt, at: now },
    { role:'assistant', content: parsed.notes || output || '本地 CLI 没有返回可展示内容。', at: now },
  ]

  diagnostics = [
    { stage:'local-cli', status: success?'pass':'fail', message:`${providerLabel} ${model}，session ${...}` },
    { stage:'command', status:'info', message: cliCommand(...).join(' ') || '未返回命令预览' },
    { stage:'transcript', status: cliTranscriptPath ? 'info':'fail', message: cliTranscriptPath(...) || '未返回 transcript 路径' },
    { stage:'schema', status: schemaStatus(parsed), message: schemaSummary(parsed) },  // 新增 stage
    ...(result.diagnostics||[]).map(m => ({ stage:'diagnostics', status:'fail', message:m })),
    ...parsed.diagnostics,
  ]
```

> 关键约束：
> - **完全失败退回当前行为**：`parsed.status==='invalid' && !parsed.manifest` 时，状态走 `input.result.success && output ? 'partial' : 'invalid'`（与旧逻辑 `:227` 等价），保证模型完全不遵守协议时不比现在更差。
> - **CLI 字段优先**：manifest 各字段若 CLI 已产出则采用，否则前端兜底补全（兼容模型少产字段的 `partial` 场景）。
> - `normalizeCapabilities` 收敛后，`manifest.json` 中 capabilities 必为合法对象数组，**彻底消除 `:198` 的字符串数组 bug**。

#### 3.2.6 `parseManifest` 复用 `normalizeCapabilities`（plugin-draft.ts:255-272）

`parseManifest` 的 `capabilities` 行（`:267`）从 `Array.isArray(parsed.capabilities) ? parsed.capabilities : []` 改为 `normalizeCapabilities(parsed.capabilities)`。这样 localStorage 读取的草稿、`previewSrcDoc` 依赖的 manifest 都走同一收敛逻辑。

> 回归点：`previewSrcDoc`（`:274-285`）依赖 `parseManifest` 拿 `entry`，改 capabilities 形态不影响 entry 查找，但需在 implement 回归验证预览仍正常（见 implement.md §5 回归点）。

#### 3.2.7 `PluginCreatorHome.tsx` 接入协议化 systemPrompt

`send()`（`:226-277`）中 `systemPrompt`（`:240`）改为引用 `PLUGIN_CREATOR_SYSTEM_PROMPT` 常量：

```ts
import { PLUGIN_CREATOR_SYSTEM_PROMPT } from '@/lib/plugin-creator-protocol';
// ...
const systemPrompt = PLUGIN_CREATOR_SYSTEM_PROMPT;
```

其余调用链（`tauriInvoke('code_assistant_start_session', ...)` `:241-248`）不变。

### 3.3 数据流（端到端，修复后）

```
用户输入 prompt
  → PluginCreatorHome.send()
  → systemPrompt = PLUGIN_CREATOR_SYSTEM_PROMPT (协议化)
  → tauriInvoke('code_assistant_start_session', { prompt, systemPrompt })
  → [code_assistant.rs:285-287] 拼接 "{systemPrompt}\n\n---\n\n{prompt}" 传 CLI
  → CLI(claude/codex/opencode) 按协议产出三类围栏块到 stdout
  → [code_assistant.rs:574 spawn_reader] 流式/同步回传 stdout 文本
  → CliProbeResult.stdout/stderr
  → sessionToProbeResult → buildLocalDraft
  → parseStructuredPackage(stdout) [新]
      - 正则匹配围栏块
      - classifyBlockInfo 分类(manifest/file/notes/unknown)
      - manifest: JSON.parse + PluginManifest.safeParse(zod)
      - file: cleanPathFrontend 校验 + 同 path 后者覆盖
      - unknown: 候选归类(ui/index.html / snippet-N)
      - 字节预算检查
      - status: ready/partial/invalid
  → normalizeCapabilities(parsed.manifest.capabilities) [新] → 合法对象数组
  → buildLocalDraft CLI 字段优先 + 前端兜底补全
  → PluginDraft(manifest.json + 多文件, capabilities 合法)
  → uploadCloud POST /api/plugins/upload
  → [plugin-package.ts:102-114] capability.kind 命中白名单 → 通过 → 不再 400 ✓
```

### 3.4 组件 / 文件拆分

| 文件 | 变更类型 | 职责 |
|---|---|---|
| `apps/desktop/src/lib/plugin-creator-protocol.ts` | **新增** | 协议化 systemPrompt 常量、`StructuredBlock` 类型、`classifyBlockInfo` 纯函数 |
| `apps/desktop/src/lib/plugin-draft.ts` | 改 | 新增 `parseStructuredPackage`/`normalizeCapabilities`/`cleanPathFrontend`/`buildFallbackEntryHtml`；重构 `buildLocalDraft`；`parseManifest` 复用 `normalizeCapabilities` |
| `apps/desktop/src/pages/PluginCreatorHome.tsx` | 改（最小） | `send()` 中 systemPrompt 引用常量（`:240`） |
| `packages/contract/src/plugin.ts` | **不改** | 契约已正确 |
| `apps/collab-api/src/modules/plugin-package.ts` | **不改** | 守门人保持严格 |
| `apps/desktop/src-tauri/src/code_assistant.rs` | **不改** | systemPrompt 拼接/OutputFormat/spawn_reader 不变 |
| 测试（新增） | 新增 | 见 §7 |

## 4. 关键决策与权衡

### 4.1 已确认用户决策（父 PRD 约束，本子任务遵守）

1. **跨三 CLI 零适配**（父 PRD 用户决策）：不依赖任何 CLI 的特殊输出格式（claude StreamJson / codex Plain），统一走 stdout 文本。三类围栏块（fenced code block）所有代码模型原生产出，无需 CLI 适配层。
2. **contract-first 不触发**（本子任务不改契约）：契约 bug 在前端产出物，不在契约本身。R3 的 RuntimeType 四值扩展才走完整 contract-first 链路。
3. **capabilities 字符串数组形态不做向后兼容**（父 PRD 约束 + 全局「破坏性变更」准则）：直接用 `normalizeCapabilities` 收敛为对象数组，旧字符串数组形态在产出端即被消灭。

### 4.2 技术决策

| 决策 | 选择 | 理由 | 权衡 / 风险 |
|---|---|---|---|
| 结构化协议载体 | **文本内围栏块**（非 JSON 整体 / 非 NDJSON / 非 XML） | 跨三 CLI 零适配；fenced block 是代码模型原生能力；不依赖后端 OutputFormat | 模型可能不严格产出围栏（裸块兜底归类 mitigates）；围栏嵌套 ` ``` ` 可能误截断（取到末尾兜底 mitigates） |
| manifest 校验 | **复用契约 zod `PluginManifest.safeParse`** | 单一真源（契约层），不重复造校验；前端/后端校验逻辑同源 | zod safeParse 错误信息需转译为 `schema` stage 诊断（人类可读） |
| capabilities 兜底 | 固定 `code-assistant.run`（白名单内） + risk `medium` | 本地代码助手执行插件是中等风险；kind 必须在白名单内才能通过后端 | 兜底覆盖了模型可能产出的更精确能力声明——但模型完全乱产时兜底比 400 好 |
| file 路径校验 | 前端镜像后端 `cleanPath`（不 throw，返回 union） | 产出端提前收敛，减少后端 400；discriminated union 便于容错记录 | 前端/后端两份 cleanPath 需保持对齐（implement 中以注释标注来源行号） |
| 解析失败策略 | 三级 `ready/partial/invalid` + 完全失败退回当前行为 | 保证不比现状更差；partial 兜底补全后可上传 | invalid 仍依赖用户重新生成（R1 多轮迭代可改善，非本子任务） |
| systemPrompt 位置 | 抽为 `plugin-creator-protocol.ts` 常量 | 便于单测、便于 R1 多轮迭代时扩展、关注点分离 | 多一个文件——但纯文本常量 + 纯函数，成本极低 |

### 4.3 不做的事（明确拒绝）

- **不**新增 template/language 冗余字段（父 PRD 约束）：语言由 runtime_type + entry 后缀推断，本子任务仅 `client`。
- **不**给后端加 capabilities 字符串→对象的兼容转换：bug 在前端产出端，后端是守门人，保持严格符合「架构优先级——标准化」。
- **不**改 OutputFormat 或新增第四类围栏：协议只三块足够。

## 5. 兼容性 / 迁移 / 回滚形状

### 5.1 兼容性

- **破坏性变更**：`buildLocalDraft` 产出的 `manifest.capabilities` 从字符串数组 `['code-assistant']` 变为对象数组 `[{kind:'code-assistant.run',...}]`。这是 bug 修正，**不做向后兼容**（符合全局准则与父 PRD）。
- **localStorage 已存草稿**：`parseManifest`（`:255-272`）改用 `normalizeCapabilities` 后，历史字符串数组草稿在读取时会被收敛为兜底能力，不再 400。属正向兼容（修复历史坏数据）。
- **契约 / 后端 / Rust 均不变**：外部 API、Prisma、迁移零影响。

### 5.2 回滚形状

本子任务全部改动集中在 `apps/desktop/src/lib/`（3 个文件）与 `PluginCreatorHome.tsx`（1 处），无 DB / 契约 / 后端改动，**回滚 = git revert 单个提交**，零迁移成本：

```
git revert <本子任务提交>
pnpm -C apps/desktop typecheck   # 验证回滚干净
```

回滚后系统回到「纯文本兜底 + capabilities 字符串数组 + uploadCloud 必然 400」现状，不引入新的不一致状态。

## 6. 安全与风险

### 6.1 安全边界（本子任务范围内）

本子任务**不涉及本地执行**（Node/Python 执行是 R3）。仅在**解析阶段**处理模型产出的文本，安全考量集中在：

- **路径穿越（产出端）**：`cleanPathFrontend` 与后端 `plugin-package.ts:61-69` 对齐，禁绝对路径 / `..` / 隐藏段 / 盘符，防止模型产出 `../../../etc/passwd` 类恶意 entry。后端是最终守门人，前端是前置收敛。
- **超大内容（DoS）**：`parseStructuredPackage` 末尾字节预算检查（单文件 256KB / 总 2MB），超限强制 `invalid`，避免产出超大包。
- **manifest 注入**：`PluginManifest.safeParse`（zod）拒绝畸形 JSON / 非法字段类型；capabilities 经白名单收敛，不接受任意 kind。

### 6.2 R3 软隔离边界（标注，本子任务不实现但需为 R3 留位）

> 父 PRD R3 明确：本轮 sandbox 仅**软隔离**（用户权限运行），OS 级隔离（seccomp / 命名空间 / 容器）为后续独立大任务。本子任务的 `parseStructuredPackage` **产出文件但不执行**，软隔离边界对解析无影响；但需确保解析出的代码文件**不被预览层意外执行**——本子任务的 `previewSrcDoc`（`:274-285`）仅对 client runtime 拼接 HTML 进 iframe，不执行 Node/Python（那是 R3 的分派逻辑）。client HTML 在 iframe 内执行属既有行为，不在本子任务安全范围扩张。

### 6.3 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 模型不严格遵守协议（裸 ` ``` ` 无 info） | 中 | `unknown` 块候选归类（语言标识 / 内容特征推断 → `ui/index.html` 或 `snippet-N`）；status 降 partial |
| 围栏嵌套 ` ``` ` 误截断 | 中 | 取到下一个未被消费的结束围栏；截断后剩余文本兜底归入 unknown 继续解析；diagnostics 标记 |
| entry 文件缺失 | 中 | `buildLocalDraft` 自动生成兜底预览页 + warning；status partial |
| 超大 HTML 字节预算 | 低 | parse 末尾字节检查，超 256KB/2MB 强制 invalid |
| `normalizeCapabilities` 改 `parseManifest` 影响 `previewSrcDoc` | 低 | previewSrcDoc 只依赖 entry，capabilities 形态不影响；implement 回归验证 |
| 模型产出的 capabilities kind 部分合法部分非法 | 低 | `normalizeCapabilities` 整体判定——若数组含任何非法项则整体兜底（保守）；diagnostics 记录被丢弃项 |
| claude StreamJson 格式 vs 协议围栏块冲突 | 低 | `extract_stream_json_text`（`code_assistant.rs:550`）已把 streamjson 的 text 字段拼成连续 stdout，围栏块协议在其上工作，无需适配 |

## 7. 验证策略（本地可重复）

### 7.1 单元测试（核心，纯函数优先）

desktop 包当前**无测试配置**（`package.json` 无 test 脚本、无 vitest 依赖、无 `.spec`）。新增纯函数单测需先补测试基建：

- 为 `plugin-creator-protocol.ts` 与 `plugin-draft.ts` 的纯函数补单测。
- 落点方案（implement.md §2 详述）：在 `apps/desktop` 引入 vitest（devDependency），新增 `vitest.config.ts` + `package.json` test 脚本，测试文件 `*.spec.ts` 与源码同目录。

**`parseStructuredPackage` 五类必测（研究结论指定）**：

1. **正常**：模型产 manifest + file + notes 三块齐全 → `status: ready`，files 含 entry，capabilities 合法。
2. **部分缺失**：模型只产 manifest 缺 file（或 entry 不匹配）→ `status: partial`，entry 兜底补全。
3. **完全失败**：模型输出纯自然语言无任何围栏 → `status: invalid`，`manifest: null`。
4. **注入路径**：file 块 `path="../../../etc/passwd"` → cleanPathFrontend 拒绝，块丢弃，diagnostics 记 fail。
5. **字符串化 capabilities**：manifest 块内 `capabilities: ['code-assistant']` → `normalizeCapabilities` 兜底为 `[{kind:'code-assistant.run',...}]`。

补充：`classifyBlockInfo`（四类）、`cleanPathFrontend`（绝对/`..`/隐藏段/空段/合法）、`normalizeCapabilities`（合法数组/含非法项/空数组/非数组）、围栏嵌套截断场景、字节预算超限场景。

### 7.2 契约层回归（契约不改，但确认未误伤）

```powershell
pnpm -C packages/contract typecheck   # 契约 tsc 通过
pnpm -C packages/contract test        # node --test 通过
```

### 7.3 前端 typecheck + 新测试

```powershell
pnpm -C apps/desktop typecheck        # tsc --noEmit 通过
pnpm -C apps/desktop test             # 新增 vitest 通过
```

### 7.4 后端回归（契约守门人不变，确认未误伤）

```powershell
pnpm -C apps/collab-api test          # plugin.service.spec.ts 等回归通过（AC7）
```

### 7.5 真实 CLI 探针（端到端，AC1/AC8）

```powershell
# 确认三 CLI 任一可用（前置：本地已装 claude/codex/opencode 之一并配好 key）
pnpm -C apps/desktop dev              # 或 pnpm start 全量编排
# 在「创建插件」页输入需求（如"做一个番茄钟插件"）
# 观察：右侧详情应展示解析出的 manifest + 多文件（非纯文本 pre）
# 点击「上传到团队云端」→ 应成功（不再 400）
```

至少用一个真实 CLI 验证 `uploadCloud` 不再 400（AC1 关键验收点）。三 CLI 选一即可（claude StreamJson 与 codex/opencode Plain 路径均覆盖同一解析器）。

### 7.6 验证失败即止

任一验证步骤失败，立即终止提交，记录到 `.claude/operations-log.md` 并回到研究/计划阶段（符合全局「连续三次失败暂停」准则）。

---

> 本设计已穷尽到函数/文件/类名级，无 TBD / 占位符。后续按 `implement.md` 的有序 checklist 执行。
