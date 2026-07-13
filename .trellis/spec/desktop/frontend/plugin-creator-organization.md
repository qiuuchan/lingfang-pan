# 插件创建前端组织规范

## Scope

适用于：

- `apps/desktop/src/components/creator/CreatorWorkspace.tsx`
- `apps/desktop/src/components/creator/**`
- `apps/desktop/src/lib/plugin-creator/**`
- `apps/desktop/src/lib/agent/**`

## Production Entry

`CreatorWorkspace` 是开发插件页唯一生产 UI 入口。它的公开契约是：

```ts
export function CreatorWorkspace(props: {
  onClose: () => void;
}): JSX.Element
```

创建器会话侧栏维护独立的全局 UI 偏好 `lf:creator-sidebar-open`：首次无 key 默认折叠，用户切换后跨浮窗/全屏入口复用；不要把它重新绑定到应用主侧栏 `lf:sidebar-open`。侧栏自身提供展开/收起按钮，底部不渲染账号头像或团队菜单。

不要重新添加：

- `variant="floating" | "embedded"`
- 独立 creator 标题栏
- creator 历史 Dialog
- 消息区底部第二个 context/token 栏

页面结构固定为“会话侧栏 + 单一 Agent thread + 按需 Artifact Inspector”。

## Component Boundaries

`CreatorWorkspace.tsx` 负责 Agent 运行编排和页面装配。以下职责必须留在独立模块：

- 会话类型、旧数据归一化、localStorage key/读写、流式文本去重 -> `lib/plugin-creator/creator-session.ts`
- Agent loop / tool contracts -> `lib/agent/**`
- 输入区 -> `CreatorComposer.tsx`
- 消息链 -> `CreatorMessageList.tsx`
- 会话侧栏 -> `CreatorWorkspaceChrome.tsx`
- 草稿元数据/文件/检查/发布 -> `CreatorDraftPanel.tsx`
- 上下文详情 -> `ContextInspector.tsx`

`CreatorMessageList` 必须复用 `creator-session.ts` 的 `Turn` 与 `cleanTurnParts()`，不要维护第二套 part decoder 或 legacy fallback。

## Session Contracts

会话按 tenant 优先、user fallback 隔离：

```ts
conversationKey(userId, tenantId);        // lf:creator-conversations:<owner>
selectedConversationKey(userId, tenantId); // lf:creator-selected:<owner>
```

- 所有读取、保存、删除动作复用这两个 helper，不手工拼 key。
- 最多持久化 30 个会话。
- `modelContent` 只进入当前模型上下文，不落入 localStorage。
- 切换/删除会话在 Agent `busy` 时禁用，防止旧异步回调污染新会话。
- 短 SSE delta 必须原样保留；只有足够长且已存在的完整片段才可判为重复。

## Composer Contracts

- 常驻控件：more、Agent/Plan、模型、唯一上下文入口、发送/停止。
- 文件和文件夹使用两个真实 input：普通 `multiple` 文件 input，以及带 `webkitdirectory` 的文件夹 input。
- 发送前停止语音识别，禁止录音结果在 busy 期间继续写入输入框。
- 上下文占用估算至少包含 system/skills、历史、当前输入、引用插件源码和已选附件；点击后由 `ContextInspector` 重新构建精确 breakdown。

## Styling Contracts

- Creator 范围使用 `background/card/muted/accent/primary/border/ring/destructive` 等语义 token。
- 不在 creator 组件中新增 `#hex`、`rgb/rgba` 颜色或 `rounded-2xl/3xl/4xl`。
- thread 阅读宽度使用 `max-w-[52rem]`；Inspector 使用 `clamp(360px, 30vw, 420px)`。
- 助手正文是连续内容流；reasoning、tool、question、todo 才使用结构化 bordered surface。

## Tests Required

- `pnpm -C apps/desktop typecheck`
- `pnpm -C apps/desktop test`
- `pnpm -C apps/desktop vite:build`
- `pnpm -C apps/desktop exec playwright test e2e/tool-card.spec.ts --project=chromium`

关键断言：

- 普通页面通过真实“AI 创建插件”浮动按钮进入顶层 Dialog；草稿继续编辑通过 `develop-plugins` 进入全屏工作区。
- 页面只有一个上下文详情入口，没有 message-area `context` 栏。
- more 菜单可访问文件、文件夹、技能、提示词优化和语音。
- tenant-scoped 历史和 staged draft 可恢复，Artifact Inspector 可切到文件标签。
- `creator-session.spec.ts` 覆盖 legacy normalize、30 条上限、`modelContent` 剥离、stream overlap 和短 delta。

## Wrong vs Correct

Wrong:

```tsx
<CreatorWorkspace variant="floating" />
// MessageList 和 Composer 各自提供一个“上下文”入口
```

Correct:

```tsx
<CreatorWorkspace onClose={handleClose} />
// 创建器侧栏自行维护 lf:creator-sidebar-open；Composer 是唯一上下文入口，MessageList 只渲染 thread/status。
```
