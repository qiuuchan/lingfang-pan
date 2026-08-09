# 适配检验改造（Adaptation Pipeline）

适配检验改造是插件「发布前最后一公里」的自动化流水线：把一份**未经平台规范校验**的插件目录，
经过「静态校验 → 确定性改造 →（可选）运行时确证」三步，改造为可直接发布的合规制品，并产出一份
**适配报告（AdaptationReport）**随发布上送服务端摄入闸复核留证。

它同时服务于两条路径：

- **CLI**：`lingfang-plugin adapt`，插件作者本地自检与改造；
- **桌面端**：`PublishPluginDialog` 里的「适配校验并打包」按钮，一键跑完整链路并发布。

两者的底层是同一个引擎——`packages/plugin-sdk/dist/adapt.mjs`（单文件 ESM，仅依赖 node 内置模块，
作为 Tauri 资源随桌面分发）。引擎协议与宿主命令 `run_plugin_adapt` 见 [协议](#引擎协议)。

---

## 为什么要适配

灵坊插件**不直连第三方 AI 服务、不持有平台密钥**：所有越权操作都经宿主注入的桥
（`window.__lingfangInvoke` 或脚本桥 `LINGFANG_PLUGIN_BRIDGE_URL`）中转。但外部拿到的插件源码常常：

- 缺 `id` / `version` / `visibility` / `entry` 等边界字段；
- 入口扩展名与 `runtime_type` 不匹配；
- 在源码里硬编码 `api_key`、`base_url`、`provider`、真实模型名；
- 声明的能力清单与实际代码调用不一致。

适配流水线把这些**可确定性修复**的问题自动改掉，并**如实暴露**只能人工处理的问题，
避免把「看起来能跑但违反隔离边界」的插件直接发布上线。

---

## 三个阶段

| 阶段 | 做什么 | 是否修改文件 | 产物 |
| --- | --- | --- | --- |
| 1. 静态校验 | 读 manifest + 目录结构 + AI 边界启发式扫描 | 否（只读） | `AdaptationIssue[]` |
| 2. 确定性改造 | 应用 A1–A5 确定性 codemod | 是（仅临时工作区） | `FixApplied[]` |
| 3. 运行时确证 | 可选：短跑 / 编译检查 / 桥握手 | 否 | `RunEvidence[]`, `canRun` |

> 改造**永远只在拷贝出的临时工作区**进行，绝不触碰用户原始源码；`--in-place` 是显式危险选项。

### 阶段 1：静态校验（`validateWorkspace`）

扫描出所有问题，每条带 `code` / `category` / `severity` / `fixable`：

- `severity: 'auto_fixable'`：阶段 2 能确定性修掉；
- `severity: 'needs_human'`：无法自动推断，必须人工处理；
- `fixable: true/false`：与 `severity` 同向，供程序消费。

常见 `code`（详见[错误码表](#错误码与严重度)）：`manifest_not_found`、`entry_not_found`、
`leaked_openai_key`、`hardcoded_base_url`、`requirements_invalid_format` 等。

### 阶段 2：确定性改造（A1–A5）

全部幂等（重复执行结果一致）。

| 编号 | 作用 | 典型 `code` |
| --- | --- | --- |
| **A1** | 补齐缺字段：`id` / `runtime_type` / `entry` / `version` / `visibility` | `A1_id`、`A1_runtime`、`A1_entry`、`A1_version`、`A1_visibility` |
| **A2** | `entry` 与 `runtime_type` 不匹配时改写扩展名 / 指向默认 / 生成最小骨架 | `A2_entry_ext`、`A2_entry_default`、`A2_entry_skeleton` |
| **A3** | 扫描源码 import / API 调用，补缺失 `capabilities`（最少权限，低风险） | `A3_capabilities` |
| **A4** | AI 边界归一化：硬编码 `base_url` / `provider` / 真实模型名 / `api_key` → 桥接写法 | `A4_base_url`、`A4_provider`、`A4_model`、`A4_key` |
| **A5** | python 缺 `requirements.txt` 但检测到第三方 import → 生成最佳猜测清单 | `A5_requirements` |

> **A4 只对 `.py` / `.js` / `.mjs` / `.cjs` / `.ts` / `.tsx` 生效**，对 HTML `<script>` 里的
> 硬编码**只检测、不自动改写**（见[已知边界](#已知边界-html-里的硬编码不自动修)）。

### 阶段 3：运行时确证（可选）

`--execute` 时运行：python `py_compile`、node `--check`、client HTML 有效性 + `__lingfangInvoke`
存在性检查、桥握手等。产出 `runEvidence[]` 与 `canRun`。无显示器 / 无对应运行时环境时跳过
（`--no-execute`），此时 `canRun=false` 但**不影响**「改造是否通过」的判断——它只回答「改完能不能跑」。

---

## 适配报告（AdaptationReport）

引擎写出一份结构化报告（协议里是单行 JSON）。关键字段：

| 字段 | 含义 |
| --- | --- |
| `ok` | 整体是否通过：`remaining` 为空 且 未出现「确证失败」 |
| `status` | 见下方枚举 |
| `issues` | 静态校验发现的所有问题 |
| `fixesApplied` | 阶段 2 实际应用的改造（带 `code` / `category` / `path` / `diff`） |
| `remaining` | 改造后仍需人工 / agent 处理的问题（`severity` 为 `needs_human` 或 `auto_fixable` 未修的） |
| `canRun` | 是否确证可运行（仅执行了运行时检查才可能为 `true`） |
| `runEvidence` | 确证证据项（方法 / 是否通过 / 耗时） |
| `engineVersion` | 引擎版本（如 `0.1.0`），服务端据此区分行为 |
| `summary` | 人类可读摘要 |

### status 枚举

| `status` | 触发条件 | 能否带着发布 |
| --- | --- | --- |
| `NOT_RUN` | 纯静态校验，没跑改造流水线（`--dry-run` 语义） | 否 |
| `ADAPTED_PASSED` | 跑了改造，零残留问题，且（若执行）确证能跑 | 是 |
| `NEEDS_HUMAN` | `remaining` 里存在 `needs_human` 问题 | 需人工处理后重跑 |
| `ADAPTED_FAILED` | `remaining` 非空（残留 `auto_fixable` 未修），或执行了确证但 `canRun=false` | 需修复后重跑 |

> `ok: true` **可以**携带 `NEEDS_HUMAN`：即「改造通过、但仍有需人工确认的问题」。发布侧以
> `status` 为准，不要只看 `ok`。

---

## CLI 用法

```powershell
# 静态校验（不改造、不确证）→ status=NOT_RUN
pnpm plugin:adapt .\my-plugin

# 改造 + 重打包成 .lfplugin（不执行运行时确证）
lingfang-plugin adapt .\my-plugin --repack --out .\out

# 改造 + 执行运行时确证 + 重打包
lingfang-plugin adapt .\my-plugin --execute --repack --out .\out

# 机器可读 JSON 输出（报告原样打印）
lingfang-plugin adapt .\my-plugin --json
```

参数：

| 参数 | 作用 |
| --- | --- |
| `--execute` | 执行运行时确证（需本机有对应运行时） |
| `--repack` | 改造后重新打包成 `.lfplugin` |
| `--out <dir>` | 打包输出目录 |
| `--in-place` | **危险**：原地改造（默认拷贝到临时工作区） |
| `--json` | 输出 JSON 格式（供程序消费） |

退出码：`0` 成功（改造通过）；`1` 失败（存在残留问题 / 确证失败 / 引擎错误）。

---

## 桌面端一键适配

桌面 `PublishPluginDialog` 的「制品」页：

1. 选插件目录（文件夹选择器）→ 引擎只在临时工作区改造；
2. 点「适配校验并打包」→ 宿主命令 `run_plugin_adapt`（`mode:'adapt'`、`execute:true`、`repack:true`）；
3. 报告面板按 `status` 分色展示（通过 / 需人工 / 失败）；
4. 发布时把 `reportId` 随请求上送，服务端摄入闸复核并落库（见[服务端摄入闸](#服务端摄入闸)）。

---

## 真实示例

### 通过：python 插件（缺字段 + 硬编码凭据）

输入 `manifest.json` 没有 `id` / `version` / `visibility`，`main.py` 里写了
`api_key="sk-..."` 和 `base_url="https://api.openai.com"`，且没 `requirements.txt`。

```
适配检验改造：适配通过（应用 7 项自动改造）

✓ 已应用的自动改造:
   - [A1_id] 补齐/修正 id → lingfang-smoke-python (id)
   - [A1_version] version 缺省为 0.1.0 (version)
   - [A1_visibility] visibility 缺省为 private (visibility)
   - [A3_capabilities] 补齐能力：net.fetch, fs.read (capabilities)
   - [A4_base_url] base URL 归一化为桥接模式 (main.py)
   - [A4_key] 硬编码凭据改写为桥接 token (main.py)
   - [A5_requirements] 生成 requirements.txt：requests (requirements.txt)
```

→ `status: ADAPTED_PASSED`，`remaining: []`。

### 失败：client 插件在 HTML 里硬编码 base URL

输入 `ui/index.html` 的 `<script>` 里写了 `const baseUrl='https://api.openai.com'` 和
`const key='sk-...'`：

```
适配检验改造：适配未完成：剩余 2 项待人工/agent 处理（已应用 4 项自动改造）

✓ 已应用的自动改造:
   - [A1_id] 补齐/修正 id → base-url (id)
   - [A1_version] version 缺省为 0.1.0 (version)
   - [A1_visibility] visibility 缺省为 private (visibility)
   - [A3_capabilities] 补齐能力：net.fetch, ui.view (capabilities)
✗ 仍需人工/agent 处理:
   - [auto_fixable] ai_boundary: 检测到硬编码 OpenAI 风格 API Key，应改用平台桥接 token (ui/index.html:3)
   - [auto_fixable] ai_boundary: 检测到硬编码 base URL，脚本应使用 LINGFANG_PLUGIN_BRIDGE_URL 拼接 /v1 (ui/index.html:2)
```

→ `status: ADAPTED_FAILED`，`remaining` 含 `leaked_openai_key` + `hardcoded_base_url`。

**为什么没自动修？** A4 只改写脚本源文件（`.py` / `.js` / `.ts`），HTML 里的硬编码只检测不修，
避免误改 DOM 结构。修复方式：把 `fetch(baseUrl + '/v1/chat', ...)` 改为走宿主桥
（`window.__lingfangInvoke('llm.chat', {...})`，或服务端脚本桥 `LINGFANG_PLUGIN_BRIDGE_URL + '/v1'`）。

---

## 错误码与严重度

| `code` | `category` | `severity` | 自动修？ | 说明 |
| --- | --- | --- | --- | --- |
| `manifest_not_found` | manifest | needs_human | 否 | 缺 `manifest.json`，无法推断 |
| `manifest_invalid_json` | manifest | needs_human | 否 | `manifest.json` 非合法 JSON |
| `entry_not_found` | structure | auto_fixable | 是（A2） | 入口文件不存在 |
| `package_json_invalid` | structure | auto_fixable | 是 | `package.json` 非合法 JSON |
| `requirements_invalid_format` | dependency | needs_human | 否 | `requirements.txt` 某行格式不合法 |
| `leaked_openai_key` | ai_boundary | auto_fixable | 是（A4_key） | 硬编码 OpenAI 风格 Key |
| `leaked_api_key` | ai_boundary | auto_fixable | 是（A4_key） | 硬编码 `api_key` 字面量 |
| `hardcoded_base_url` | ai_boundary | auto_fixable | 仅脚本文件（A4） | 硬编码 base URL（HTML 不自动修） |
| `hardcoded_provider` | ai_boundary | auto_fixable | 是（A4_provider） | 硬编码 provider |
| `hardcoded_model_name` | ai_boundary | auto_fixable | 是（A4_model） | 硬编码真实模型名 |
| `invalid_id` / `invalid_version` / `entry_runtime_mismatch` / `unsafe_entry_path` / `unknown_capability` / `duplicate_capability` | manifest | auto_fixable | 是 | manifest 字段类可自动修正项 |
| 其它 manifest 错误（如 `missing_name`、`invalid_runtime_type`、`unknown_visibility`） | manifest | needs_human | 否 | 需人工提供元信息 |

> 报告里 `detail` 对密钥类命中**只回显首尾各 4 字符并打码**（如 `sk-a…wxyz`），明文 key 不会进报告，
> 因为报告会随发布上送服务端并落库——明文落库即持久化泄漏。

---

## 已知边界

### HTML 里的硬编码不自动修

如上，A4 的 base URL / key 归一化只针对脚本源文件。client 插件若把第三方端点写进
`ui/index.html` 的 `<script>`，会被 `hardcoded_base_url` / `leaked_openai_key` 检出但保留为
`remaining`，导致 `ADAPTED_FAILED`。正确做法是用宿主桥而非直连。

### AI 策略闸门（服务端）可能二次拒绝

改造通过（`ADAPTED_PASSED`）只代表**引擎**认为合规。服务端另有 AI 策略闸门
（`docs/api-reference/plugin-ai-policy.md`），例如第三方模型 SDK 依赖（`ai.sdk.third_party`）、
自定义桥兜底（`ai.bridge.custom`）等，可能在**发布**环节再次拒绝。这类拒绝与适配报告是两层独立校验：
先过引擎改造，再过服务端策略。

---

## 服务端摄入闸

改造通过的报告会：

1. 先 `POST /api/plugin-registry/adaptation-reports` 暂存 → 拿到 `reportId`；
2. 发布请求（`POST /api/plugin-registry/releases` 或桌面发布）携带
   `x-adaptation-report-id` 头；
3. 服务端 rede 该报告、复核、把制品的 `ingestChannel` 置为 `ADAPT` 并留证。

这样每一份以「适配」方式进入平台的插件，都能在服务端追溯到其改造报告与引擎版本。

---

## 引擎协议

宿主（桌面 Rust 或冒烟脚本）与 `adapt.mjs` 通过 **stdin / stdout 各一行 JSON** 通信：

- 父进程写 **一行** 到 stdin：`{ "mode", "pluginDir", "inPlace", "execute", "repack", "outDir", "runtime" }`
- 子进程写 **一行** 到 stdout：`{ "ok": true, "report": <AdaptationReport> }` 或
  `{ "ok": false, "error": { "message": "..." } }`
- 诊断信息走 stderr。

> **并发读管道**：父进程必须**同时** drain stdout 与 stderr。报告 JSON 可达数十 KiB，
> 若只顺序读一侧，管道写满即死锁（历史缺陷 `3c4b3408`）。冒烟脚本与宿主命令都据此实现。
