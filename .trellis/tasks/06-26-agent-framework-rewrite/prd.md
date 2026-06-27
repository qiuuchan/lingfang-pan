# PRD：Agent 框架重写与目录统一

## Goal

用 OpenAI Agents SDK 重写整个插件创建 Agent，废弃 `plugins-draft` 双轨改为统一写入 `plugins_root/{id}/`，工具按 Claude Code 风格命名并引入 read-before-edit，精简思考与工具卡片样式，最后用真实后端账号实测创建/运行/发布全流程。

## 问题背景

当前 Agent 是 `apps/desktop/src/components/creator/FloatingCreator.tsx` 里手写的 `streamText` + `stepCountIs` 循环，工具在 `apps/desktop/src/lib/plugin-creator/creator-tools.ts`，HITL 靠手写 deferred（`pendingAnswersRef`）挂起。问题多、易卡死。

存在两套互相独立的插件目录：

- `plugins-draft/{id}/`（`apps/desktop/src-tauri/src/draft_plugin.rs`）—— AI 草稿，**无运行时环境**（无 venv/node_modules/data）。
- `plugins_root/{id}/`（`apps/desktop/src-tauri/src/plugin_store.rs`）—— 真正安装/扫描/启动，**有** venv/node_modules/data。

后果：草稿页的"运行"是把文件读进内存模拟跑，和正式插件的真实运行行为不一致；Python/Node 草稿无法真正装依赖运行；文件散落在内存态 `StagedPlugin`、`plugins-draft/`、`plugins_root/` 三处。

## 已确认可复用事实

- relay 支持流式 `tool_calls` 透传（`apps/collab-api/src/modules/relay/forwarders.ts`、`apps/collab-api/src/modules/relay/protocol-convert.ts`）。
- Rust 已注册命令可直接复用：`write_plugin_files`、`read_local_plugin_file`、`scan_plugin_status`、`rename_plugin_dir`、`start_plugin`、`stop_plugin`、`delete_plugin`。
- `ai@^5.0.204` 与 `@openai/agents-extensions` 的 `aisdk()` 适配器（LanguageModelV2）版本匹配。

## 决策（已确认）

- 框架：OpenAI Agents SDK（`@openai/agents` + `@openai/agents-extensions`）。
- 目录：彻底统一，废弃 `plugins-draft`，Agent 直接读写 `plugins_root/{id}/`，manifest 用 `draft: true` 标记未发布。

## Requirements

### R1：依赖与模型适配

- `apps/desktop` 加 `@openai/agents`、`@openai/agents-extensions`。
- 新建 `apps/desktop/src/lib/agent/model.ts`：用 `aisdk()` 包 `apps/desktop/src/lib/relay-provider.ts` 现有的 relay 模型（保留 `extractReasoningMiddleware` 的 `<think>` 抽取），产出 Agents SDK 的 model。
- 走 Chat Completions（非 Responses API）。

### R2：Rust 目录统一（废 plugins-draft 双轨）

- 在 `plugin_store.rs` 补齐 Agent 需要的细粒度命令（若缺）：`read_plugin_file_in_root`（单文件读）、`list_plugin_files`（列文件树）、`write_plugin_file`（单文件写）、`set_plugin_draft_flag`。复用现有 `sanitize_plugin_id` 防穿越。
- manifest 增加 `draft: bool`；`scan_plugin_status` 输出 `draft` 字段。
- 旧 `draft_plugin::*` 命令保留为只读迁移用途，不再写入。
- 从 `main.rs` `invoke_handler` 评估移除已废弃的 draft 写命令。

### R3：工具层重写（Claude Code 命名 + read-before-edit）

新建 `apps/desktop/src/lib/agent/tools.ts`，用 `@openai/agents` 的 `tool()`，全部指向 `plugins_root/{id}/`：

| 新工具（PascalCase） | 替代 | execute |
|---|---|---|
| `Read` | read_draft_file | `read_plugin_file_in_root` |
| `Write` | patch_draft_file（整写） | `write_plugin_file` |
| `Edit` | patch_draft_file（替换） | 读→字符串替换→写；**未 Read 过则报错** |
| `Glob` | list_draft_files | `list_plugin_files` |
| `CreatePlugin` | stage_plugin | 建目录 + manifest(draft:true) + 脚手架 |
| `WebSearch` | web_search | `/api/search` |
| `Check` | check_plugin | 复用 `validateStagedCompleteness` 等校验 |
| `AskQuestion` | ask_question | 走框架 HITL（`needsApproval`/interruptions） |
| `ListTeamPlugins` | list_team_plugins | `/api/plugins` |

- read-before-edit 用一个 per-run 的 readPaths Set 跟踪。
- 保留 `creator-tools.ts` 里的纯校验函数（`validateStagedCompleteness`/`isSafePath`/`buildStagedManifest`），只换工具壳。

### R4：Agent 循环 + HITL 重写

- 新建 `apps/desktop/src/lib/agent/run.ts`：定义 `Agent`（instructions 用精简后的 system prompt），用 `run(agent, input, { stream: true })`。
- HITL：`AskQuestion` 和发布前确认用 `needsApproval` → run 暂停返回 `interruptions` → UI 收集用户输入 → `result.state.approve/reject` + 从 `RunState` resume，替换 `pendingAnswersRef` 手写挂起。
- 上下文：沿用 `apps/desktop/src/lib/plugin-creator/context-compress.ts` 的摘要策略，接到新循环的 history 输入。

### R5：运行路径统一 + UI 精简

- `apps/desktop/src/pages/plugins/use-plugin-center.ts` 的 `openDraftPlugin` 改为走 `openLocalPlugin` 同一条带运行时的启动路径（从 `plugins_root` 读，Python/Node 真实装依赖）。
- `apps/desktop/src/pages/plugins/DraftPluginsSection.tsx` 草稿列表数据源从 `listDraftPlugins` 改为 `scanPluginStatus` 过滤 `draft:true`。
- 精简思考样式：reasoning 默认折叠一行（`✦ 已思考`），点击展开。
- 精简工具卡片 `apps/desktop/src/components/creator/ToolCallCard.tsx`：去渐变/blur/大阴影，改 `size-4` 行内图标 + 一行摘要 + 状态点，`rounded-md`；更新 `TOOL_META` 为新工具名。

### R6：旧代码清理与数据迁移

- 删除 `FloatingCreator.tsx` 的手写循环，改为调用 `lib/agent/run.ts`。
- 一次性迁移：启动时若存在 `plugins-draft/*`，搬到 `plugins_root/{id}/`（manifest 标 draft:true）后清理。
- 移除 `creator-tools.ts` 的旧 `tool()` 声明（保留校验函数）。

### R7：真实后端实测

后端 `http://106.12.131.38:19006/`，用用户提供的账号登录（凭据仅用于实测，不写入仓库/不回显）：

1. `pnpm -C apps/desktop dev` 启动桌面端，登录。
2. 让 Agent 创建一个 client(HTML) 插件 → 验证写入 `plugins_root/{id}/`、草稿页可见、可运行。
3. 创建一个 python 插件 → 验证 venv + pip 装依赖 + 真实运行。
4. 回到 Agent 用 `Edit` 改文件 → 验证 read-before-edit 与增量修改。
5. `AskQuestion`/发布确认 → 验证 HITL 暂停/恢复。
6. 点发布 → 验证 `POST /api/plugins/upload` 成功、团队插件列表出现。
7. 验证思考折叠、工具卡片精简样式。

## Acceptance Criteria

- [ ] Agent 全程基于 `@openai/agents`，无手写 `streamText`+`stepCountIs` 循环。
- [ ] 只有一套插件目录 `plugins_root/{id}/`，无 plugins-draft 写入。
- [ ] 工具按 Claude Code 风格命名，`Edit` 强制先 `Read`。
- [ ] 草稿页/插件页共用同一带运行时启动路径。
- [ ] HITL 走框架 interruptions/RunState。
- [ ] 思考默认折叠、工具卡片精简。
- [ ] 真实后端实测：client + python 插件 创建→运行→修改→发布 全通过。

## 非目标

- 不改 relay 后端协议（已支持 tool_calls）。
- 不引入多 Agent handoffs（本期单 Agent，handoffs 留待后续）。
- 不做插件市场/审核流程改动。
