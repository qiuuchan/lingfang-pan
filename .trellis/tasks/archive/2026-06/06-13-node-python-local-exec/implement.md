# Node/Python 语言与本地预览执行 — 执行计划

> 关联设计：`.trellis/tasks/06-13-node-python-local-exec/design.md`。
> 全部产出（文档/注释/commit）使用简体中文。文件操作用专用工具，禁 Shell 直改文件。
> 前端用 pnpm；Python 脚本用 `py` launcher（Windows）。验证失败即止，禁带缺陷交付。

---

## 1. 前置条件与依赖

### 1.1 依赖子任务

- **强依赖 R2（`06-13-structured-output-parsing`）**：本子任务的「运行预览」需要 `PluginDraft.files` 含正确的 `manifest.json`（`runtime_type ∈ {nodejs,python}`）+ 入口源码文件。R2 的 `parseStructuredPackage` 与 systemPrompt 协议是 Node/Python 代码被正确解析为多文件的前提。
  - **可解耦点**：契约/后端/Prisma 改动（§3）与 Rust `run_plugin_script`（步骤 4-6）不依赖 R2，可先行；前端 `ScriptPreviewPanel` 的真实联调（步骤 9）依赖 R2 产出可用草稿。本计划按 contract-first 先做不依赖 R2 的部分，R2 就绪后再做端到端联调。
- **无依赖**：与 R4（输出渲染美化）、R5（样式错误友好化）无前置关系，可并行。注意 R5 会统一错误友好抛出，本子任务的「解释器缺失/超时」错误展示应遵循 R5 的卡片规范（步骤 9 标注协调点）。

### 1.2 环境前置

- 本地已启动 PostgreSQL 18（`localhost:5432`，库 `lingfang_collab` 已迁移，见 MEMORY.md）。
- 本地有 Node.js（验证脚本运行用）与 Python（经 `py` launcher，验证脚本运行用）。
- `cargo` 工具链可用（桌面壳 Rust 编译）。
- 桌面壳依赖：`apps/desktop/src-tauri` 可 `cargo build`。

### 1.3 上下文确认（开始前自检）

- 已读 design.md 第 2-3 章精确行号引用。
- 已确认 `run_capture`（`code_assistant.rs:717`）、`find_binary`（`:786`）、`find_command`（`:762`）、`resolve_workspace`（`:819`）为私有函数待提升。
- 已确认头号陷阱（`plugin-package.ts:130` 三元映射）。

---

## 2. 契约变更顺序（严格 contract-first）

> 顺序铁律：契约 → 后端 → migrate → 前端 → 回归。任一步 typecheck/test 失败即止，不进入下一步。

### 步骤 1：扩展契约 RuntimeType

- [ ] 编辑 `packages/contract/src/plugin.ts:4`：
  `z.enum(['client', 'cloud'])` → `z.enum(['client', 'cloud', 'nodejs', 'python'])`
- [ ] `PluginManifest`（`:29-39`）无需单独改（`runtime_type: RuntimeType.default('client')` 自动跟随）。
- [ ] **验证**：
  ```powershell
  pnpm --filter @lingfang/contract typecheck
  ```
  通过即继续。

### 步骤 2：后端类型 + 校验 + 映射表（修头号陷阱）

- [ ] 编辑 `apps/collab-api/src/modules/plugin-package.ts`：
  - `:34` `runtime_type` 类型 → `'client' | 'cloud' | 'nodejs' | 'python'`
  - `:40` `runtimeType` 类型 → `'CLIENT' | 'CLOUD' | 'NODEJS' | 'PYTHON'`
  - `:81-82` 校验放宽：
    ```ts
    if (!['client', 'cloud', 'nodejs', 'python'].includes(runtime)) {
      throw badRequest('runtime_type 只允许 client / cloud / nodejs / python');
    }
    ```
  - `:130` **修头号陷阱**：替换 `runtime === 'client' ? 'CLIENT' : 'CLOUD'` 为显式映射表：
    ```ts
    const RUNTIME_TYPE_MAP: Record<string, 'CLIENT' | 'CLOUD' | 'NODEJS' | 'PYTHON'> = {
      client: 'CLIENT', cloud: 'CLOUD', nodejs: 'NODEJS', python: 'PYTHON',
    };
    const runtimeType = RUNTIME_TYPE_MAP[runtime] ?? 'CLIENT';
    ```
    并把返回对象的 `runtimeType` 字段改用此变量。
  - `:121` `runtime as 'client'|'cloud'` cast 范围跟随扩展（改为 `as 'client'|'cloud'|'nodejs'|'python'`）。
- [ ] **验证**：
  ```powershell
  pnpm --filter collab-api typecheck
  ```
  通过即继续。

### 步骤 3：Prisma enum 扩展 + 新迁移

- [ ] 编辑 `apps/collab-api/prisma/schema.prisma:56-59`：加 `NODEJS`、`PYTHON` 两行。
- [ ] 用 `prisma migrate dev --create-only` 生成迁移目录 `<timestamp>_plugin_runtime_nodejs_python/migration.sql`，内容确认为：
  ```sql
  ALTER TYPE "PluginRuntimeType" ADD VALUE IF NOT EXISTS 'NODEJS';
  ALTER TYPE "PluginRuntimeType" ADD VALUE IF NOT EXISTS 'PYTHON';
  ```
  - **关键检查**：SQL 顶部**无 `BEGIN;`/`COMMIT;` 包裹**（PG ADD VALUE 不能在事务块内，见 design §6.3）。
- [ ] 应用迁移：
  ```powershell
  pnpm --filter collab-api exec prisma migrate deploy
  ```
- [ ] **验证**：
  ```powershell
  pnpm --filter collab-api exec prisma generate
  ```
  并在 `psql`（库 `lingfang_collab`）执行 `\dT "PluginRuntimeType"` 确认含 `NODEJS`/`PYTHON`。通过即继续。

---

## 3. 后端单元测试（覆盖头号陷阱）

### 步骤 4：plugin-package.spec.ts 覆盖四值映射

- [ ] 新增或扩展 `apps/collab-api/src/modules/plugin-package.spec.ts`，断言：
  - `normalizePluginPackage({ manifest: { name:'t', entry:'main.py', runtime_type:'python' }, files:[{path:'main.py',content:'print(1)'}] })` 返回 `runtimeType === 'PYTHON'`，且 `manifest.runtime_type === 'python'`。
  - 同理 `nodejs` → `NODEJS`。
  - **头号陷阱回归**：断言 `nodejs`/`python` 的 `runtimeType` **不等于** `'CLOUD'`。
  - 非法 runtime（如 `'rust'`）抛 `badRequest`。
- [ ] **验证**：
  ```powershell
  pnpm --filter collab-api test
  ```
  含现有 `plugin.service.spec` / `collab.service.spec` 全绿即继续（父 PRD AC7）。

> **review gate A**（契约 + 后端 + 迁移完成）：运行 `pnpm --filter @lingfang/contract typecheck && pnpm --filter collab-api typecheck && pnpm --filter collab-api test` 全绿，且 `psql \dT` 确认 enum。此处可提交一次「契约四值 + 后端映射 + 迁移」commit（破坏性变更，独立 commit 便于回滚）。

---

## 4. Rust：提升 code_assistant.rs 复用函数可见性

### 步骤 5：提升可见性 + 抽 run_captured_inner

- [ ] 编辑 `apps/desktop/src-tauri/src/code_assistant.rs`：
  - `find_binary`（`:786`）`fn` → `pub(crate) fn`。
  - `find_command`（`:762`）`fn` → `pub(crate) fn`。
  - `resolve_workspace`（`:819`）`fn` → `pub(crate) fn`。
  - `run_capture`（`:717`）：抽出轮询/超时/回收核心为 `pub(crate) fn run_captured_inner(...)`，`run_capture` 与新增 `pub(crate) fn run_capture_with_env(binary, args, workspace_dir, timeout_ms, env)` 都调它。签名见 design §3.3 (d)。
- [ ] **验证**：
  ```powershell
  cargo test -p lingfang-desktop
  ```
  现有 code_assistant 测试全绿即继续（确认提升可见性未破坏现有行为）。

---

## 5. Rust：新增 plugin_script.rs

### 步骤 6：实现 probe_script_runtime + run_plugin_script

- [ ] 新建 `apps/desktop/src-tauri/src/plugin_script.rs`，按 design §3.3 实现：
  - `ScriptRuntime` / `ScriptFile` / `RunPluginScriptInput` / `ProbeResult` / `RunResult` 结构体。
  - `probe_script_runtime(runtime)`：用 `find_binary` 探测（Node: `["node","nodejs"]`；Windows Python: `["py","python","python3"]`，Unix: `["python3","python"]`），命中后 `<binary> --version` 取版本。
  - `sanitize_rel_path(path)`：禁绝对路径/空段/`..`/隐藏段（参照后端 `cleanPath` 逻辑）。
  - `minimal_env()`：白名单 env 收集（PATH/HOME/USERPROFILE/APPDATA/LOCALAPPDATA/SystemRoot/TEMP/TMP/LANG/LC_ALL）。
  - `run_plugin_script(app, input)`：sandbox 落盘（`app_data_dir/plugin-sandbox/<plugin_id>`，先 `remove_dir_all` 重建）→ 防 `..`/canonicalize 前缀断言 → `run_capture_with_env` 带超时（默认 15000）→ 返回 `RunResult`。
- [ ] `main.rs` 顶部加 `mod plugin_script;`，`generate_handler!`（`:193-207`）注册两命令。
- [ ] 新增 `#[cfg(test)]`：临时 sandbox 写 `console.log("ok")` Node 脚本 + `print("ok")` Python 脚本，断言 stdout 含 `ok`、`exit_code=0`、`timed_out=false`；死循环脚本断言 `timed_out=true`；`entry="../x"` 断言报错。
- [ ] **验证**：
  ```powershell
  cargo test -p lingfang-desktop plugin_script
  cargo build -p lingfang-desktop
  ```
  全绿即继续。

> **review gate B**（Rust 命令完成）：`cargo test` 全绿 + `cargo build` 通过。可提交「Rust run_plugin_script 命令」commit。

---

## 6. 前端：plugin-script.ts + ScriptPreviewPanel + PreviewPanel 分派

### 步骤 7：新建 plugin-script.ts

- [ ] 新建 `apps/desktop/src/lib/plugin-script.ts`，按 design §3.5 实现 `ScriptRuntime` / `ProbeResult` / `RunResult` 类型、`probeScriptRuntime` / `runPluginScript` 封装、`RUNTIME_INSTALL_HINT` 常量。
- [ ] **验证**：
  ```powershell
  pnpm --filter desktop typecheck
  ```

### 步骤 8：ScriptPreviewPanel 组件

- [ ] 新建 `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx`：
  - 终端样式 `<pre>`（github-dark 背景与 R4 一致）渲染 `stdout`/`stderr`。
  - 状态条：`exitCode` / `elapsedMs` / `timedOut` 标记。
  - 「运行」按钮 → `runPluginScript`，加载态切换。
  - 首次进入 `probeScriptRuntime`：`available=false` 展示 `RUNTIME_INSTALL_HINT` + 「重试检测」/「仍要预览源码」按钮。
  - 「仍要预览源码」降级：只读展示 entry 文件源码（不执行）。
  - **错误展示遵循 R5 规范**（卡片/气泡，非裸 toast）—— 若 R5 尚未落地，先用 `Card` 容器占位，标注 TODO 协调点。
- [ ] **验证**：`pnpm --filter desktop typecheck` + `pnpm --filter desktop build`。

### 步骤 9：PreviewPanel 按 runtime 分派

- [ ] 编辑 `apps/desktop/src/components/creator/panels/PreviewPanel.tsx:7-23`：
  - 顶部 `const runtime = parseManifest(files).runtime_type;`
  - `runtime === 'nodejs' || runtime === 'python'` → 返回 `<ScriptPreviewPanel files={files} runtime={runtime} previewKey={previewKey} onRefresh={onRefresh} />`
  - 否则（client/默认）→ 现有 iframe JSX 不变。
- [ ] **验证**：
  ```powershell
  pnpm --filter desktop typecheck
  pnpm --filter desktop build
  ```

> **review gate C**（前端完成）：typecheck + build 全绿。可提交「前端脚本预览面板」commit。

---

## 7. 端到端联调（依赖 R2）

### 步骤 10：Node/Python 草稿预览联调

- [ ] 前置：R2 结构化产出可生成 `runtime_type=nodejs`/`python` 的草稿（含 `manifest.json` + 入口源码）。
- [ ] 手动验证 AC3：
  - 在 Creator 输入「用 Node.js 写一个打印 hello 的插件」→ R2 产出 → PreviewPanel 分派到 ScriptPreviewPanel → 点「运行」→ 终端展示 stdout `hello`。
  - 同理 Python（`print("hello")`）。
  - 解释器缺失验证：临时把探测候选改成不存在的名字（或 mock `probeScriptRuntime` 返回 `available:false`）→ 确认安装指引 + 降级按钮。
- [ ] **验证**：手动跑通即记录到验证报告；失败回到对应步骤排查。

---

## 8. Review Gate（关键检查点汇总）

| Gate | 触发点 | 检查项 | 验证命令 |
|---|---|---|---|
| A | 契约+后端+迁移完成（步骤 3 后） | RuntimeType 四值、映射表修复、enum 迁移应用 | `pnpm --filter @lingfang/contract typecheck && pnpm --filter collab-api typecheck && pnpm --filter collab-api test` + `psql \dT "PluginRuntimeType"` |
| B | Rust 命令完成（步骤 6 后） | 可见性提升不破坏现有测试、新命令单测全绿 | `cargo test -p lingfang-desktop && cargo build -p lingfang-desktop` |
| C | 前端完成（步骤 9 后） | 分派逻辑、typecheck、build | `pnpm --filter desktop typecheck && pnpm --filter desktop build` |
| D | 端到端（步骤 10 后，依赖 R2） | AC3 Node/Python 预览 + 缺失降级 | 手动预览验证 |

每个 gate 失败即止，不进入下一阶段。连续三次失败暂停，回 design 复盘（父 CLAUDE.md 要求）。

---

## 9. 回滚点

| 回滚点 | 范围 | 策略 |
|---|---|---|
| RP1 | 契约/后端/迁移（commit at gate A） | `git revert <commit>`。Prisma enum 扩展无害可保留（ADD VALUE 无法 DROP，保留即等于禁用）。 |
| RP2 | Rust 命令（commit at gate B） | `git revert <commit>`：移除 `mod plugin_script;` + 两命令注册 + 可见性改回私有。 |
| RP3 | 前端（commit at gate C） | `git revert <commit>`：PreviewPanel 回退纯 iframe。 |
| 整体 | 全部 | 按 RP1→RP2→RP3 顺序 revert（依赖倒序）。enum 扩展保留不影响 client/cloud 现有流程。 |

---

## 10. 提交粒度建议（commit message 简体中文）

1. `feat(contract,collab-api): RuntimeType 扩展 nodejs/python 四值并修复三元映射陷阱`（gate A）
2. `feat(desktop): 新增 run_plugin_script/probe_script_runtime 命令支持本地脚本预览`（gate B）
3. `feat(desktop): PreviewPanel 按 runtime 分派 + ScriptPreviewPanel 终端预览`（gate C）

---

## 11. 完成定义（DoD）

- [ ] gate A/B/C/D 全部通过。
- [ ] 父 PRD AC3（Node/Python 生成 → 预览执行展示 stdout → 缺失提示）可复现。
- [ ] 父 PRD AC7（契约与后端一致、spec 回归）通过。
- [ ] design.md 标注的后续大任务（OS 级隔离、script.node/python capability、Web 端运行）已在代码注释/文档留 TODO。
- [ ] 无遗留 TBD / 占位符；所有改动可本地重复验证。
