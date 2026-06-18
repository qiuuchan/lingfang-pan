# 技术设计：大模型生成聊天标题

## 1. 边界与改动面

单点改动：`apps/desktop/src/pages/PluginCreatorHome.tsx` 的 `finalizeSession()` 标题生成段（现第 465-476 行）。

- 不改 `conversations.ts` 的 `generateTitle()`（已满足契约）。
- 不改 `plugin-draft/session.ts` 的 `summarizeTitleLocally()`（作降级保底）。
- 不改 Rust 侧与 collab-api。
- 可能新增一个 provider→tool 的本地映射小函数（就近定义或复用既有映射）。

## 2. 契约

### 2.1 现有 `generateTitle`（conversations.ts:63-98）

```ts
generateTitle(opts: {
  tool: 'claude' | 'codex';
  model?: string;
  userText: string;
  assistantText: string;
}): Promise<string>   // 成功返回 trim+截断16字标题；失败返回 ''
```

- 内部起独立短 session（`code_assistant_start_session`），不复用当前会话，不污染上下文。
- 系统提示已约束「简体中文、≤10 字、只输出标题、无标点/引号/换行」。
- 全程 try/catch，任何异常返回 `''`。

### 2.2 现有 `summarizeTitleLocally`（plugin-draft/session.ts:259-291）

```ts
summarizeTitleLocally(userText: string, assistantText: string): string
```

- 纯本地启发式（去祈使前缀 + 截断 16 字），秒级返回，无 IO。

## 3. 数据流（改造后）

```
finalizeSession（首轮 && 无 title && promptText）
  └─ resolveTitleTool(finalSession.tool) → 'claude' | 'codex' | null
       ├─ null（其它工具）─────────────────┐
       └─ tool ─→ await generateTitle({ tool, model, userText, assistantText })
                    ├─ 非空 title ─→ applyTitle(title)
                    └─ '' （失败）──┐
                                   ↓（降级）
                       summarizeTitleLocally(promptText, stdout) ─→ applyTitle(title)

applyTitle(title):
  setMetas(... title ...)              // 更新内存（顶部 + ConversationRail 即时刷新）
  void renameConversation(id, title)   // 持久化到 sessions.json，失败静默
```

## 4. 关键设计点

### 4.1 provider → tool 映射

`finalSession.tool` 是 `ProviderId`（可能为 `claude` / `codex` / 其它自定义 provider）。`generateTitle` 仅接受 `'claude' | 'codex'`。

- 映射规则：`tool === 'claude' → 'claude'`；`tool === 'codex' → 'codex'`；其它（含自定义模型路由）→ 返回 `null`，直接走本地启发式降级（不浪费一次 SDK 短任务）。
- 实现为就近的纯函数 `resolveTitleTool(tool: string): 'claude' | 'codex' | null`，便于单测。

### 4.2 异步不阻塞

- 现有逻辑 `summarizeTitleLocally` 是同步的，改造后引入 `await generateTitle`。为不阻塞 `finalizeSession` 后续的 toast / 落盘，将整段标题生成包进一个**自执行异步闭包**（fire-and-forget，`void (async () => {...})()`），主流程继续往下执行 toast。
- 标题段在 `finalizeSession` 内的位置：保持在草稿落盘之后；用 IIFE 让其脱离主 await 链。

### 4.3 降级语义

- `generateTitle` 已自带 try/catch 返回 `''`，无需在调用处再包 try/catch；仅判断返回值是否为空。
- 返回空 → 调 `summarizeTitleLocally`；仍为空（极端）→ 不设标题（沿用现状，`deriveTitle` 兜底显示）。

### 4.4 首轮守卫与幂等

- 沿用现有三守卫：`!isFollowup && !currentMeta?.title && promptText`。
- 因 `generateTitle` 是异步，需注意：守卫在进入 IIFE 前已判定，期间不会有并发首轮（单会话串行 finalize），无竞态。

## 5. 兼容性与回滚

- 破坏式改动策略：直接替换标题生成段，不保留旧的「仅本地启发式」分支（启发式作为降级仍在用）。
- 回滚：还原 `finalizeSession` 标题段为 `summarizeTitleLocally` 单分支即可，无数据迁移。

## 6. 风险

- LLM 短任务有额外耗时（数秒），但异步不阻塞 UI，标题「迟到」刷新可接受（`setMetas` 触发重渲染）。
- 若用户在标题生成期间删除会话，`renameConversation` 对已删除 session 报错——已 `.catch()` 静默，无副作用。
- `generateTitle` 会消耗一次模型调用额度；仅首轮触发，频率可控。
