# 全场景窗口拖动检查与修复

## Goal

核查并修复桌面端所有页面顶部容器与弹窗（含悬浮窗/Dialog 在顶部时）均可被拖动移动窗口。当前仅 TitleBar、PreviewDrawer、历史对话 Dialog 三处有 drag-region，其余顶部容器与弹窗缺失。

## Context

- tauri.conf.json:22 `decorations: false`，必须自实现拖动。
- 双保险模式：`data-tauri-drag-region` + `onMouseDown` 调 `getCurrentWindow().startDragging()`（portal 内 drag-region 不生效，必须手动 startDragging）。
- 现有 drag-region：TitleBar.tsx:39-65、PreviewDrawer.tsx:49-50、PluginCreatorHome.tsx:1142-1143（历史对话 Dialog）。

## Requirements

- R7.1 全盘核查所有页面/组件的顶部容器与全屏弹窗（Dialog/Sheet/Drawer），列出缺失拖动的清单。
- R7.2 为每个缺失的顶部容器补齐 `data-tauri-drag-region onMouseDown={onDragStart}`（portal 弹窗必须用手动 startDragging 模式，复用 TitleBar.tsx:30-35 的 onDragStart 工具函数，建议抽成共享 hook/util）。
- R7.3 重点验证"悬浮窗在顶部时"可拖——即任何顶部贴边的 Dialog/Sheet header 都能拖动，不被内容遮挡。
- R7.4 拖动区域内的交互元素（button/input/a/select）必须 stopPropagation 或 onDragStart 内 closest 判断跳过，避免误触拖动。

## Acceptance Criteria

- [ ] 产出缺失清单（写到 implement 或检查记录）
- [ ] 所有全屏/顶部弹窗 header 可拖动窗口
- [ ] 顶部贴边悬浮窗可拖动
- [ ] 拖动区域内按钮/输入框点击不触发拖动
- [ ] 主窗口 TitleBar 拖动不受影响（回归）
- [ ] lint/type-check 通过

## Design

- 抽共享 util `useWindowDrag()` 或 `onWindowDragStart(e)` 放 `apps/desktop/src/lib/window-drag.ts`，三处现有实现统一复用，消除重复。
- 遍历所有 Dialog/Sheet 组件，header 加该 handler。

## Files

- `apps/desktop/src/lib/window-drag.ts`（新增 util）
- `apps/desktop/src/components/TitleBar.tsx`（复用 util）
- `apps/desktop/src/components/creator/PreviewDrawer.tsx`（复用 util）
- 各 Dialog/Sheet 组件（核查后确定）

## Notes

- 中等复杂度。核查阶段需遍历组件，建议实现时先用 Grep 全局搜 Dialog/Sheet header。
