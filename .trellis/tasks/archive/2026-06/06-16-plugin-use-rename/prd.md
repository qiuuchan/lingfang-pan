# 插件预览改名为使用插件

## Goal

将插件创建器中面向用户的"预览"措辞统一改为"使用插件"（按钮文字、tooltip、标题、新手引导文案）。底层预览/运行能力与 runtime 分派逻辑保持不变，仅改面向用户的文案。

## Requirements

- R2.1 创建器顶栏"预览"按钮（PluginCreatorHome.tsx:995-1003）文字改"使用插件"，图标可保留 EyeIcon 或换 PlayIcon/SparklesIcon，tooltip 同步改"使用插件"。
- R2.2 PreviewDrawer 顶部标题"插件预览"（PreviewDrawer.tsx:50）改"使用插件"。
- R2.3 新手引导 task-steps.ts:41-44「预览插件」步骤标题与描述改"使用插件"。
- R2.4 全仓搜索"预览"在创建器/插件运行上下文的用户可见文案，统一为"使用插件"（注意区分：collab-admin 详情抽屉的"文件列表预览"属只读文件展示，不在本期范围；market/插件列表无"预览"按钮，无需改）。

## Acceptance Criteria

- [ ] 创建器"预览"按钮文字显示为"使用插件"
- [ ] 预览大窗标题为"使用插件"
- [ ] 新手引导第 4 步为"使用插件"
- [ ] 全仓创建器上下文无遗漏的"预览"用户文案
- [ ] 点击"使用插件"行为与原"预览"完全一致（打开 PreviewDrawer / runtime 分派不变）
- [ ] lint/type-check 通过

## Files

- `apps/desktop/src/pages/PluginCreatorHome.tsx`
- `apps/desktop/src/components/creator/PreviewDrawer.tsx`
- `apps/desktop/src/components/onboarding/task-steps.ts`

## Notes

- 轻量任务，PRD-only。
- 仅文案 + 图标，不改逻辑。
