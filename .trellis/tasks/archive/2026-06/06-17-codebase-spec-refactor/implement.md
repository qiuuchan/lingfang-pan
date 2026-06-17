# 全库规范审计、spec 更新与大文件拆分实施计划

## Steps

1. 完成父任务和子任务规划
   - 更新父任务 `prd.md`、`design.md`、`implement.md`。
   - 更新 4 个子任务 `prd.md`，明确输入条件、输出条件和验收标准。

2. 执行 Code audit inventory
   - 读取 spec 索引和 package manifest。
   - 扫描源码文件行数，排除生成文件和构建产物。
   - 汇总测试、lint、typecheck、build 命令。
   - 输出 `.trellis/tasks/06-17-code-audit-inventory/audit.md`。

3. 执行 Spec update
   - 对照 `audit.md` 更新相关 `.trellis/spec/**`。
   - 明确当前真实包边界、质量命令和大文件拆分规则。
   - 记录每项 spec 更新的证据来源。

4. 执行 Quality fixes
   - 按审计优先级修复问题。
   - 优先处理类型错误、测试失败、已废弃 spec 指向、明显重复或死代码。
   - 每个修复运行最小相关验证。

5. 执行 Large file refactor
   - 先处理 `apps/desktop/src-tauri/src/code_assistant.rs`。
   - 再处理 `apps/desktop/src/lib/plugin-draft.ts` 和 `apps/desktop/src/pages/PluginCreatorHome.tsx`。
   - 再处理 `plugin_store.rs`、`plugin_runner.rs`、`plugin_script.rs` 和 admin 大组件。
   - 每个文件拆分前记录职责边界，拆分后运行相关验证。

6. 最终验证
   - 重新跑行数扫描，确认源码超阈值项已处理或有例外理由。
   - 运行影响范围内的类型检查、测试和构建。
   - 更新任务文档和开发日志。

## Validation Commands

```bash
pnpm -r typecheck
pnpm -r test
pnpm -r lint
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C apps/desktop test
cargo test -p lingfang-desktop
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test
pnpm -C apps/collab-api build
pnpm -C apps/collab-admin typecheck
pnpm -C apps/collab-admin build
```

## Rollback Points

- 审计阶段只写任务文档，回滚成本低。
- spec 更新独立提交，避免和代码重构混在一起。
- 每个大文件单独拆分和验证，不跨多个高风险文件混合提交。

## Done When

- 4 个子任务均完成并可独立验收。
- spec 与当前代码事实一致。
- 所有必须拆分的源码文件已拆分。
- 验证命令结果记录在对应任务中。
