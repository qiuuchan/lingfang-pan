# 执行计划：大模型生成聊天标题

## 前置

- 目标文件：`apps/desktop/src/pages/PluginCreatorHome.tsx`
- 复用：`generateTitle`（`@/lib/conversations`）、`summarizeTitleLocally`（已 import）、`renameConversation`（已 import）

## 步骤

### 1. 确认 import

- [ ] `PluginCreatorHome.tsx` 顶部确认 `generateTitle` 已从 `@/lib/conversations` 引入；未引入则补 import。
- [ ] 确认 `summarizeTitleLocally` / `renameConversation` 已在 import 列表（现状已有）。

### 2. 新增 provider→tool 映射纯函数

- [ ] 在 `PluginCreatorHome.tsx` 模块作用域（组件外）或就近 util 定义：
  ```ts
  // 将 ProviderId 映射为 generateTitle 接受的工具名；非 claude/codex 返回 null（走本地启发式降级）。
  function resolveTitleTool(tool: string | undefined): 'claude' | 'codex' | null {
    if (tool === 'claude') return 'claude';
    if (tool === 'codex') return 'codex';
    return null;
  }
  ```

### 3. 改造标题生成段（现第 465-476 行）

- [ ] 将同步的 `summarizeTitleLocally` 单分支替换为「SDK 优先 + 本地降级」异步 IIFE：
  ```ts
  // 标题生成（首轮 + 当前会话尚无 title）：优先 SDK 总结，失败降级本地启发式。
  const currentMeta = metas.find((m) => m.sessionId === sessionId);
  if (!isFollowup && !currentMeta?.title && promptText) {
    const applyTitle = (title: string) => {
      if (!title) return;
      setMetas((prev) => prev.map((m) => (m.sessionId === sessionId ? { ...m, title } : m)));
      void renameConversation(sessionId, title).catch(() => {
        /* rename 失败静默，标题已停留在内存 metas */
      });
    };
    const titleTool = resolveTitleTool(finalSession.tool);
    const stdout = finalSession.stdout || '';
    if (titleTool) {
      // SDK 短任务异步生成，不阻塞后续 toast / 落盘；失败降级本地启发式。
      void (async () => {
        const llmTitle = await generateTitle({
          tool: titleTool,
          model: finalSession.model,
          userText: promptText,
          assistantText: stdout,
        });
        applyTitle(llmTitle || summarizeTitleLocally(promptText, stdout));
      })();
    } else {
      applyTitle(summarizeTitleLocally(promptText, stdout));
    }
  }
  ```

### 4. 校验类型

- [x] 实现修正：`AssistantSessionState` 的字段是 `provider`（类型 `ProviderId = 'claude'|'codex'`）而非 `tool`，已改用 `finalSession.provider`。`model` 字段存在（string）。
- [x] `ProviderId` 恰为 `'claude'|'codex'`，与 `generateTitle` 入参一致；`resolveTitleTool` 作防御性边界（兼容 `string|undefined` 形态并对非法值降级）。
- [x] `generateTitle` 的 `model?` 可选，传 `finalSession.model` 或 `undefined` 均可。

## 验证命令

```powershell
cd o:\lingfang-platform\apps\desktop
pnpm tsc --noEmit
pnpm lint
```

## 验证要点

- [ ] 首轮对话结束后，标题先可能短暂为派生标题，随后被 SDK 标题替换（异步迟到刷新）。
- [ ] 断网 / SDK 失败时，标题回落为 `summarizeTitleLocally` 结果，不报错、不空白。
- [ ] 追问轮（isFollowup）不触发标题生成。
- [ ] 已有 title 的会话不重复生成。

## 回滚点

- 还原标题段为单行 `summarizeTitleLocally` 分支即可，无副作用、无数据迁移。
