# 实施计划

1. 收口页面架构
   - 抽出 creator session 纯逻辑。
   - 将 `FloatingCreator` 重命名为单一 `CreatorWorkspace`。
   - 删除 legacy floating 标题栏、历史弹窗和重复 props。

2. 重构 Agent 工作区视觉
   - 收窄主内容列并简化空状态。
   - 精简左侧会话栏，移除技能重复入口。
   - 调整消息正文、reasoning 与运行状态的层级。

3. 重构 composer
   - 合并高级能力到 `+` 菜单。
   - 将附件、引用插件、工作区显示为 context chips。
   - 保留唯一上下文入口并展示用量。
   - 删除消息流底部重复 context 栏。

4. 重构 Artifact Inspector
   - 改为语义 token 和响应式宽度。
   - 用概览/文件标签组织内容。
   - 保留校验、保存、发布和上传进度行为。

5. 更新验证
   - 重写失效的 creator Playwright 导航与断言。
   - 覆盖空状态、输入态、对话态、草稿 Inspector、单一上下文入口。
   - 在 1024px、1280px、1600px 与亮暗主题下截图检查。

## Validation

```bash
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop test
pnpm -C apps/desktop vite:build
pnpm -C apps/desktop exec playwright test e2e/tool-card.spec.ts --project=chromium
```

## Risk / Rollback Points

- `CreatorWorkspace.tsx` 重命名后先运行 typecheck，确认所有懒加载路径已更新。
- 会话 helper 抽取后先跑现有 creator/agent 单测，确保历史兼容与流式去重行为未改变。
- composer 功能收纳后逐项验证附件、技能、引用、上下文、优化、语音和停止操作仍可达。
- Inspector 仅修改呈现层，不改保存/发布函数；若失败可单独回滚该组件。

## Completion

- [x] 页面收口为 `CreatorWorkspace`，删除 legacy floating 分支与历史 Dialog。
- [x] 会话持久化/归一化/流式去重抽到 `creator-session.ts` 并补回归测试。
- [x] composer、消息流、侧栏、上下文详情、工具/任务/提问卡和 Artifact Inspector 完成语义化重构。
- [x] 修复短 SSE delta 丢失、busy 切会话污染、发送后语音继续录入、文件选择不可达问题。
- [x] TypeScript、248 项 Vitest、Vite build、4 项 Creator Playwright 全部通过。
- [x] 1024px、1280px、1440px 以及亮暗主题完成浏览器截图检查，无横向溢出。
