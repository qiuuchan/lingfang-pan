# 批次综合审查与实际验证

## Goal

在 R1–R8 子任务基本完成后，对本批次所有改动做一次综合代码审查（跨子任务一致性、回归风险、安全），并本地实际验证（启动后端 + 桌面壳，逐项跑通 R1–R8），证据留痕。本任务依赖前置子任务完成。

## Requirements

- R9.1 综合审查：用 code-review / superpowers:code-reviewer 对全量 diff 做审查，覆盖：
  - 跨子任务一致性（命名、风格、文案统一）
  - 回归风险（401 登出、iframe opaque origin、capability 网关、拖动回归、生成链路不破坏）
  - 安全（除授权换装 key 外无新增硬编码密钥、无越权 capability）
  - 复用/DRY（ScriptPreviewPanel 抽取、window-drag util 抽取是否到位）
- R9.2 实际验证（本地）：`pnpm start` 启动后端 + 桌面壳，逐项验证：
  - R1 模型选择器只显上游模型 + 自定义跳设置
  - R2 "使用插件"文案
  - R3 Python/Node 插件进入可运行
  - R4 换装单图 + 批量
  - R5 笔记 CRUD/分类/AI 总结/搜索
  - R6 后端不可达页
  - R7 全场景拖动（含顶部悬浮窗）
  - R8 安装器构建出包 + 安装界面截图
- R9.3 验证报告：写 `.claude/verification-report.md`，逐项列执行结果（通过/失败 + 证据：截图/日志）。
- R9.4 lint + type-check 全量通过。
- R9.5 修复审查与验证发现的问题（或记录为后续 follow-up）。

## Acceptance Criteria

- [ ] 全量 diff 审查报告产出（问题清单 + 修复/记录）
- [ ] R1–R8 逐项本地验证，每项有证据
- [ ] `.claude/verification-report.md` 完成
- [ ] lint + type-check 通过
- [ ] 发现的问题已修复或记录 follow-up
- [ ] 综合评分 ≥90（按 CLAUDE.md 质量审查规范）

## Notes

- 依赖 R1–R8 完成，最后执行。
- 验证过程遇工具缺失/覆盖不足，按 CLAUDE.md 在验证文档记录原因与补偿计划。
- 属父任务自身的集成 review 职责。
