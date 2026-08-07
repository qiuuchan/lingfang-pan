# 插件创建对话式重构与语言扩展

## Goal（目标）

把桌面端「创建插件」从「单轮一次性 CLI + 前端硬编码兜底」重构为**真正的对话式创建流程**：像正常对话一样先聊清需求、支持多轮追问迭代，由本地代码助手 CLI 真正产出结构化的插件包（manifest + 多文件代码），输出像对话一样美化（Markdown 渲染 + 代码高亮 + 复制），并新增 Node.js / Python 语言支持与本地预览执行，同时修复插件页面贴边/间距样式问题与错误抛出的友好度。

> 现状（探索与研究已确认）：当前虽已是「对话式 UI」外壳，但前端 `buildLocalDraft` 把 CLI 输出当纯文本兜底、丢弃结构化产出；多轮被 Rust 硬编码拒绝；capabilities 契约存在会导致上传 400 的 bug；无语法高亮、无代码复制、无 Node/Python 运行时。

## Scope（范围）

本父任务为**多交付物整合任务**，不直接承担实现，仅持有需求源、任务地图、跨子任务验收与最终集成。实现下沉到 5 个可独立规划/实现/检查/归档的子任务。

### 用户决策（已确认，作为全树约束）

1. **多轮范围**：三 CLI（claude / codex / opencode）都支持多轮追问。claude 用原生 `--resume`；codex/opencode 降级为「历史摘要拼进新 session」的伪多轮（用户可感知但上下文非真复用）。
2. **后端契约**：本轮一并扩展后端契约（RuntimeType 四值 + Prisma enum + 迁移 + 校验），使 Node/Python 插件可上传云端，避免功能不闭环。
3. **预览交互**：Node/Python 本地预览执行采用「无参数一次性运行 + 带超时」（`run_capture` 模式），首轮不支持参数输入与长会话。
4. **高亮主题**：代码块统一用 `github-dark` 固定主题（暂不跟随亮/暗切换）。

## Requirements（需求）

### R1 对话式多轮创建（子任务：conversational-multiturn）

- 用户在同一会话内可追问澄清需求、基于生成结果继续迭代修改。
- 不再每轮 `setCurrentDraft(null)` 清空；草稿与对话历史跨轮累积。
- 三 CLI 均可多轮；非真复用的 CLI（codex/opencode）需对用户透明提示降级语义。
- 多轮失败（会话已退出 / cli_session_id 缺失）必须有明确 UI 反馈，不得静默失败。

### R2 代码助手结构化输出与解析（子任务：structured-output-parsing）

- CLI 真正产出符合契约的结构化插件包（`manifest.json` + 多文件代码），前端解析采用，**不再硬编码兜底覆盖**。
- 采用「文本内约定标记」协议（` ```lingfang-manifest json` / ` ```file path=` / ` ```lingfang-notes`），跨三 CLI 零适配。
- 容错：部分缺失用前端兜底补全，完全失败退回当前行为并标记 `invalid`。
- **修复 capabilities 契约 bug**：产出对象数组 `{kind,reason,risk,requires_admin,scope?}`，kind 命中白名单（`code-assistant.run` 等），**绝不再用裸 `code-assistant`**。`uploadCloud` 流程不再被后端 400 拒绝。

### R3 Node/Python 语言与本地预览执行（子任务：node-python-local-exec）

- 支持生成 Node.js / Python 插件（按运行时语言分模板），并可在本地预览执行。
- 桌面壳新增 `run_plugin_script` 命令，复用 `code_assistant.rs` 子进程基础设施（探测解释器、超时、流式/同步回传、sandbox 落盘）。
- PreviewPanel 按 runtime 分派：client→iframe，nodejs/python→终端输出组件（stdout/stderr/exitCode/超时标记）。
- 解释器缺失时友好提示安装指引，并提供「仍要预览源码」降级。
- **契约一并打通**：RuntimeType 扩为 `client|cloud|nodejs|python`，后端校验、Prisma enum、新迁移、前端类型同步。
- 安全边界：本轮 sandbox 仅软隔离（用户权限运行），design 必须标注后续 OS 级隔离为独立大任务。

### R4 输出渲染美化（子任务：output-rendering-polish）

- 引入 `rehype-highlight`（github-dark 主题），代码块语法高亮覆盖 Node/Python/HTML/JS/TS 等常见语言。
- 区分 inline code 与 fenced code block（react-markdown v10 用 className 正则，非已废弃的 `inline` prop）。
- fenced 代码块带复制按钮（挂 pre 层，`navigator.clipboard`）、最大高度约束、横向滚动。
- 流式过程中的 assistant 内容复用同一 Markdown 组件（含高亮），与最终态观感一致。

### R5 样式与错误友好化（子任务：styling-and-error-polish）

- 修复 Composer 输入框贴边（Textarea 被 `p-0` 清零默认 padding）、诊断文本裸 `<p>` 无容器、Bubble 错误态无内 padding、Info 组件 truncate 截断关键信息、aside 固定 420px 无响应式。
- 制定全局滚动条策略（当前 `index.css` 全局隐藏滚动条导致溢出不可见），区分「装饰性隐藏」与「功能性需可见」。
- 创建过程中所有错误（CLI 启动失败、transcript 读取失败、上传 4xx/5xx、解释器缺失、超时）以**对话气泡/友好卡片**形式抛出，而非裸 toast 或静默。

## Constraints（约束）

- **语言**：所有产出（文档、注释、commit）使用简体中文（遵循全局 CLAUDE.md）。
- **文件操作**：用专用工具（Read/Write/Edit/Glob/Grep），禁用 Shell 直接操作文件。
- **包管理**：前端用 pnpm；Python 脚本走 `py` launcher（Windows `python` 是 Store stub）。
- **架构优先级**：复用既有基础设施——code_assistant 的子进程骨架、契约层 zod、shadcn/ui 组件、react-markdown 生态。禁止重复造轮子（见探索发现的「可复用组件清单」）。
- **契约顺序**：contract-first，先改 `packages/contract` → typecheck → 后端 → migrate → 前端 → 回归测试。
- **破坏性变更**：capabilities 字符串数组形态不做向后兼容（属于 bug 修正）；RuntimeType 扩展为破坏性 enum 变更，按 contract-first 全链路同步。
- **本地验证**：所有改动提供本地可重复验证步骤（单元测试 / 真实 CLI 探针 / 手动预览），失败即止，禁带缺陷交付。
- **不新增 template/language 冗余字段**：语言由 `runtime_type` + entry 后缀推断，符合 schema-contracts.md 字段最小化要求。

## 子任务地图

| 子任务                            | 职责                                                                         | 依赖                                                         |
| --------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `06-13-conversational-multiturn`  | 多轮 send_input 解锁、turns 累积、生成后迭代                                 | 依赖 R2 的结构化协议（迭代需基于结构化草稿）                 |
| `06-13-structured-output-parsing` | systemPrompt 协议、parseStructuredPackage、normalizeCapabilities、修契约 bug | **核心基础**，无前置依赖；R1/R3 依赖它                       |
| `06-13-node-python-local-exec`    | run_plugin_script 命令、预览分派、契约四值扩展                               | 依赖 R2 的结构化产出（Node/Python 代码需被正确解析为多文件） |
| `06-13-output-rendering-polish`   | rehype-highlight、inline/fenced 区分、复制按钮、流式高亮                     | 独立，可与其它并行                                           |
| `06-13-styling-and-error-polish`  | 贴边修复、滚动条策略、aside 响应式、错误友好抛出                             | 独立，可与其它并行；但作用于同一主链路需协调                 |

> 依赖仅写在各子任务 `implement.md`，树结构本身不表达依赖（遵循 Trellis 规范）。

## Acceptance Criteria（跨子任务集成验收）

- [ ] AC1 端到端对话创建：输入需求 → CLI 生成 → 结构化解析出 manifest+多文件 → 右侧详情正确展示 → 上传团队**成功**（不再 400）。
- [ ] AC2 多轮迭代：在同一会话追问「把按钮改成红色」→ 草稿更新反映修改，turns 累积，三 CLI 均可操作（claude 真 resume，codex/opencode 降级可用且透明提示）。
- [ ] AC3 语言支持：分别生成 Node.js 与 Python 插件 → 预览执行展示 stdout → 解释器缺失时友好提示。
- [ ] AC4 输出美化：AI 回复中的代码块有语法高亮、可一键复制；流式过程与最终态观感一致。
- [ ] AC5 样式：Composer 输入不贴边、诊断/错误文本有容器与 padding、长内容溢出有可见滚动指示、窄窗口下布局不挤压。
- [ ] AC6 错误友好：CLI 失败、上传失败、解释器缺失、超时等均以对话/卡片友好展示，无裸 toast 或静默。
- [ ] AC7 契约一致：`packages/contract` 与后端 `plugin-package.ts` 白名单/枚举一致；plugin.service.spec / collab.service.spec 回归通过。
- [ ] AC8 本地验证：每个子任务的验证步骤均可重复执行并通过。

## Notes

- 父任务不直接实现；完成后需做**最终集成 review**（端到端 AC1-AC8）。
- 各子任务 `design.md` / `implement.md` 须基于本 PRD 的约束与已确认决策撰写。
- 研究结论（5 维度）已落库于会话上下文与项目记忆 [[plugin-creator-flow]]，子任务 design 直接引用其精确行号与方案。
