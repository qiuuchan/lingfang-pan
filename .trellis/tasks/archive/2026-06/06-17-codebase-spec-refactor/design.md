# 全库规范审计、spec 更新与大文件拆分技术设计

## Scope

本父任务管理跨包审计、spec 更新、规范修复和大文件拆分。父任务不直接承载业务代码改动，实际交付由 4 个子任务完成。

## Evidence Flow

```text
repo state
  -> code audit inventory
  -> spec update
  -> quality fixes
  -> large file refactor
  -> final verification
```

审计结果是后续所有工作的输入。spec 更新不能脱离审计证据；质量修复不能脱离 spec；大文件拆分不能脱离行为基线和验证命令。

## Task Boundaries

- `06-17-code-audit-inventory`：只读扫描和审计文档，允许写任务目录下的审计报告。
- `06-17-spec-update`：只改 `.trellis/spec/**` 和必要任务文档。
- `06-17-quality-fixes`：修复审计发现的低风险规范问题，不做大规模文件拆分。
- `06-17-large-file-refactor`：处理超阈值源码文件，保持行为一致。

## Large File Policy

- `>1500` 行源码：必须拆分，除非是生成文件或测试快照。
- `1000-1500` 行源码：默认拆分；若职责单一且拆分会制造反向复杂度，必须在审计报告中记录保留理由。
- 生成文件、锁文件、构建产物、历史证据文件不作为拆分目标。
- 测试文件超过阈值时优先按测试主题拆分，但不阻塞源码拆分。

## Validation Strategy

验证按影响范围分层：

- 全仓基线：`pnpm -r typecheck`、`pnpm -r test`、`pnpm -r lint` 中存在的命令。
- 桌面前端：`pnpm -C apps/desktop typecheck`、`pnpm -C apps/desktop vite:build`、`pnpm -C apps/desktop test`。
- Tauri/Rust：`cargo test -p lingfang-desktop`。
- Collab API：`pnpm -C apps/collab-api typecheck`、`pnpm -C apps/collab-api test`、`pnpm -C apps/collab-api build`。
- Admin 前端：`pnpm -C apps/collab-admin typecheck`、`pnpm -C apps/collab-admin build`。

后端单元测试需要 60 秒硬超时，避免卡死。

## Risk Controls

- 不在修复中新增静默 fallback、mock 成功路径或吞错逻辑。
- 拆分 Rust 模块时先保持 `pub(crate)` API 最小化，再由 `mod.rs` 或原文件 re-export 维持调用点稳定。
- 拆分 React/TypeScript 时先抽纯函数和 hooks，再抽 UI 子组件，避免状态分散。
- 每个拆分点都必须有验证命令或回归测试作为证据。
