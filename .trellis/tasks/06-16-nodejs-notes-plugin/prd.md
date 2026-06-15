# Node.js 笔记小插件

## Goal

新增一个 Node.js runtime 内置插件（笔记软件），MVP 含 Markdown 笔记增删改查、分类/标签、AI 总结笔记、全文搜索。代码由 **code-assistant CLI 生成**，Claude 负责需求拆解、集成、验证。

## 特例授权（CLAUDE.md "记录在案的特例批准"）

- 本任务**代码必须由 code-assistant CLI 生成**。Claude 负责：需求拆解（喂 CLI 的需求）、集成进 builtin-plugins、capability 注册、验证。
- 偏离 CLAUDE.md "代码主权归 Claude"，经用户明确授权。

## Requirements

- R5.1 形态：`apps/desktop/builtin-plugins/notes/`，manifest.runtime_type=nodejs，entry=index.js（或 .ts 编译产物），UI 用 client 容器（HTML/JS）。
- R5.2 功能（MVP 全选）：
  - Markdown 笔记增删改查（创建、编辑、删除、列表）
  - 分类/标签（笔记归属文件夹或打标签，按分类/标签筛选）
  - AI 总结笔记（调 `sdk.llm.chat` 对笔记内容生成摘要）
  - 全文搜索（关键词搜笔记标题 + 正文）
- R5.3 持久化：用 `sdk.storage`（kv）或 fs capability 存笔记数据（JSON/Markdown 文件）。
- R5.4 capability 声明：storage.kv / fs.write / fs.read / llm.chat（按实际用到的）。
- R5.5 UI：左侧笔记/分类列表 + 右侧编辑器（Markdown 编辑 + 预览），顶部搜索栏，AI 总结按钮。
- R5.6 由 CLI 生成 index.js 与前端 UI 代码，Claude 集成。

## Acceptance Criteria

- [ ] 笔记插件代码由 CLI 生成（过程可追溯）
- [ ] CRUD：创建/编辑/删除/列出笔记正常
- [ ] 分类/标签：可归类、可按分类/标签筛选
- [ ] AI 总结：选中笔记 → 生成摘要显示
- [ ] 全文搜索：关键词命中标题/正文
- [ ] 数据持久化（重启后笔记仍在）
- [ ] capability 网关校验通过（无越权）
- [ ] lint/type-check 通过

## Design（CLI 协作模式）

- 同 R4：Claude 整理需求文档 → 调 CLI 生成 nodejs 代码 + 前端 UI → Claude 集成 manifest + capability → 验证。
- 数据模型建议：`{ id, title, content, category, tags[], createdAt, updatedAt }`，存 sdk.storage 或 fs JSON。

## Files

- `apps/desktop/builtin-plugins/notes/`（新增：manifest.json + index.js + 前端 UI）

## Notes

- 复杂任务（特例 + CLI 协作）。
- 与 R3 协同：作为 nodejs runtime 插件，"使用"入口依赖 R3 脚本运行能力（但笔记 UI 若走 client 容器 iframe 则另议——需 design 时确定 UI 是 client iframe 还是 nodejs 终端）。
- 笔记 UI 倾向 client runtime（iframe）+ 数据经 sdk 持久化；nodejs entry 可作为数据迁移/AI 批处理脚本。design 阶段定夺。
