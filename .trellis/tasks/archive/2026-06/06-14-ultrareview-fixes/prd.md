# 审查缺陷全量修复

## Goal

修复两轮深度审查（25+8 维度）发现的 139 条已确认缺陷（critical 2 / high 14 / medium 59 / low 57 / info 7），覆盖 collab-api 后端、desktop 桌面端（React + Rust）、collab-admin 管理端、packages 共享层，并完成一轮代码 review。

23 条文档明确取舍项（accepted-risk / known-limitation / future-work）不计入修复范围。

## 范围

139 条缺陷横跨 5 子系统，按优先级与子系统分 6 批修复。每批修复后跑对应验证（typecheck / test / cargo test），全部完成后做整轮 code review。

### 批次划分

| 批次  | 子系统                  | 优先级 | 关键缺陷                                                                                                              |
| ----- | ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| 批次1 | collab-api 鉴权与安全   | P0/P1  | PPK-01 付费墙绕过、AUTH-01 refresh 续命、ADMIN-02 不吊销 JWT、XSEC-01 无 ValidationPipe、XERR-01 Prisma 错误吞 500    |
| 批次2 | collab-api 经济与团队   | P0/P1  | TEAM-01 邀请码超发、MKT-02 评分 TOCTOU、PLUGIN-02 installCount、SCHEMA-01 signup_bonus 重复、TEAM-03 软删除团队未阻断 |
| 批次3 | collab-api 插件与管理   | P1/P2  | PLUGIN-04 APPROVED 下架、ADMIN-09 自禁用锁死、XLOG-01 adminUpdateTeam 透传、各 P2025→404 映射、PPK-02 源码泄露        |
| 批次4 | desktop Rust            | P0/P1  | SCRIPT-01 路径穿越删除、RT-01 iframe 越权、RUSTSHIM-01 无锁持久化、SPAWN 系列、SCRIPT-02 超时孤儿                     |
| 批次5 | desktop React           | P1/P2  | CREATOR-01/02 草稿脏写、CREATOR-03~12 流式 UI、DESK 系列会话/基础库、STREAM 系列                                      |
| 批次6 | collab-admin + packages | P2/P3  | ADMIN-VIEW-01 资金双击、ADMIN-VIEW-04 表单吞异常、CONTRACT 契约对齐、SDK 系列                                         |

## Constraints

- 简体中文（含注释、commit）。
- 不破坏现有功能：契约、多会话、--resume、.cmd shim、capabilities。
- 颠覆式破坏性更改策略，不向后兼容，但提供迁移说明。
- 每批修复后必须本地验证全绿才进下一批。
- 文档明确取舍项（23 条）不在本任务范围。

## Acceptance Criteria

- [ ] AC1 P0 critical 全部修复（SCRIPT-01 路径穿越、PPK-01 付费墙绕过、RT-01 iframe 越权）。
- [ ] AC2 P1 high 全部修复（14 条：鉴权续命/封禁、并发超发、草稿脏写、Rust 无锁、资金双击等）。
- [ ] AC3 系统性根因修复：全局 ValidationPipe、Prisma 错误映射 filter、计数器原子化统一 updateMany+count 模式。
- [ ] AC4 medium/low/info 按批次修复（核心正确性与数据一致性优先）。
- [ ] AC5 本地验证全绿：`pnpm -C apps/collab-api typecheck` + `pnpm -C apps/collab-api test` + `pnpm -C apps/desktop typecheck` + `pnpm -C apps/collab-admin build` + `cargo test`（desktop Rust）。
- [ ] AC6 完成一轮 code review，确认修复无引入新缺陷。
- [ ] AC7 每批修复有 commit，commit message 遵循 fix(desktop)/fix(api) 规范。

## Notes

- 缺陷清单来源：两轮审查的完整 confirmed 缺陷 JSON（已在审查对话中确认）。
- 修复时如发现某条缺陷的触发条件实际不可达或属误判，记录原因并跳过（保持诚实）。
- 与当前 in_progress 任务 streaming-thinking-askquestion 正交，互不影响。
