# 跨租户越权 e2e：真实 PG 行级隔离验证

## 背景

商业就绪评估（2026-08-07）维度 5 缺口：多租户为逻辑隔离（单库行级 teamId），**缺跨团队越权 e2e**。
现有隔离测试全是 mock 级（mock prisma 无法暴露"查询漏拼 teamId where 条件"这类真实 SQL 缺陷），
需要真实数据库层面的越权验证。

## 方案

沿用仓库既有数据库集成测试约定（参考 `plugin-shared-state.database.integration.spec.ts`）：

- 新文件 `apps/collab-api/src/modules/cross-tenant-authz.database.integration.spec.ts`
- env 门控：`CROSS_TENANT_DATABASE_INTEGRATION=1` 才跑，否则 describe.skip（不破坏常规 `pnpm test`）
- 真实 `PrismaService` 连 PG；beforeAll 建 fixture，afterAll 按 FK 顺序清理
- service 级驱动（supertest 不在依赖中，且 HTTP 守卫已有独立单测：permissions.guard.spec / relay-team.guard.spec / security.spec）

## Fixture

- 团队 A / 团队 B（ACTIVE）
- 用户：adminA（A 管理员）、memberA（A 成员）、adminB（B 管理员）
- 团队级角色 roleA/roleB（含 `team.plugin.edit_draft` 权限，供自动化计划管理上下文）
- 团队 B 邀请码 ×1、adminB 通知 ×1、团队 A 自动化计划 ×1

## 测试矩阵（13 例）

**A 成员关系基础（AuthService）**
1. ensureTeamMembership(adminA, teamB) → 403（无法冒认他团成员）
2. ensureCurrentTeam(adminA) → 解析到团队 A
3. ensureTeamAdmin(memberA) → 403（普通成员无管理员权）

**B 团队管理面（TeamService）**
4. removeMember(adminA, adminB) → not_found，且 adminB 在 B 团membership 不受影响
5. disableInvitation(adminA, 邀请码B) → not_found，邀请码保持 ACTIVE
6. listInvitations(adminA) → 不含 B 团邀请码
7. 正向对照：removeMember(adminA, memberA) → ok（memberA 变 REMOVED）

**C 通知用户级隔离（NotificationService）**
8. markRead(通知B, adminA) → not_found，通知保持未读
9. 正向对照：markRead(通知B, adminB) → ok

**D 自动化计划资源 ID 隔离（AutomationScheduleService，governance 打桩）**
10. list(adminB) → 不含 A 团计划
11. pause(adminB, 计划A) → not_found，计划保持 ACTIVE/generation 不变
12. remove(adminB, 计划A) → not_found，计划非 DELETED
13. 正向对照：pause(adminA, 计划A) → ok（排除 fixture 假阳性）

## 验收标准

- [x] spec 文件存在；常规 `pnpm test` 下被 skip（13 skipped 确认），1015 基线不变
- [x] 门控开启 + 真实 PG 下 13 例全过（本地 PG16 + 临时库 lingfang_cross_tenant_test，跑后已删）
- [x] package.json 增加 `test:cross-tenant:integration` 脚本；scripts/ 增加 docker 一键脚本（PG+MySQL 双跑，仿 shared-state）
- [x] typecheck 通过
- [x] spec 更新：collab-api/backend/index.md Quality Check 增补集成测试命令 + 隔离面扩展约定

注：全量 `pnpm test` 中 `workflow-postgres-https.integration.spec.ts` 的失败为并行会话未提交改动
（`const queue!:` 语法错误）所致，与本任务无关。

## 明确不做

- 不引入 supertest / 不改 HTTP 层（守卫已有单测覆盖）
- 不动 package.json 依赖（并行会话正在改 lockfile，只加 scripts）
- 插件市场订单越权（marketplace-commerce 已有 mock 级 buyerTeamId 用例，后续可补真实 PG 用例）
