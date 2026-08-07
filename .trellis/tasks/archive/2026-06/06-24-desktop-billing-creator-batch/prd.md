# 桌面端计费钱包与创建器体验优化批次（父任务）

## Goal

一次性推进 15 项桌面端（apps/desktop，即「协作平台前台」）需求，覆盖计费/钱包重构、插件创建器与 AskQuestion 工具、界面交互优化，最后完成全量代码审查与安装包打包。本父任务持有完整需求集、任务映射与跨子任务的集成验收标准，不直接承载实现。

## Scope / 包

- 主体：`apps/desktop`（前端 + src-tauri）
- 计费/钱包后端：`apps/collab-api`、`packages/contract`
- 设计 token：`packages/ui-tokens`

## 需求清单与任务映射

| #   | 需求                                                                               | 子任务                |
| --- | ---------------------------------------------------------------------------------- | --------------------- |
| 1   | 移除计费配置中的版本选择逻辑，版本控制交由渠道管理                                 | A billing-wallet      |
| 10  | 删除团队空间模块，整合为「团队钱包」（团队共享余额）                               | A billing-wallet      |
| 11  | 修复未成功对话仍然扣费                                                             | A billing-wallet      |
| 2   | 修复创建插件页对话后显示无内容（线上调试）                                         | B creator-askquestion |
| 6   | 适配 AskQuestion 工具（内置提示词、默认走该工具、Claude 风格 UI、复用 Agent 框架） | B creator-askquestion |
| 3   | 历史记录加删除 + 分页                                                              | B creator-askquestion |
| 4   | 移除 AI 创建插件旁的「铂觅」团队名显示                                             | B creator-askquestion |
| 5   | 新建对话按钮移到历史记录按钮左侧                                                   | B creator-askquestion |
| 8   | 插件管理重构为悬浮窗 + 侧边栏固定/历史插件 + 重设计                                | C ui-interaction      |
| 13  | 右下角创建插件悬浮按钮点击弹窗动画                                                 | C ui-interaction      |
| 14  | 扩展内置 Skill 数量 + 居中悬浮窗 + 背景模糊 + 去专业术语                           | C ui-interaction      |
| 7   | 调慢所有界面动画速度                                                               | C ui-interaction      |
| 9   | 缩小个人资料页底部高度                                                             | C ui-interaction      |
| 12  | 外观主题未选中按钮加边框                                                           | C ui-interaction      |
| 15  | 全量代码审查 + 中文提交信息 + 安装包打包                                           | D review-package      |

## 子任务

- `06-24-billing-wallet` — 计费钱包重构（复杂：后端 schema + 数据迁移 + 计费逻辑修复）
- `06-24-creator-askquestion` — 创建器与 AskQuestion（复杂：线上 bug 调试 + 新工具/UI + 历史管理）
- `06-24-ui-interaction` — 界面交互优化（复杂：插件管理悬浮窗重构 + 多项 UI 调整）
- `06-24-review-package` — 收尾代码审查与打包（依赖前三者完成）

## 跨子任务约束与顺序

- D（审查 + 打包）必须在 A/B/C 全部完成并自检通过后执行。
- A 的计费修复（#11）与 B 的空响应修复（#2）可能在同一 relay 调用链上交叉，需协调：A 负责后端扣费时机，B 负责前端流式渲染。两者在 `relay.service.ts` / 前端 `FloatingCreator.tsx` 边界清晰分工。
- A 删除团队空间涉及后端 schema 与数据迁移，风险最高，需独立 design.md + 用户确认后再动表结构。
- 所有改动集中在 main 分支或按需新建分支；提交信息一律中文。

## 集成验收标准（父任务负责最终验证）

- [ ] 15 项需求逐项在对应子任务中验收通过
- [ ] `apps/desktop` 构建通过（pnpm build / tsc 无错误）
- [ ] `apps/collab-api` 构建通过，计费相关单测/手测通过
- [ ] 线上调试环境验证：创建插件页对话能正常显示内容
- [ ] 未成功对话不扣费（手测或单测覆盖）
- [ ] 全量代码审查完成，问题已修复或记录
- [ ] 安装包成功打包（Tauri build 产物可用）
- [ ] 提交信息全部为中文

## Notes

- 「前台」= apps/desktop（见 memory qiantai-means-desktop）。
- 计费走 /api/relay，灵石按团队计费，fast/premium 哨兵（见 memory billing-relay-over-byok）。
- 各子任务的技术设计与执行计划写在各自的 design.md / implement.md。
