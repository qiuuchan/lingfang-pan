# 插件共享数据与协作状态实施计划

## Preconditions

- [ ] InvocationPrincipal、policy evaluator、ArtifactRef 和 action JSON Schema contract 已冻结。
- [ ] 明确 package/workflow namespace owner ID 与 team context 的单一来源。
- [ ] 确认 MySQL/PostgreSQL 双 provider 迁移策略和 Redis 生产依赖。

## 1. Contract And Persistence

- [ ] 在 @lingfang/contract 定义 namespace/value/write/page/conflict/change event schema；SharedValue/SharedWrite 明确包含 schemaVersion，BigInt revision 与 namespace change cursor 使用十进制字符串。
- [ ] 在 Prisma 增加 PluginSharedNamespace.generation/deletedAt/activeSchemaVersion/nextValueRevision/nextChangeCursor、PluginSharedValue.schemaVersion、绑定 namespace generation/key/value revision/JSON Pointer 的 PluginSharedValueArtifact、SharedStateOutbox.cursor/schemaVersion/revision 及 namespaceId + cursor 唯一键和分页索引。
- [ ] 更新 provider renderer，验证 PostgreSQL 与 MySQL schema/migration。
- [ ] 增加规范化 key、规范化 JSON 字节计量、quota delta 和 CAS 纯函数测试。

## 2. Shared State Service

- [ ] 建立 shared-state module/controller/service，所有入口从认证上下文构造 InvocationPrincipal。
- [ ] 集成 policy evaluator，默认 owner write，跨 package/action/workflow 只使用 canonical `shared_data_read`/`shared_data_write` 显式授权，不定义 shared 模块私有 operation 别名。
- [ ] 实现 get/set/compare-and-set/delete/pageCursor list，并在同一事务维护 usedBytes、namespace 单调 nextValueRevision/change cursor 和 outbox；列表 pageCursor、value revision 与变更 cursor 使用不同 contract 类型。
- [ ] create/update/delete 均从 nextValueRevision 分配不复用的新值；覆盖 key delete -> recreate -> stale expectedRevision 409，以及 namespace delete -> reactivate 后旧 revision/token/subscription 拒绝、allocator 不重置、并发 allocator 测试。
- [ ] 实现 owner/admin JSONL export 与 namespace 逻辑 delete/reactivate：删除值正文但保留 identity/allocator，重建递增 generation；审计只写 metadata。
- [ ] 写入按声明版本校验 schemaVersion/value 并持久化版本；读取按值自身版本校验和解码，不支持版本返回 `shared_schema_version_unsupported`。
- [ ] 实现显式 schema migration action：源/目标 schema 校验、expectedRevision CAS、分批断点和冲突重试测试；禁止隐式转换。
- [ ] 递归提取/校验 ArtifactRef，并在 set/CAS 事务内验证 STANDARD artifact parent kind + live source invocation grant、写 PluginSharedValueArtifact、按 action canonical subjectKey/holderKey insert-or-read value-revision-scoped SHARED_VALUE grant + 有界可续 hold、revoke/release 被替换 revision scope；读取先授权再为当前精确 STANDARD invocation 原子兑换 live grant。PREVIEW/team-only/旧 revision 全部拒绝。
- [ ] delete/key recreate/namespace clear/reactivate 同事务写旧 SHARED_VALUE grant.revokedAt/hold.releasedAt；实现 live edge reconciler，覆盖并发唯一 row、事务后崩溃、缺失/孤立 row、retention cap 与普通 runtime TTL。只 CAS 延长 live row，expired/revoked/released 不 reopen，不允许无限续租或 team-wide fallback。
- [ ] 校验 64 KiB value、10 MiB namespace 和平台配置覆盖。

## 3. SDK And Runtime Bridges

- [ ] 在 plugin manifest/SDK 增加 shared_namespaces 与 sdk.shared 类型客户端。
- [ ] Desktop client、Node/Python bridge 和 cloud worker 注入相同 principal 与错误映射。
- [ ] 保持旧 plugin.setSharedData/getSharedData/listSharedKeys 本机实现和测试，不自动迁移。
- [ ] 增加 Creator/CLI validate，阻止未声明 namespace 和明显将 secret capability 混入 shared contract。

## 4. Milestone 1 UI And Operations

- [ ] 管理端增加 namespace 用量、owner、schema version、最后更新时间、导出与删除入口，不显示值正文。
- [ ] 工作流运行详情显示使用的 namespace/key/revision 摘要。
- [ ] 增加 feature flag、team allowlist、quota metrics、409 conflict 与 429 limit 告警。

## 5. Milestone 3 Realtime

- [ ] 引入 Socket.IO 与 Redis adapter，生产在 Redis 缺失时对 realtime fail-close。
- [ ] 实现 session/runtime token 鉴权、team/namespace rooms、30 秒 heartbeat 和 90 秒 presence TTL。
- [ ] 实现 outbox publisher、重复广播幂等、失败重试与 publishedAt。
- [ ] 实现 namespaceId + cursor durable changes-after API、至少 7 天保留与清理；过期 cursor 返回 410 `shared_change_cursor_expired`，不得返回截断事件。
- [ ] SDK subscribe 只接收带 namespace cursor 的 invalidation event，按 cursor 去重并按 key/revision 重新读取。
- [ ] SDK 实现 cursor 内断线续传；收到 cursor 过期错误后从主库在第一页 value 查询前捕获 snapshotCursor，所有分页沿用签名 relist token，再补齐 changes 后恢复订阅。
- [ ] 实现断线重连、cursor 缺口/重复/过期、capture-before-list 全量 relist、分页期间 create/update/delete、较旧 revision 不回退、过期 presence、跨实例广播和 feature flag 降级测试。

## 6. Quality Gates

- [ ] Contract：pnpm -C packages/contract typecheck && pnpm -C packages/contract test
- [ ] API：pnpm -C apps/collab-api typecheck && pnpm -C apps/collab-api test -- --testTimeout=60000
- [ ] Desktop：pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test
- [ ] SDK：pnpm -C packages/plugin-sdk typecheck && pnpm -C packages/plugin-sdk test
- [ ] Admin：pnpm -C apps/collab-admin typecheck && pnpm -C apps/collab-admin build
- [ ] 针对跨团队、伪造 principal、越权 namespace、CAS 冲突、schemaVersion/迁移冲突、quota 并发、ArtifactRef parent/source grant/执行 kind/value revision 越权、grant/hold canonical uniqueness/no-reopen/cleanup 与日志泄漏运行负向测试。
- [ ] 用两个 API 实例验证 Redis presence/outbox 广播，不以单进程测试替代。
- [ ] 运行 git diff --check，确认没有共享数据导出、Redis dump、secret 或生成制品进入提交。

## Review Gates And Rollback

- [ ] Gate A：contract、schema 与策略矩阵评审后才实现 SDK。
- [ ] Gate B：双数据库、CAS、quota、跨租户负向测试通过后才为内置插件开启云端 KV。
- [ ] Gate B1：ArtifactRef set/read/update/delete/namespace-reactivate 与 crash reconciler 验证 SHARED_VALUE scope、hold retention 和精确 invocation grant 后，才允许 shared value 保存 ArtifactRef。
- [ ] Gate C：旧 localStorage 回归与无自动迁移验证通过后才发布 SDK。
- [ ] Gate D：Redis 多实例、namespace cursor 单调性、7 天 changes-after 保留、cursor 过期 capture-before-list relist、分页并发无漏项和 outbox 重放测试通过后才开启 realtime。
- [ ] 回滚时关闭 PLUGIN_TEAM_SHARED_STATE_ENABLED 或 PLUGIN_SHARED_REALTIME_ENABLED；保留云端数据，不改写旧本机存储。
