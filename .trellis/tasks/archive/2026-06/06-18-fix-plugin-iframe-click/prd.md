# 修复插件进入后无法点击

## Goal

修复用户启用插件并进入插件运行页（Runner）后，iframe 内的网页插件（client 类型）无法点击 / 交互无响应的阻断性问题。

## 根因（已调研确认）

`apps/desktop/src/components/PluginManifestDialog.tsx` 在 Runner 页面常驻挂载。其底层 `Dialog` 的 `DialogOverlay`（[dialog.tsx:24-38](../../apps/desktop/src/components/ui/dialog.tsx)）使用 base-ui Backdrop，className 为：

```
fixed inset-0 isolate z-50 bg-black/10 ... data-open:fade-in-0 data-closed:fade-out-0
```

base-ui v1.5.0 的 Backdrop 在 `data-closed`（弹窗关闭）状态下不会自动移除 DOM，也不会置 `pointer-events: none`。于是一个 `inset-0`（铺满视口）、`z-50` 的透明遮罩层在弹窗关闭后持续存在，拦截了下方 iframe 的全部指针事件，导致网页插件无法点击。

python / nodejs 插件走独立进程，不经 iframe，故不受影响——与用户描述一致。

## Requirements

- 弹窗关闭状态下，`DialogOverlay` 不得拦截指针事件。
- 修复应在通用 `dialog.tsx` 层完成，使所有使用该 Dialog 的位置同时受益，而非只补 PluginManifestDialog 单点。
- 同步检查 `DialogContent`（Popup，[dialog.tsx:51-58](../../apps/desktop/src/components/ui/dialog.tsx)）在 `data-closed` 状态是否也存在残留遮挡，若有一并处理。
- 不改变弹窗打开时的正常遮罩行为与淡入淡出动画。
- 不影响其他 Dialog 调用方的既有交互。

## 实现要点

在 `DialogOverlay` 的 className 增加 `data-closed:pointer-events-none`（base-ui 在关闭时会带 `data-closed` 属性）。如有需要，对 Popup 同样补充。保持现有动画类不变。

## Acceptance Criteria

- [ ] 启用一个 client 类型插件并进入运行页后，iframe 内的按钮 / 链接 / 输入可正常点击与交互。
- [ ] 打开 PluginManifestDialog 详情弹窗再关闭后，插件页面交互依旧正常（关闭后无残留遮挡）。
- [ ] 弹窗打开时遮罩与动画表现与修复前一致。
- [ ] 其他使用 Dialog 的页面（如脚本预览等）功能无回归。
- [ ] `apps/desktop` 类型检查 / 构建通过。

## Notes

- 轻量任务，PRD-only。
- 验证方式：开发者工具检查关闭后 `data-slot=dialog-overlay` 元素的 `pointer-events` 计算值为 `none`；并实际进入插件页点击验证。
