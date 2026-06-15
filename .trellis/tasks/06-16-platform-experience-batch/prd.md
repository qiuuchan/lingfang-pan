# 前台体验与插件生态改进批次（模型选择/使用流程/换装/笔记/连接失败页/拖动/安装器）

## Goal

一次性改进 LingFang 平台的终端用户体验与插件生态：修正模型选择器只展示上游真实模型、统一插件"使用"流程（Python/Node 进入后触发启用）、复刻 AI 换装批量版与新增 Node.js 笔记插件、美化后端不可达页、修复全场景窗口拖动、美化安装器，最后统一 review + 实际验证。

本父任务 owns 源需求集合、子任务映射、跨子任务验收与最终集成 review；自身不做直接实现，按子任务逐个推进。

## Requirements

### R1 模型选择器只显示上游模型
- 创建器模型下拉框不再硬编码展示 sonnet/opus/gpt-5.5 等预设模型，改为优先从已配置的上游 LLM 获取的 `modelOverride` / `defaultModels` 取值；上游未配置时给明确引导。
- "自定义"按钮点击行为改为跳转到设置页（gateway tab），不再就地展开输入框。

### R2 插件"预览"改名"使用插件"
- 创建器中"预览"按钮、引导任务文案、相关标题（"插件预览"等）统一改为"使用插件"。
- 保留底层预览/运行能力（按 runtime 分派不变），仅改面向用户的措辞。

### R3 Python/Node 插件进入后触发启用
- 已安装插件列表（`Plugins.tsx`）对 `runtime_type` 为 `nodejs`/`python` 的插件提供"使用/启用"入口。
- 进入插件后：探测本地运行时（node/python），若缺失则引导安装；脚本型走 `run_plugin_script` 执行，结果回显（参照 ScriptPreviewPanel 现有逻辑复用到已安装运行态）。

### R4 用 CLI 复刻 AI 换装批量版
- 【特例授权】换装产物**代码必须由 code-assistant CLI（claude/codex/opencode）生成**，Claude 不直接编写换装业务代码；Claude 负责需求拆解、prompt 工程、集成与验证。本项为 CLAUDE.md "记录在案的特例批准"。
- 借用源文件 `o:\lingfang-platform\ai换装版本批量版.py` 的逻辑：远程 `gpt-image-2` 图像编辑 API、中文 prompt 模板、批量（服装×模特笛卡尔积）+ 并发执行 + 重试退避。
- 不复用源文件代码，由 CLI 重新生成。
- 形态：内置 python runtime 插件（builtin-plugins），UI 在 client 容器、图像处理通过 python 脚本 capability 调用；或独立 Qt 应用由插件直接拉起——以 CLI 生成结果为准，需能被桌面壳启动。
- **API key 处理：保留源文件原 key（`sk-sQX…`）作为默认值**（用户授权）。

### R5 Node.js 小插件（笔记软件）
- 【特例授权】代码由 code-assistant CLI 生成，Claude 负责集成与验证。
- MVP 功能：Markdown 笔记增删改查、分类/标签、AI 总结笔记（sdk.llm.chat）、全文搜索。
- 形态：nodejs runtime 内置插件，capabilities 含 fs/storage/llm.chat。

### R6 后端不可达页美化
- 当 fetch 后端失败（localhost 拒绝连接）时，桌面端展示一个友好的"无法访问此页面"组件，而非仅 toast。
- 提供重试、去设置（配置后端地址）、查看日志等操作。

### R7 全场景窗口拖动检查与修复
- 核查所有页面顶部容器与弹窗（含悬浮窗在顶部时）均可拖动。
- 修复缺失 `data-tauri-drag-region` / `startDragging` 的顶部容器（尤其顶部悬浮窗场景）。

### R8 安装器美化
- Tauri bundle 元数据补齐（copyright / shortDescription / longDescription / publisher / category）。
- NSIS 子配置：installerIcon、headerImage/sidebarImage、languages（含简体中文）、license（可选）。
- 图标替换为项目品牌（利用 `tools/generate_logo.py`）。

### R9 统一 review + 实际验证
- 对 R1–R8 所有改动做一次综合代码审查（跨子任务一致性、回归风险）。
- 本地实际验证（启动后端 + 桌面壳，逐项跑通），证据留痕。

## Acceptance Criteria（父级，跨子任务）

- [ ] R1 模型选择器只显示上游真实模型，"自定义"跳设置页
- [ ] R2 "预览"全部改为"使用插件"，文案一致
- [ ] R3 Python/Node 插件进入后可启用/使用，运行时缺失有引导
- [ ] R4 换装批量版可运行（单图 + 批量），逻辑由 CLI 生成、保留原 key
- [ ] R5 笔记插件 CRUD/分类/AI 总结/搜索可用
- [ ] R6 后端不可达页友好展示，可重试/去设置
- [ ] R7 所有页面顶部与顶部悬浮窗可拖动
- [ ] R8 安装器元数据 + NSIS 美化生效，构建可出包
- [ ] R9 综合审查通过，本地验证逐项跑通并留痕
- [ ] 改动遵循既有代码风格、不破坏现有功能

## Sub-Task Map

| 子任务 | 对应需求 | 独立验收 |
|--------|----------|----------|
| model-selector-upstream | R1 | 是 |
| plugin-use-rename | R2 | 是 |
| python-node-enable | R3 | 是 |
| ai-wardrobe-clone | R4（CLI 生成） | 是 |
| nodejs-notes-plugin | R5（CLI 生成） | 是 |
| backend-unreachable-page | R6 | 是 |
| window-drag-fix | R7 | 是 |
| installer-beautify | R8 | 是 |
| batch-review-verify | R9（依赖前置完成） | 是 |

## Constraints

- 语言：所有面向用户内容、注释、commit 用简体中文。
- 文件操作：用 Write/Edit/Read/Glob/Grep，禁止 Shell 直接改文件。
- 安全：除已授权的换装默认 key 外，不新增硬编码密钥。
- 颠覆式更改：R1 改硬编码预设模型属破坏性改动，需提供回退（上游未配置时的引导路径），不保留旧的"就地展开输入框"行为。
- R4/R5 为特例授权的 CLI 生成项，需在 design 里说明协作模式。

## Notes

- 父任务 owns 跨子任务集成与最终 review（R9）。
- R9 依赖 R1–R8 基本完成，子任务 prd 里注明顺序。
- 仓库记忆：双后端已收敛到 collab-api(:3000)，桌面壳 pnpm start 编排，fetch vs tauriInvoke 双通道，release exe origin 是 tauri.localhost。
