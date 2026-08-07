# 创建器与 AskQuestion 技术设计

> 关联 PRD：`./prd.md`。本设计覆盖 R1 空响应修复 / R2 AskQuestion 工具 + Claude 风格 UI / R3 历史删除 + 分页 / R4 UI 微调。
> 已核实代码：`apps/desktop/src/components/creator/FloatingCreator.tsx`、`lib/plugin-creator/creator-tools.ts`、`lib/plugin-creator/context-compress.ts`、`lib/relay-provider.ts`、`lib/relay-chat-stream.ts`、`lib/skills.ts`、`apps/desktop/package.json`。

## 0. 技术边界

- 本任务**只改桌面端前端**（`apps/desktop/src/...`），不动 relay 服务端、不动后端扣费。
- 关键依赖（已核实 `package.json`）：`ai@^5.0.204`、`@ai-sdk/openai@^2.0.109`、`zod@^3`。AskQuestion 必须按 **Vercel AI SDK v5** 的工具协议实现。
- 创建器走两条不同的模型通道，勿混淆：
  - **agent 主流程**：`FloatingCreator.send()` 用 `streamText({ model: relayProvider().chat(tier), tools: creatorTools, stopWhen: stepCountIs(4) })`，消费 `result.fullStream`。AskQuestion 与空响应都发生在这条链路上。
  - **上下文压缩 / 摘要**：`context-compress.ts` 用 `chatComplete()`（手写 SSE 客户端 `relay-chat-stream.ts`），与 agent 通道是两套解析逻辑，互不影响。
- 与**子任务 A（后端扣费）的边界**：A 改 relay 服务端计费；本任务改前端渲染与工具协议。**唯一交叉点**是 R1：若线上复现确认空响应根因在 relay 流式响应不完整（如 tool_calls 透传缺失、SSE 提前 `[DONE]`），则属于 A 的范畴，本任务只负责前端的「兜底渲染」与「根因定位报告」，服务端修复交 A。详见 R1。

---

## R1 空响应修复

### 现象与命中分支

对话后 assistant 气泡显示「无内容」。命中 `FloatingCreator.tsx:443-444`：

```
) : !t.streaming ? (
  <span className="text-muted-foreground">无内容</span>
```

即 `content === ''` 且 `streaming === false` 且 `status` 非 `failed`/`cancelled`。说明 `fullStream` 正常结束（走到 289-296 把 `streaming:false,status:'done'`），但全程**没有任何 `text-delta`** 累积进 `content`。

### 根因假设（按可能性排序，需线上复现逐一排除）

- **H1 工具步无总结文本**：多步 agent 中模型先发 `tool-call`（upload_plugin），工具返回后**未再产出总结文本**就结束（命中 `stopWhen: stepCountIs(4)` 或模型自行停步）。此时 `content` 全空。这是当前最可疑路径——`tool-call`/`tool-result` 分支（279-287）只切指示器、不写 `content`。
- **H2 仅 reasoning 无 text**：思考模型只输出 `reasoning-delta`（累积进 `reasoning` state，471-482 单独展示），最终没有 `text-delta`。气泡 `content` 仍空。
- **H3 v5 part 形状 / provider 解析不匹配**：AI SDK v5 经 `@ai-sdk/openai` 解析 relay 的 OpenAI 兼容 SSE 时，`text-delta` 的字段或事件序列与 relay 实际返回不一致（注意手写的 `streamChat` 读 `choices[0].delta.content` 是好的，但 agent 通道用的是 SDK provider，二者解析路径不同）。若 relay 把内容放在非标准字段或 tool_calls 与 content 混排，SDK 可能丢 text。
- **H4 stopWhen 截断**：`stepCountIs(4)` 在「生成→调 upload→看结果→总结」恰好 4 步时，末步总结可能被提前裁掉。

### 修复方案（分两层，互补）

**A. 前端兜底渲染（必做，无论根因，本任务范围内）**

1. **工具步可见化**：把 `tool-call` / `tool-result` 也并入 assistant 气泡的可渲染内容，使得「只调了工具没说话」也有内容。两种实现，二选一：
   - 轻量：当本轮检测到 `upload_plugin` 成功（`publishedName` 已置）但 `content` 仍空时，给 `content` 补一条占位文本（如「已为你生成并上传插件，详情见上方卡片」）。
   - 结构化（推荐，且为 R2 复用）：扩展 `Turn`，新增 `parts?: Array<{ type:'text'|'tool'|'question'; ... }>`，渲染时遍历 parts。工具调用渲染为内联小卡片。后续 AskQuestion 直接复用 parts 模型。
2. **空响应安全网**：流结束时（291-296）若 `content` 为空且未发生工具调用、未取消、未失败，则把气泡内容置为友好提示（如「模型未返回内容，请重试或换用高级版」）并 `status:'failed'`，避免裸露「无内容」。
3. **reasoning 兜底（H2）**：若结束时 `content` 空但 `reasoning` 非空，提示「模型仅输出了思考过程」，引导展开思考区。

**B. 根因定位（线上复现后判定是否需 A 子任务介入）**

- 若复现确认是 H3/relay 透传问题 → 产出定位报告交子任务 A 修 relay；前端保留 A 层兜底。
- 若是 H1/H4 → 纯前端可解（兜底 + 调大 `stepCountIs` 或在提示词里要求工具后必须总结）。

### 线上调试验证计划

- 调试地址：`http://106.12.131.38:19006`（账号密码见任务下发，**不写入任何仓库文件**）。
- 复现步骤：
  1. 打开创建器，分别测三种输入：①纯问答（「你能做什么」，不触发工具）；②明确建插件（触发 upload_plugin）；③开/关「思考模式」各一次。定位空响应只发生在哪条路径。
  2. 浏览器 DevTools → Network 看 `/api/relay/v1/chat/completions` 的 SSE 原始帧：确认是否有 `choices[].delta.content`、是否有 `tool_calls`、是否提前 `[DONE]`。
  3. 在 `fullStream` 循环（264-288）临时加 `console.log(part.type, part)`（仅本地调试，提交前移除），确认实际收到的 part 序列：是否有 `text-delta`、`finish`、`error`。
- 判定矩阵：
  - 只在「触发工具」时空 → H1/H4（前端可解）。
  - 只在「思考模式」时空 → H2（前端兜底）。
  - 全部路径都空、且 Network 里有 content 但 part 序列无 `text-delta` → H3（relay/SDK 解析，转 A）。
- 验证通过标准：三条路径对话后气泡均有内容，无「无内容」裸露。

---

## R2 AskQuestion 工具 + Claude 风格 UI

### 目标

信息不足/有歧义时，模型**默认调用 `ask_question` 工具**结构化提问（而非纯文本），前端渲染 Claude 风格提问卡片（标题 + 可选项按钮 + 自由输入），用户作答后把答案回灌、继续 agent 流程。与现有 `upload_plugin` 并存。

### 工具定义（`creator-tools.ts` 新增 `ask_question`）

```ts
const askQuestionParams = z.object({
  question: z.string().describe('要向用户澄清的问题，一句话'),
  options: z
    .array(
      z.object({
        label: z.string(), // 选项展示文案
        value: z.string(), // 回灌给模型的值
      })
    )
    .optional()
    .describe('可选的预设选项；省略则只让用户自由输入'),
  allowFreeText: z.boolean().default(true).describe('是否允许自由文本作答'),
  multiSelect: z.boolean().default(false).describe('是否允许多选'),
});
```

注册：`export const creatorTools = { upload_plugin: uploadPluginTool, ask_question: askQuestionTool };`

### v5 集成机制（两种方案，推荐 A）

> 核心难点：AskQuestion 是**人在环（human-in-the-loop）**工具——它的"执行结果"是用户的回答，不能在前端自动算出。

**方案 A（推荐）：deferred-execute（工具 execute 返回一个等待用户作答的 Promise）**

- `ask_question` 的 `execute` 不立即返回，而是创建一个 deferred Promise：把 `resolve` 存进一个 ref（`pendingAnswerRef`），同时把问题写进当前 assistant turn 的 `parts`（渲染提问卡片）。
- `fullStream` 的 `for await` 在该工具步会**停在 execute 的 await 上**，直到用户点选项/提交 → 调用 `resolve(answerText)` → execute 返回 `{ answer }` → SDK 自动把工具结果回灌，**同一个 `streamText` 多步循环继续**产出后续文本/工具调用。
- 配套改动：
  - `stopWhen: stepCountIs(4)` 调大（如 8），给"提问→作答→继续生成→可能再问/再上传"留步数。
  - `tool-call`/`tool-result` 分支需识别 `toolName === 'ask_question'`：tool-call 时渲染卡片并置「等待作答」态；tool-result 时清除等待态。
  - 取消（abort）/切换对话/关窗时必须 `reject` 或 `resolve` 掉悬挂的 deferred，避免泄漏与卡死（在 `stop()`/`selectConversation()`/`newConversation()` 里清 `pendingAnswerRef`）。
- 优点：单次 `streamText` 调用、复用现有 fullStream 循环、上下文天然连续。
- 风险：execute 内长时间 await 会**持有 SSE 连接**（用户迟迟不答则连接挂着）；需确认 relay/中间层不会因空闲超时断流。若超时，退方案 B。

**方案 B（备选）：无 execute + 续跑（resume）**

- `ask_question` 不带 `execute`。v5 中无 execute 的工具不会自动执行，`fullStream` 走到该 tool-call 后该步结束、流自然 finish（带一个未完成的 tool call）。
- 前端捕获 tool-call 渲染卡片；用户作答后，**手动重组 messages 再发一次 `streamText`**：取 `await result.response`（拿到本轮生成的 ModelMessage[]，含 assistant 的 tool-call），追加一条 tool 结果消息：
  ```ts
  { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName: 'ask_question', output: { answer } }] }
  ```
  然后用「原 built.messages + response.messages + tool 结果」作为新 `messages` 再次 `streamText`，继续累积到同一 assistant turn。
- 优点：不挂连接，超时友好。
- 风险：需精确重建 v5 的 ModelMessage（tool-call 与 tool-result 配对、`toolCallId` 一致），且 relay OpenAI 兼容端要正确接收 `role:'tool'` 回合——这一步**最不确定**，须实测。

### 让"所有提问默认走工具"的提示词

改 `FloatingCreator.tsx:69-82` 的 `SYSTEM_PROMPT`，把现有「信息不足时先简短提问澄清（不要调用工具）」改为：

- 「信息不足、需求有歧义、或需要用户在多个方案中选择时，**必须调用 `ask_question` 工具**发起结构化提问，不要用纯文本提问。能用预设 `options` 就给选项，减少用户打字。」
- 「只有在需求明确、信息齐备时才调用 `upload_plugin`。」
- 可选：新增一个 Skill（`ask-first`，默认激活）承载该约束，与现有 skills 一致地通过 `assembleSystemPrompt` 注入，便于开关与扩展。

### Claude 风格提问 UI 交互流程

1. 模型调 `ask_question` → 在当前 assistant 气泡内渲染**提问卡片**：问题文案 + 选项按钮（pill/列表）+（`allowFreeText` 时）一个内联输入框 + 「提交」按钮。卡片视觉对齐现有 `publishedName` 成功卡片的圆角/边框风格。
2. 用户点选项或输入文本 → 卡片进入「已作答」只读态（显示所选答案）→ 触发 `resolve(answer)`（方案 A）或续跑（方案 B）。
3. agent 拿到答案继续：后续文本 delta 累积进同一气泡，或再次提问/调 upload。
4. 状态落库：提问与答案需存进 `Turn.parts`，刷新/切历史后仍可见；但**未作答的悬挂提问**在切换对话/刷新后应作废（不可跨会话恢复 Promise）。

### 数据结构改动

扩展 `Turn`：

```ts
interface QuestionPart { type:'question'; toolCallId:string; question:string; options?:{label:string;value:string}[]; allowFreeText:boolean; multiSelect:boolean; answer?:string; answered:boolean; }
interface Turn { role:'user'|'assistant'; content:string; streaming?:boolean; status?:...; parts?: Array<QuestionPart | {type:'tool';name:string;ok?:boolean}>; }
```

localStorage 持久化结构随之升级——需对老数据做容错（`loadConversations` 已 filter，缺 `parts` 时默认空数组）。

---

## R3 历史删除 + 分页

现状（`FloatingCreator.tsx:35-62, 89-175, 542-569`）：localStorage 持久化，`saveConversations` 截断最多 30 条，历史 Dialog 一次性平铺全部，无删除。

### 方案

- **单条删除**：每个历史项右侧加删除按钮（Trash 图标，`stopPropagation` 防误触发选中）。删除逻辑：
  ```ts
  function deleteConversation(id: string) {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveConversations(session.userId, session.tenantId, next);
      return next;
    });
    if (id === activeConversationId) newConversation(); // 删的是当前会话则重置
  }
  ```
  建议加二次确认（轻量 confirm 或行内「确认删除」态），删除不可逆。
- **分页**：纯前端分页（数据在 localStorage，量小）。`const PAGE_SIZE = 8;` 维护 `historyPage` state，渲染 `conversations.slice(page*SIZE, (page+1)*SIZE)`，底部加「上一页/下一页 + 第 X/Y 页」。`historyOpen` 打开时重置 `historyPage=0`。
- 删除后若当前页空且非首页，自动回退一页。

---

## R4 UI 微调

- **移除团队名 Badge**：删 `FloatingCreator.tsx:333` 的 `<Badge variant="secondary">{session.tenantName ?? '当前团队'}</Badge>`（连带不再需要的 import 视情况清理；`Badge` 仍被「已压缩 N 轮」用，保留）。
- **新建对话按钮移到历史按钮左侧**：当前「历史」按钮在 342-345（标题栏右侧区起始），「新建对话」`PlusIcon` 在 407-411（关闭按钮之后、且有 `turns.length>0` 条件）。改为：在「历史」按钮**之前**放「新建对话」按钮。
  - 注意当前新建按钮带 `turns.length > 0` 显隐条件；移位后保持该条件（无对话时不显示新建），或统一改为常显（待定，倾向保持原条件以免空态多余按钮）。
  - 历史 Dialog 内（550-552）已有一个「新建对话」按钮，保留不动。

---

## 风险与不确定点（实现时须验证）

1. **方案 A 的 SSE 长挂**：execute await 用户作答期间 relay 是否空闲断流——最需实测，断流则切方案 B。
2. **方案 B 的 ModelMessage 重建**：v5 `result.response.messages` 的确切形状、tool-result 回合能否被 OpenAI 兼容 relay 正确消费——次不确定。
3. **relay 是否支持 tool calling**：agent 通道依赖上游模型返回 OpenAI `tool_calls`。R1 复现时一并确认（若 upload_plugin 本就能用，则 tool calling 已通，ask_question 同理）。
4. **R1 根因归属**：H3 若成立属子任务 A，本任务仅兜底 + 出报告。
