# 模型选择器只显示上游模型 + 自定义跳设置页

## Goal

插件创建器（PluginCreator）的模型下拉框不再硬编码展示 `sonnet/opus/gpt-5.5/gpt-5.1-codex/qwen-coder` 等预设型号。改为：模型清单来源于「本地已装 code-assistant CLI 实际探测到的可用模型」合并「gateway 上游已配置并拉取/勾选的真实模型」；上游未配置时给明确引导而非塞死预设。"自定义"入口改为跳转到设置页（gateway tab），不再就地展开输入框。

## Context（关键设计判断）

- 创建器的模型选择器消费方是**本地 code-assistant CLI**（claude/codex/opencode），选中值作为 CLI `--model` 参数传给 Rust `start_session`。这与 gateway 配的上游模型（给 collab-api 网关、普通插件 `sdk.llm.chat` 用）是**两条独立链路**。
- 用户诉求："配置好 key 和模型后，前台不该再列 sonnet/opus/5.5，只显示从上游获取的模型"。落地：**移除 `PROVIDERS` 常量里的具体型号硬编码**，改为运行时双源合并。
- 现状 `code_assistant_list_tools` 已能返回本地已装 CLI 的可用模型（运行时覆盖 fallback），但 `PROVIDERS`（plugin-draft.ts:11-15）仍是硬编码兜底且会"泄漏"型号。

## Requirements

- R1.1 删除/弱化 `PROVIDERS` 中的具体型号硬编码，使模型清单来源唯一为运行时探测（CLI 可用模型 + 上游 modelOverride/defaultModels）。
- R1.2 创建器挂载时，除现有 `code_assistant_list_tools` 外，额外拉取 `GET /api/llm/active-provider` + `GET /api/llm/binding`，把上游真实模型合并进模型下拉（去重）。
- R1.3 "自定义…"项点击行为改为：跳转到设置页 gateway tab（`setSettingsTab('gateway')` + `setView('settings')`），不再就地展开 Input。移除 Composer 内自定义 Input 分支与哨兵就地输入逻辑。
- R1.4 上游与本地均无可用模型时，下拉显示明确空态 + "去设置配置模型"引导，不塞预设型号。
- R1.5 保留 `resolveSendModel` 对空/占位的归一逻辑；模型透传到 Rust 的链路不变。

## Acceptance Criteria

- [ ] 创建器模型下拉默认不再出现硬编码的 sonnet/opus/gpt-5.5 等（除非它们确实被上游或本地 CLI 探测到）
- [ ] 在 gateway 配好上游模型后，创建器下拉能出现这些上游真实模型
- [ ] 点击"自定义…"跳转到设置页 gateway tab，不再就地展开输入框
- [ ] 无任何可用模型时显示空态引导，不报错不白屏
- [ ] 选模型 → send → CLI 收到正确 `--model`，与改动前行为一致（不破坏生成）
- [ ] 改动遵循既有代码风格，lint/type-check 通过

## Design（技术设计）

- **数据源合并**：在 `PluginCreatorHome.tsx` 现有 `code_assistant_list_tools` 的 useEffect 里，并行 `api('/api/llm/active-provider')` + `api('/api/llm/binding')`，把 `binding.modelOverride`（用户勾选的上游模型）与 `activeProvider.defaultModels` 合并，按 provider 归组塞进 `providers` state。provider id 映射需稳定（上游模型归到一个虚拟 provider 或挂到对应 CLI provider 下）。
- **PROVIDERS 弱化**：保留 provider 的 id/label 骨架（claude/codex/opencode 三个 CLI 标签仍需），但 `models: []` 置空，仅作"label 字典"，型号完全由运行时填充。
- **自定义跳转**：Composer 移除 `isCustomModel`/`customInputValue`/就地 Input；"自定义…"SelectItem 选中后调新增 `onCustomModel()` 回调，父组件触发 `setSettingsTab('gateway'); setView('settings')`（复用现有跳设置页模式，见 PluginCreatorHome.tsx:1022-1028）。
- **空态**：`providers` 为空或所有 provider models 为空时，Composer 下拉渲染"未配置可用模型，去设置"提示项。
- **回滚点**：保留 `resolveSendModel` 不变；如运行时拉取全部失败，退化为"空态引导"而非硬编码预设（破坏性改动，按 CLAUDE.md 不向后兼容，提供引导路径作回退）。

## Implement（执行清单）

1. `plugin-draft.ts`：`PROVIDERS` 改为 label 字典，`models: []`。
2. `PluginCreatorHome.tsx`：扩展 useEffect 合并上游模型到 `providers`；新增"去设置"跳转回调并透传给 Composer。
3. `Composer.tsx`：移除就地自定义 Input，"自定义…"改触发 `onCustomModel`；空态渲染。
4. 本地验证：配上游 → 创建器出现上游模型；点"自定义"→ 跳设置页；无模型 → 空态引导。
5. lint + type-check。

## Files

- `apps/desktop/src/lib/plugin-draft.ts`
- `apps/desktop/src/pages/PluginCreatorHome.tsx`
- `apps/desktop/src/components/creator/Composer.tsx`

## Notes

- 属中等复杂度，design + implement 已给出，可执行。
- 不涉及后端改动（复用现有 `/api/llm/*` 端点）。
- 与父任务 R2（预览改名）无耦合，可并行。
