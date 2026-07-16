# 插件共享数据与协作状态设计

## Architecture

共享数据以 collab-api + Prisma 为单一事实源。桌面、Web preview 和 cloud worker 均通过同一 contract 与授权服务访问，不直接读写数据库。

    plugin/workflow sdk.shared
      -> runtime bridge builds InvocationPrincipal
      -> SharedStateService policy/schema/quota/CAS
      -> Prisma shared namespace/value
      -> transactional outbox
      -> realtime gateway and subscribers

## Ownership Boundaries

- packages/contract：SharedNamespaceId、SharedValue、SharedWrite、SharedPage、SharedConflict、SharedChangeEvent 与 decoder。
- apps/collab-api shared-state module：CRUD、CAS、配额、导出、删除、审计和 outbox。
- packages/plugin-sdk：sdk.shared.get/set/compareAndSet/delete/list/subscribe 的类型客户端。
- desktop/cloud runtime：从宿主生成 principal 并调用 API；禁止透传插件自报 packageId/teamId。
- realtime gateway：Milestone 3 的 presence 与 change rooms，不拥有持久数据。

## Data Model

PluginSharedNamespace:

- id
- teamId
- ownerKind PACKAGE 或 WORKFLOW
- ownerId
- name
- generation
- deletedAt?
- activeSchemaVersion
- nextValueRevision BigInt
- nextChangeCursor BigInt
- usedBytes
- quotaBytes
- createdAt、updatedAt
- 唯一键 teamId + ownerKind + ownerId + name

删除 namespace 时在事务中校验 owner/admin，清除全部 value 正文与 usedBytes、设置 deletedAt 并递增 generation，但保留 namespace id、nextValueRevision 和 nextChangeCursor。重新创建同 owner/name 只允许原子 reactivation 同一行，再次递增 generation 且不重置 allocator。授权、runtime token、relist token、page cursor 和 realtime room 都绑定 namespaceId + generation；旧 generation 请求返回 `shared_namespace_generation_stale`。保留的 identity 行不向普通 list 返回，也不包含用户值。

PluginSharedValue:

- namespaceId
- key
- valueJson
- schemaVersion
- valueBytes
- revision BigInt
- createdByUserId、createdByPackageId
- createdAt、updatedAt
- 唯一键 namespaceId + key

PluginSharedNamespace.nextValueRevision 在每次 create/update/delete 事务中递增并分配给该次变更；value 行只保存当前 revision，DELETE outbox 保存删除 revision 后可移除 value 行。重建同名 key 继续从 namespace allocator 取更大 revision，因此旧 expectedRevision 永远不能命中新值。value revision 与 nextChangeCursor 是独立序列，前者用于 CAS/ABA 防护，后者用于 namespace 事件续传。

PluginSharedValueArtifact:

- `namespaceId`, `namespaceGeneration`, `key`, `valueRevision`, `artifactId`, `jsonPointer`, `executionKind=STANDARD`。
- unique `(namespaceId, namespaceGeneration, key, valueRevision, artifactId, jsonPointer)`；只表示当前已提交 value 中结构校验通过的 ArtifactRef，不保存下载 credential。
- 每条 edge 对应 action-owned `RuntimeArtifactGrant(targetKind=SHARED_VALUE, targetId/scopeDigest, executionKind=STANDARD)` 与可续但单次有界的 `RuntimeArtifactHold(purpose=SHARED_VALUE)`。scope digest 绑定 namespace ID/generation/key/valueRevision/artifact ID；action canonicalizer 据此产生 subjectKey/holderKey，数据库 unique 使并发 writer/reconciler 只得到一个 grant/hold row。grant expiresAt 与 hold retainUntil 同受 shared retention cap，JSON 中的 handle 自身不授予读取。

set/CAS 在同一事务验证当前 STANDARD invocation live source grant、分配新 value revision、写 value/edges、insert-or-read canonical SHARED_VALUE grants/holds，并对被替换 revision 写 grant.revokedAt/hold.releasedAt；任一步失败全部回滚。delete、namespace clear/reactivate 同事务撤销旧 edge 授权。reconciler 比较 live value revision 与 edge/grant/hold，只以 CAS 延长仍 live 且未超过平台 retention 上限的 shared rows，补齐缺失 row并清理孤立项；expired/revoked/released row 不 reopen，续租错过后该 value 显式 artifact expired，必须写新 revision/import，不能无限续租或按 team 猜测授权。

SharedStateOutbox（同时作为保留窗口内的 durable change log）：

- id、teamId、namespaceId、cursor BigInt、key、revision、schemaVersion、eventKind、createdAt、publishedAt、attempts
- 唯一键 namespaceId + cursor；cursor 从 PluginSharedNamespace.nextChangeCursor 在数据事务内单调分配，永不复用
- 已发布事件至少保留 7 x 24 小时，平台配置只允许延长保留期

Presence 不进入主数据库。生产使用 Redis TTL 和 Socket.IO Redis adapter；开发单实例可用内存适配器，但 production 启动在缺 Redis 时对 realtime feature fail-close。

## Namespace And Principal

InvocationPrincipal 由 action/runtime 子任务定义，至少包含 userId、teamId、caller package/release/action、workflow version/run、requestId。SharedStateService 根据 ownerKind/ownerId 构造 namespace，并调用统一 policy evaluator。

写权限默认只授予 owner。跨插件读取和写入分别使用治理 contract 的独立策略动作 `shared_data_read` 与 `shared_data_write`，不得创建 shared 模块私有别名。工作流节点不继承被调用插件之外的额外权限。

## API And SDK

- GET /api/plugin-shared/namespaces/:ownerKind/:ownerId/:name/values/:key
- PUT 同一路径，body 包含 value、schemaVersion、可选 expectedRevision；响应与后续 GET 都包含持久化的 schemaVersion 和 revision。
- DELETE 同一路径，要求 expectedRevision 防止误删新值。
- GET /values 使用独立的 pageCursor、limit 和 prefix。第一页在主库事务中先捕获 namespace 当前最高已提交 change cursor，再执行任何 value 查询，并返回绑定 namespaceId/generation/prefix/snapshotCursor/expiry 的签名 relist token；后续页必须携带该 token且始终回显同一 snapshotCursor。pageCursor 只用于列表翻页，不得作为 change cursor。
- GET /changes 使用 after change cursor 和 limit，严格按 namespace cursor 升序返回 SharedChangeEvent 与 nextCursor。after 早于 7 天保留窗口时返回 HTTP 410 `shared_change_cursor_expired` 和当前可重建的 latestCursor，不返回不完整结果。
- GET /export 仅 owner/admin，流式导出 JSONL，不一次加载整个 namespace。namespace delete 为逻辑身份删除 + 值正文清除，禁止物理删除后以同 owner/name 新建并重置 allocator。

SDK 普通 set 省略 expectedRevision，语义为 last-write-wins 并返回新 revision；协作路径必须使用 compareAndSet。所有响应经过 contract decoder。

SharedStateService 只接受 runtime bridge 提供的当前 invocation identity，不向普通 session API 返回 artifact-backed value。写入遇到 ArtifactRef 时调用 action-owned helper 验证同 team、STANDARD kind、source grant、完整性和有效期；读取在 `shared_data_read` 允许且 edge/value revision 仍匹配后，原子为当前 STANDARD invocation 创建最小 grant，再返回原 ArtifactRef。PREVIEW 调用、旧 revision、孤立 edge、仅 team 匹配或已过 retention 上限均返回稳定拒绝/过期错误。

## Validation And Quota

- key 归一化后校验长度、控制字符、保留前缀和重复。
- JSON 在入口序列化一次并按 UTF-8 字节计量，服务端保存同一规范化值。
- 单值默认 64 KiB；namespace 默认 10 MiB；更新事务按 old/new valueBytes 调整 usedBytes。
- CAS 使用 revision 条件 updateMany；quota 更新、value 写入/删除、namespace value revision 分配、change cursor 分配与 outbox 插入在同一事务，冲突返回 409 shared_revision_conflict。create/update/delete 都从 nextValueRevision 分配新值，禁止 delete/recreate 复用旧 revision。
- ArtifactRef 作为受限 tagged value；规范化 value 时递归提取 JSON Pointer 并拒绝重复/篡改引用。写入由 ArtifactService 校验 STANDARD source grant并原子转为 value-revision-scoped SHARED_VALUE grant/hold，读取再兑换当前 invocation grant；update/delete/namespace clear 释放旧 scope。

## Schema Contracts

插件 manifest 可声明 shared_namespaces，每项包含 name、activeSchemaVersion、read/write purpose 与各可读版本对应的可选受限 JSON Schema。服务端在 namespace 保存 activeSchemaVersion，并在每条 PluginSharedValue 保存该值实际使用的 schemaVersion。

普通写入只接受声明且当前可写的 schemaVersion，并先按对应 schema 校验 value；读取按值自身持久化的 schemaVersion 再校验并原样返回。若调用 release 未声明可读该版本，返回 `shared_schema_version_unsupported`，不得套用 active schema 或隐式转换。

Schema 破坏性升级必须注册目标 schemaVersion 并使用显式迁移 action。迁移逐 key 读取旧 schemaVersion/revision，校验源值，转换后校验目标 schema，再以 expectedRevision CAS 写入目标 schemaVersion；冲突时重新读取并重试或报告，绝不覆盖并发值。迁移可分批进行，因此旧、新版本值允许暂时共存；release 更新不会改变 namespace owner identity。

## Legacy Compatibility

现有 plugin.setSharedData/getSharedData/listSharedKeys 保留 localStorage 行为并标记 legacy local。新 manifest 才注入 sdk.shared。Creator/SDK 文档明确两者差异，禁止登录后自动上传。

可提供用户主动导出本机 JSON 的工具，但导入云端必须显示 namespace、条目数、冲突策略和敏感数据警告，且不属于首版验收。

## Realtime And Presence

Milestone 3 使用 Socket.IO 的命名空间 /plugin-shared：

- 连接时验证普通 session 或短期 runtime token，加入 team + namespace room。
- presence heartbeat 每 30 秒刷新 Redis TTL，90 秒无心跳即离线。
- 在线投影只包含 userId、displayName、package/workflow context 和 lastSeen，不持久记录轨迹。
- 数据事务同时写 outbox；publisher 成功广播后标 publishedAt。
- SharedChangeEvent 只含 namespace/cursor/key/revision/schemaVersion/eventKind，不含 value；cursor 是 namespace 级提交顺序，revision 只用于单 key CAS。
- 首次或全量 relist 时，客户端从第一页取得 capture-before-list 的签名 relist token/snapshotCursor，并在所有分页沿用；每个 key 只接受高于本地值的 revision。完成后调用 changes-after(snapshotCursor) 补齐分页期间的 create/update/delete；若分页已读到更高 revision，重复/较旧事件只推进 namespace cursor 而不回退值，然后进入实时订阅。
- 重连携带 last namespace cursor。网关先加入 room 并建立 live watermark，暂存 watermark 之后的 live 事件，再补发 changes-after 到该 watermark，最后按 cursor 顺序排空暂存事件并切到实时流；客户端按 cursor 去重并按 key/revision 拉取源数据。
- changes-after 从 SharedStateOutbox 的 durable change log 读取，已发布事件至少保留 7 x 24 小时。cursor 早于最早保留项时返回 410 `shared_change_cursor_expired`；SDK 清空增量假设、全量 relist，并以新的 snapshotCursor 重新订阅。

Socket.IO 与 Redis adapter 是成熟实时传输层；不自研 WebSocket 帧、重连或房间协议。

## Security And Privacy

- 所有访问先做 team claim、membership、policy 和 namespace ownership 校验。
- ArtifactRef 授权必须同时匹配 namespace generation、key、value revision、STANDARD execution kind 与当前 invocation；hold 不授予读取，PREVIEW 和 team-wide fallback 均禁止。
- 审计 metadata 不写 value；错误不回显其他团队是否存在同名 key。
- Secret-like 内容无法可靠静态识别，因此以 manifest 审核、SDK 类型与文档阻止，并提供独立 secret capability；共享 API 不承诺加密 secret 语义。
- 管理员导出和删除需要专用权限并记录条目数/字节数，不记录正文。
- Rate limit 按 team/package/action，防止 key 枚举和写放大。

## Compatibility And Migration

- Prisma schema 同时通过 postgresql/mysql provider 渲染；BigInt revision 与 namespace change cursor 在 HTTP contract 中编码为十进制字符串。
- 新表先扩展迁移，无数据回填。feature flag 关闭时旧本机 API 继续工作。
- realtime 在 KV 稳定后单独开启；关闭 Socket.IO 不影响 REST CRUD。

## Rollout And Rollback

- PLUGIN_TEAM_SHARED_STATE_ENABLED 控制云端 KV 注入。
- PLUGIN_SHARED_REALTIME_ENABLED 独立控制 Milestone 3。
- 先开放平台内置参考插件，再按团队 allowlist，最后一般可用。
- 回滚只关闭新 API/bridge；保留数据库与 outbox 数据，不把云端值回灌 localStorage。
