# 创建器与 AskQuestion 执行计划

> 关联：`./prd.md`、`./design.md`。
> 顺序原则：先做零风险快赢（R4）→ 纯前端可控（R3）→ 核心功能（R2 AskQuestion）→ 需线上复现的 R1（放最后，复现确认根因再动手）。
> 全程**只改 `apps/desktop/src/...`**，不动 relay 服务端与后端扣费（子任务 A 范围）。

---

## 阶段 0：准备

- [ ] 确认本地能起桌面端：`cd apps/desktop && pnpm install`（若未装）。
- [ ] 阅读 `design.md`，确认 AskQuestion 走方案 A（deferred-execute），方案 B 作为超时降级备选。

---

## 阶段 1：R4 UI 微调（快赢，零风险）

文件：`apps/desktop/src/components/creator/FloatingCreator.tsx`
- [ ] 删除标题栏团队名 Badge（约 333 行 `{session.tenantName ?? '当前团队'}`）。
- [ ] 把「新建对话」按钮（约 407-411）移到「历史」按钮（约 342-345）左侧；保留 `turns.length > 0` 显隐条件。
- [ ] 检查 import：`Badge` 仍被「已压缩 N 轮」用，**不要删** import。

**验证（gate 1）**
- [ ] `cd apps/desktop && pnpm build`（或 `pnpm tsc --noEmit`）通过。
- [ ] 本地起 `pnpm dev` 目视：无团队名、新建按钮在历史左侧、空态下新建按钮不显示。
- [ ] **review gate**：提交前自检 diff 仅触及标题栏。
- [ ] **rollback point**：此处可独立提交一次（R4 完成）。

---

## 阶段 2：R3 历史删除 + 分页（纯前端）

文件：`FloatingCreator.tsx`
- [ ] 新增 `deleteConversation(id)`：filter + `saveConversations` 写回；若删当前会话则 `newConversation()`。
- [ ] 历史 Dialog（542-569）每项加删除按钮（Trash 图标，`onClick` 内 `e.stopPropagation()`），加行内二次确认态。
- [ ] 新增 `historyPage` state + `PAGE_SIZE=8`；渲染 `conversations.slice(...)`；底部加「上一页/下一页 + 第 X/Y 页」。
- [ ] `historyOpen` 打开时 reset `historyPage=0`；删除后空页且非首页自动回退一页。

**验证（gate 2）**
- [ ] `pnpm build` 通过。
- [ ] 目视：造 >8 条对话，分页正常；删除单条后列表与 localStorage 同步；删当前会话后正确重置。
- [ ] **review gate**：diff 仅触及历史相关函数与 Dialog。
- [ ] **rollback point**：可独立提交（R3 完成）。

---

## 阶段 3：R2 AskQuestion 工具 + Claude 风格 UI（核心）

### 3.1 工具定义
文件：`apps/desktop/src/lib/plugin-creator/creator-tools.ts`
- [ ] 新增 `askQuestionParams`（zod：question / options? / allowFreeText / multiSelect），见 design.md。
- [ ] 因 `execute` 需要前端的 deferred resolve（人在环），工具不能在本模块内静态定义 execute。改为**工厂函数**：`createCreatorTools({ onAskQuestion })`，其中 `ask_question.execute` 调用注入的 `onAskQuestion(args)` 返回 `Promise<{answer:string}>`。`upload_plugin` 维持原样。
- [ ] 导出 `createCreatorTools`，保留 `creatorTools`（= 仅 upload，向后兼容）或在 FloatingCreator 改用工厂。

### 3.2 数据结构
文件：`FloatingCreator.tsx`
- [ ] 扩展 `Turn` 增 `parts?`（QuestionPart | tool part），见 design.md。
- [ ] `loadConversations` 容错：老数据缺 `parts` 不报错（filter 已宽松，渲染时 `?? []`）。

### 3.3 send() 接线（方案 A）
- [ ] 新增 `pendingAnswerRef`（存 deferred resolve/reject）。
- [ ] `send()` 里用 `createCreatorTools({ onAskQuestion })` 构造 tools；`onAskQuestion(args)` = 写问题到当前 turn.parts + 返回 deferred Promise。
- [ ] `stopWhen: stepCountIs(4)` → 调大（如 8）。
- [ ] `fullStream` 循环（264-288）：`tool-call`/`tool-result` 分支识别 `ask_question`（设/清等待态）。
- [ ] `stop()` / `selectConversation()` / `newConversation()` / 关窗：清理悬挂 `pendingAnswerRef`（reject 或 resolve 空），防卡死。

### 3.4 提问 UI
- [ ] 在 assistant 气泡渲染 QuestionPart：问题 + 选项 pill + 自由输入 + 提交；作答后只读态。
- [ ] 提交回调：写 `answer`+`answered:true` 到 parts，调 `pendingAnswerRef.resolve(answer)`。
- [ ] 视觉对齐现有 `publishedName` 成功卡片风格（圆角/边框）。

### 3.5 提示词
- [ ] 改 `SYSTEM_PROMPT`（69-82）：信息不足/歧义/多方案选择时**必须调 `ask_question`**，能给 options 就给；需求齐备才调 `upload_plugin`。
- [ ] （可选）新增默认激活 Skill `ask-first` 承载该约束（`skills.ts`），与现有 skills 一致注入。

**验证（gate 3）**
- [ ] `pnpm build` 通过。
- [ ] 线上 `http://106.12.131.38:19006` 复测：发模糊需求（如「做个工具」）→ 模型弹出提问卡片 → 选项作答 → agent 继续生成 → 最终 upload。
- [ ] **若方案 A 出现 SSE 空闲断流** → 切方案 B（design.md），重测。
- [ ] 验证取消/切对话时无悬挂卡死、无控制台报错。
- [ ] **review gate**：确认 tool-call/result 配对、abort 清理到位。
- [ ] **rollback point**：可独立提交（R2 完成）。

---

## 阶段 4：R1 空响应修复（需线上复现）

文件：`FloatingCreator.tsx`（前端兜底）；根因若在 relay 则出报告交子任务 A。
- [ ] **线上复现**（`http://106.12.131.38:19006`，账号密码仅会话用，勿写入文件）：
  - 三路径测试（纯问答 / 触发 upload / 思考模式开关），按 design.md「判定矩阵」定根因 H1-H4。
  - DevTools Network 看 `/api/relay/v1/chat/completions` SSE 原始帧；临时 `console.log(part.type, part)`（提交前移除）。
- [ ] **前端兜底（必做）**：
  - 流结束时（291-296）`content` 空且无工具调用/未取消/未失败 → 友好提示 + `status:'failed'`，替掉裸「无内容」。
  - 工具步可见化：upload 成功但 content 空时补占位文本（或复用 R2 的 parts 渲染工具卡片）。
  - reasoning 兜底（H2）：content 空但 reasoning 非空 → 提示「仅输出思考过程」。
- [ ] **根因归属**：H1/H4 纯前端解（兜底 + 提示词要求工具后必须总结 / 调大 stepCount）；H3 relay 透传问题 → 写定位报告交子任务 A，前端保留兜底。

**验证（gate 4）**
- [ ] `pnpm build` 通过；移除所有临时 `console.log`。
- [ ] 线上三路径对话后气泡均有内容，无「无内容」裸露。
- [ ] **review gate**：确认无调试残留、兜底分支覆盖全。
- [ ] **rollback point**：可独立提交（R1 完成）。

---

## 收尾

- [ ] 全量 `cd apps/desktop && pnpm build` 通过。
- [ ] 过一遍验收清单（prd.md Acceptance Criteria 六项）。
- [ ] 确认未触碰 relay 服务端 / 后端扣费代码。
- [ ] 按需归档任务记录。

## 验证命令速查
```bash
cd apps/desktop
pnpm install        # 首次
pnpm tsc --noEmit   # 类型检查
pnpm build          # 构建
pnpm dev            # 本地起（目视）
```
