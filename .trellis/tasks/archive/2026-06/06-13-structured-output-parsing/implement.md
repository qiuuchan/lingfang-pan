# 代码助手结构化输出与解析 — 执行计划

> 配套 `design.md`。本文为有序、可验证的执行 checklist。每步含验证命令，失败即止。
> 全部产出使用简体中文（注释 / commit / 日志）。文件操作用专用工具（Read/Write/Edit/Glob/Grep），禁 Shell 直接操作文件。

## 1. 前置条件与依赖

### 1.1 前置依赖

- **本子任务无前置依赖**（父 PRD 子任务地图标注：structured-output-parsing 是核心基础，无前置）。
- 契约层 `packages/contract` 与后端 `plugin-package.ts` 已正确，本子任务**不**改它们。

### 1.2 下游依赖（标注，非本子任务实现）

- `06-13-conversational-multiturn`（R1）：依赖本子任务的结构化产出（多轮迭代基于 `PluginDraft` 草稿累积）。
- `06-13-node-python-local-exec`（R3）：依赖本子任务的 `parseStructuredPackage`（Node/Python 多文件代码需被正确解析为多文件）。

### 1.3 环境前置

- 工作目录 `O:/lingfang-platform`，分支从 `main` 切出（建议 `feat/structured-output-parsing`）。
- 前端用 pnpm；Node >= 20。
- 至少一个本地 CLI 可用（claude / codex / opencode，配好 key）用于 §5 真实 CLI 探针。若三 CLI 均不可用，单测 + typecheck 仍可完成，但 AC1/AC8 端到端验证需补 CLI（记录到 operations-log）。
- Python 走 `py` launcher（本子任务不涉及 Python，但若验证脚本需要则用 `py`）。

### 1.4 关键文件清单（已核实精确行号）

| 文件 | 关键位置 |
|---|---|
| `apps/desktop/src/lib/plugin-draft.ts` | `buildLocalDraft:186-243`、`extractCliText:119-121`、`parseManifest:255-272`、`previewSrcDoc:274-285`、`capabilities bug:198`、`tailText:166-168` |
| `apps/desktop/src/pages/PluginCreatorHome.tsx` | `send():226-277`、`systemPrompt:240`、`uploadCloud:293-310` |
| `apps/desktop/src/lib/types.ts` | `DraftFile/DraftTurn/PluginDraft:67-91` |
| `packages/contract/src/plugin.ts` | `PluginManifest:29-39`、`PluginCapability:19-26`、`CapabilityKind:7-13`、`RuntimeType:4-5` |
| `apps/collab-api/src/modules/plugin-package.ts` | `ALLOWED_CAPABILITIES:48-53`、`normalizePluginPackage:71-134`、`cleanPath:61-69`、`capabilities 校验:102-114`、`entry 校验:101`、字节限制:45-47 |
| `apps/desktop/src-tauri/src/code_assistant.rs` | `systemPrompt 拼接:285-287`、`OutputFormat 分派:373-374`、`extract_stream_json_text:550`、`spawn_reader:574`（**不改**） |

## 2. 有序执行 checklist

### 阶段 A — 测试基建（纯函数优先，TDD）

> 依据全局「测试思维」与设计 §7.1：desktop 包当前无测试配置，需先补 vitest。

- [ ] **A1. 引入 vitest 到 desktop 包**
  - 编辑 `apps/desktop/package.json`：`devDependencies` 加 `"vitest": "^3"`（与 collab-api 对齐版本，先查 `apps/collab-api/package.json` 确认版本）；`scripts` 加 `"test": "vitest run"`。
  - 新增 `apps/desktop/vitest.config.ts`（最小配置：`test.environment: 'node'`，`include: ['src/**/*.spec.ts']`）。
  - 验证：`pnpm -C apps/desktop install`，然后 `pnpm -C apps/desktop test`（应报告「no test files found」即配置生效）。

- [ ] **A2. 写 `plugin-creator-protocol.spec.ts`（先于实现，TDD）**
  - 新建 `apps/desktop/src/lib/plugin-creator-protocol.spec.ts`，覆盖 `classifyBlockInfo`：
    - `lingfang-manifest json` → `manifest`；`lingfang-notes` → `notes`；`file path="ui/index.html"` → `file`；裸 `` ``` ``（空 info）→ `unknown`；`html`/`python` → `unknown`（候选归类）。
  - 此时实现尚未写，测试应失败（红）。
  - 验证：`pnpm -C apps/desktop test`（确认红）。

- [ ] **A3. 实现 `plugin-creator-protocol.ts`（转绿）**
  - 新建 `apps/desktop/src/lib/plugin-creator-protocol.ts`：
    - 导出 `PLUGIN_CREATOR_SYSTEM_PROMPT` 常量（内容见 design §3.2.1，含三类围栏块示例与约束）。
    - 导出 `StructuredBlockKind` / `StructuredBlock` 类型。
    - 实现 `classifyBlockInfo(info: string): StructuredBlockKind`（按 info 前缀匹配 `lingfang-manifest`/`file`/`lingfang-notes`，否则 `unknown`）。
  - 验证：`pnpm -C apps/desktop test`（A2 转绿）。

### 阶段 B — 核心解析纯函数（TDD）

- [ ] **B1. 写 `plugin-draft.parse` 的五类单测（design §7.1 指定）**
  - 新建 `apps/desktop/src/lib/plugin-draft.spec.ts`，针对 `parseStructuredPackage` 写五类用例：
    1. **正常**：manifest + file(entry) + notes 三块 → `status: ready`。
    2. **部分缺失**：manifest 缺 file 或 entry 不匹配 → `status: partial`。
    3. **完全失败**：纯自然语言无围栏 → `status: invalid`，`manifest: null`。
    4. **注入路径**：`file path="../../../etc/passwd"` → 块丢弃 + diagnostics fail。
    5. **字符串化 capabilities**：manifest 内 `capabilities: ['code-assistant']` → 兜底 `[{kind:'code-assistant.run',...}]`。
  - 补充用例：`classifyBlockInfo` 集成、`cleanPathFrontend`（绝对/`..`/隐藏段/空段/合法）、`normalizeCapabilities`（合法数组/含非法项/空数组/非数组）、围栏嵌套截断、字节预算超限（构造 > 2MB）。
  - 验证：`pnpm -C apps/desktop test`（红）。

- [ ] **B2. 实现 `cleanPathFrontend`**
  - 在 `apps/desktop/src/lib/plugin-draft.ts` 新增，返回 `{ ok: true; value: string } | { ok: false; reason: string }`。
  - 逻辑与后端 `plugin-package.ts:61-69` 对齐（去反斜杠、禁绝对/`~`/盘符/空段/`.`/`..`/隐藏段），**不 throw**（与后端不同，返回 union 便于容错）。
  - 注释标注来源：`// 与后端 plugin-package.ts:61-69 cleanPath 对齐，产出端前置收敛`。
  - 验证：`pnpm -C apps/desktop test`（cleanPathFrontend 用例转绿）。

- [ ] **B3. 实现 `normalizeCapabilities`**
  - 在 `apps/desktop/src/lib/plugin-draft.ts` 新增，导入 `CapabilityKind` from `@lingfang/contract`。
  - `FRONTEND_CAPABILITY_KINDS` 镜像后端 `ALLOWED_CAPABILITIES`（`plugin-package.ts:48-53`）；`FRONTEND_CAPABILITY_RISKS` 镜像后端 `['none','low','medium','high']`。
  - `FALLBACK_CAPABILITY` 固定 `{kind:'code-assistant.run', reason:'本地代码助手执行', risk:'medium', requires_admin:false}`。
  - 逻辑：合法对象数组（全部 kind 在白名单）→ map 规范化；否则返回 `[fallback]`。
  - 注释标注来源行号。
  - 验证：`pnpm -C apps/desktop test`（normalizeCapabilities 用例转绿）。

- [ ] **B4. 实现 `parseStructuredPackage`**
  - 在 `apps/desktop/src/lib/plugin-draft.ts` 新增，按 design §3.2.2 算法：
    1. 正则遍历 fenced code block（处理规范块 / 裸块 / 围栏嵌套截断）。
    2. `classifyBlockInfo` 分类；file 块提取 `path="..."`。
    3. manifest 块：`JSON.parse` + `PluginManifest.safeParse`（zod，from `@lingfang/contract`）；多块取最后。
    4. file 块：`cleanPathFrontend` 校验 + Map 维护同 path 后者覆盖。
    5. unknown 块：候选归类（语言标识 / `<html`/`<!doctype` → `ui/index.html`；其余 `snippet-N`）。
    6. 状态判定 `ready/partial/invalid`。
    7. 字节预算检查（`new TextEncoder().encode(content).length`，超 256KB/文件、2MB/总量强制 invalid）。
  - 返回 `ParsedStructuredPackage`。
  - 验证：`pnpm -C apps/desktop test`（B1 全部转绿）。

- [ ] **B5. 实现 `buildFallbackEntryHtml`**
  - 在 `apps/desktop/src/lib/plugin-draft.ts` 新增：当 entry 文件缺失时生成兜底预览页（HTML 转义 + 展示 notes/snippet）。参考现有 `buildLocalDraft:201-224` 的 HTML 骨架抽取。
  - 验证：补充单测「entry 缺失时 files 含兜底页」。

### 阶段 C — 重构 buildLocalDraft / parseManifest 接入

- [ ] **C1. `parseManifest` 复用 `normalizeCapabilities`**
  - 编辑 `apps/desktop/src/lib/plugin-draft.ts:267`：`capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : []` → `capabilities: normalizeCapabilities(parsed.capabilities)`。
  - `catch` 分支（`:270`）的 `capabilities: []` 保持（解析失败无能力，后端接受空数组——合法）。
  - 验证：`pnpm -C apps/desktop typecheck`；单测新增「parseManifest 字符串数组 capabilities 收敛」转绿。

- [ ] **C2. 重构 `buildLocalDraft`（plugin-draft.ts:186-243）**
  - 按 design §3.2.5 重构：
    - 调 `parseStructuredPackage(output)`。
    - manifest 各字段 CLI 优先 + 前端兜底补全。
    - `capabilities: normalizeCapabilities(parsed.manifest?.capabilities)`。
    - entry 缺失 → 补 `buildFallbackEntryHtml` + warning diagnostic。
    - files = `[{path:'manifest.json', content: JSON.stringify(manifest,null,2)}, ...parsed.files]`。
    - status 判定（完全失败退回当前行为 `:227` 逻辑）。
    - diagnostics 加 `stage:'schema'` 项（status + summary）。
    - turns：assistant 内容优先 `parsed.notes || output`。
  - **删除** `:190-199` 的硬编码 manifest、`:200-224` 的固定 HTML 拼接（被 parseStructuredPackage + buildFallbackEntryHtml 取代）。
  - 验证：`pnpm -C apps/desktop typecheck`；`pnpm -C apps/desktop test`（buildLocalDraft 相关用例通过）。

### 阶段 D — UI 接入协议化 systemPrompt

- [ ] **D1. `PluginCreatorHome.tsx` 引用协议常量**
  - 编辑 `apps/desktop/src/pages/PluginCreatorHome.tsx`：
    - 顶部 import：`import { PLUGIN_CREATOR_SYSTEM_PROMPT } from '@/lib/plugin-creator-protocol';`
    - `:240` 改：`const systemPrompt = PLUGIN_CREATOR_SYSTEM_PROMPT;`
  - 其余 send() / tauriInvoke 调用链不变。
  - 验证：`pnpm -C apps/desktop typecheck`。

### 阶段 E — 契约层与后端回归（不改，确认未误伤）

- [ ] **E1. 契约层回归**
  - 验证命令：`pnpm -C packages/contract typecheck` + `pnpm -C packages/contract test`（`node --test`）。
  - 期望：全绿（本子任务未改契约）。

- [ ] **E2. 后端回归（AC7）**
  - 验证命令：`pnpm -C apps/collab-api test`（含 `plugin.service.spec.ts`）。
  - 期望：全绿（本子任务未改后端，确认 normalizeCapabilities 产出能通过后端白名单）。

### 阶段 F — 全量 typecheck + 真实 CLI 探针

- [ ] **F1. 全量 typecheck**
  - 验证命令：`pnpm typecheck`（根 `pnpm -r typecheck`）。
  - 期望：全绿。

- [ ] **F2. 真实 CLI 探针（AC1/AC8 关键）**
  - 前置：后端 + 桌面壳运行（`pnpm start` 或 `pnpm -C apps/collab-api dev` + `pnpm dev:desktop`）。PostgreSQL 已起（localhost:5432，库已迁移）。
  - 操作：登录 → 进入「创建插件」→ 选一个可用 CLI（claude/codex/opencode 任一）→ 输入需求（如「做一个番茄钟插件，可设置 25/45 分钟」）。
  - 期望验证点：
    1. 右侧详情展示**解析出的 manifest 字段 + 多文件**（非旧版纯文本 `<pre>`）。
    2. capabilities 显示为对象（`code-assistant.run` 等），非字符串 `code-assistant`。
    3. 点击「上传到团队云端」→ **成功**（不再 400）。
    4. diagnostics 含 `schema` stage，status 为 ready 或 partial。
  - 若三 CLI 均不可用：记录到 `.claude/operations-log.md`，标 AC1/AC8 端到端待补，但 A-E 阶段单测 + typecheck 必须全绿才可认为本子任务代码完成。

- [ ] **F3. 回归 previewSrcDoc（design §6.3 风险点）**
  - 验证：在 F2 生成草稿后，点击预览（client runtime → iframe）应正常渲染 entry 文件内容（previewSrcDoc 依赖 parseManifest，capabilities 改形态不影响 entry 查找）。
  - 期望：预览页正常显示，无空白 / 报错。

## 3. 契约变更顺序（contract-first）

> **本子任务不触发 contract-first 链路**（契约层不改）。本节为「不触发」的依据与边界说明。

- 契约 bug 根因在前端产出物（`plugin-draft.ts:198` 字符串数组 + 非法 kind），**不在** `packages/contract`（契约定义已正确）。
- 后端 `plugin-package.ts` 是守门人，保持严格校验不变。
- 若实现中发现「必须改契约才能修复」（如白名单缺项），**立即停止**，回到 design 重新评估，触发完整 contract-first：`packages/contract` 改 → `pnpm -C packages/contract typecheck` → 后端 `plugin-package.ts` 同步 → migrate（若涉及 enum）→ 前端 → 回归。本子任务预期不进入此分支。

## 4. Review Gate（关键检查点）

> 每个 gate 必须 evidence before assertions（先跑命令拿输出，再判定通过）。

### Gate 1 — 纯函数 TDD 完备（阶段 B 结束）

- [ ] `parseStructuredPackage` 五类单测全绿（正常/部分缺失/完全失败/注入路径/字符串化 capabilities）。
- [ ] `classifyBlockInfo`、`cleanPathFrontend`、`normalizeCapabilities` 单测覆盖。
- [ ] 围栏嵌套截断、字节预算超限场景单测覆盖。
- [ ] 命令：`pnpm -C apps/desktop test`，输出全绿。

### Gate 2 — 重构无回归（阶段 C-D 结束）

- [ ] `parseManifest` 复用 `normalizeCapabilities` 后，历史字符串数组草稿读取收敛。
- [ ] `buildLocalDraft` 完全失败路径退回当前行为（不比现状差）。
- [ ] `PluginCreatorHome.tsx` 仅 systemPrompt 一处改动。
- [ ] 命令：`pnpm -C apps/desktop typecheck` + `pnpm -C apps/desktop test`，全绿。

### Gate 3 — 契约/后端零误伤（阶段 E 结束，AC7）

- [ ] `packages/contract` typecheck + test 全绿。
- [ ] `apps/collab-api` test 全绿（`plugin.service.spec.ts`）。
- [ ] 命令：`pnpm -C packages/contract test` + `pnpm -C apps/collab-api test`。

### Gate 4 — 端到端不再 400（阶段 F，AC1/AC8）

- [ ] 真实 CLI 生成 → 结构化解析 → 上传云端成功。
- [ ] capabilities 为对象数组、kind 命中白名单。
- [ ] previewSrcDoc 预览正常。
- [ ] 若 CLI 不可用，记录补偿计划，A-E 全绿方可标记代码完成。

### Gate 5 — 最终质量审查

- [ ] `pnpm typecheck`（根）全绿。
- [ ] 无 TBD / 占位符 / 逃生式代码。
- [ ] 注释描述意图与来源行号，无「修改说明」式注释。
- [ ] commit 信息简体中文（如 `feat(desktop): 结构化输出协议 + 解析器 + capabilities 契约修复`）。

## 5. 回滚点

- **原子提交**：阶段 A-D 完成后单次 commit（`feat(desktop): 结构化输出协议 + 解析器 + capabilities 契约修复`），便于整体回滚。
- **回滚命令**：`git revert <commit>`，然后 `pnpm -C apps/desktop typecheck` 确认回滚干净。
- **回滚影响**：系统回到「纯文本兜底 + capabilities 字符串数组 + uploadCloud 必然 400」现状，无 DB / 契约 / 后端残留（本子任务零 DB 迁移、零契约改动、零后端改动）。
- **分阶段回滚**（若需更细粒度）：
  - 仅回滚 UI：把 `PluginCreatorHome.tsx:240` 改回旧字符串（不影响解析器）。
  - 仅回滚 buildLocalDraft：保留 parseStructuredPackage/normalizeCapabilities（纯函数，无副作用），恢复 `:186-243` 旧实现。

## 6. 产出物清单

| 产出 | 路径 | 类型 |
|---|---|---|
| 协议常量 + 纯函数 | `apps/desktop/src/lib/plugin-creator-protocol.ts` | 新增 |
| 协议单测 | `apps/desktop/src/lib/plugin-creator-protocol.spec.ts` | 新增 |
| 解析器 + capabilities 收敛 + buildLocalDraft 重构 | `apps/desktop/src/lib/plugin-draft.ts` | 改 |
| 解析器单测 | `apps/desktop/src/lib/plugin-draft.spec.ts` | 新增 |
| 测试基建 | `apps/desktop/vitest.config.ts` + `package.json` test 脚本 | 新增/改 |
| UI systemPrompt 接入 | `apps/desktop/src/pages/PluginCreatorHome.tsx` | 改（最小） |
| 操作日志 | `.claude/operations-log.md` | 记录 |

> 全部步骤可重复执行；失败即止，记录到 operations-log 并回到对应 gate 修复。
