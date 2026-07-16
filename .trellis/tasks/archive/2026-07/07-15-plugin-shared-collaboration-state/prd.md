# 插件共享数据与协作状态

## Goal

将当前仅存在于桌面 localStorage 的实验性共享数据扩展为正式、团队隔离、可授权的云端 JSON KV，并在后续里程碑提供轻量 presence、基于 namespace change cursor 的实时变更通知与基于 revision 的协作写入。

## User Value

- 同一工作流中的插件可以稳定共享结构化状态，而不依赖本机目录、裸 URL 或用户手工复制。
- 团队成员在不同设备上看到同一份已授权状态。
- 插件可以感知谁正在使用同一协作空间并及时刷新数据，同时避免完整协同编辑器的复杂度。

## Confirmed Facts

- 当前 apps/desktop/src/lib/plugin-shared-data.ts 仅按插件 ID 写入本机 localStorage。
- 当前 runtime shim 暴露 setSharedData/getSharedData/listSharedKeys，但正式 contract 与 plugin-sdk 没有对应声明。
- 现有调用方可读取其他插件命名空间，却没有团队、release、policy、schema、quota 或云同步边界。
- 当前实现和测试曾用共享 KV 保存 credential/token；新云端能力不能被当作 secret vault。

## Milestone 1 Scope: Team Shared KV

- 团队级命名空间由稳定 package 或 workflow 身份拥有，不以本机 installation ID 或可变 release ID 命名。
- 命名空间内提供 get、set、compare-and-set、delete 与分页 list。
- 值仅允许 JSON；图片、视频、音频和大文件只保存 ArtifactRef。每个嵌套引用同时建立与 value revision 绑定的服务端 artifact edge，不把 JSON handle 当作 bearer 权限。
- 每个值持久保存并返回 schemaVersion、revision、updatedAt 和非敏感写入者投影；schemaVersion 参与写入校验、读取解码和显式迁移。
- 默认只有命名空间所有者可写；其他 package/action/workflow 的读写必须由团队策略显式允许。
- 团队管理员可以查看用量、导出和删除命名空间，但普通成员不能浏览插件未公开的 key。

## Milestone 3 Scope: Collaboration State

- 提供命名空间级在线成员 presence，不持久保存成员轨迹。
- 提供共享 JSON key 的变更订阅，以及 namespace 级单调、持久 change cursor 支持的断线续传。
- 协作写入复用 Milestone 1 的 compare-and-set，使用 expected revision；冲突返回当前 revision，客户端刷新后重试。
- 不提供 CRDT、富文本文档共同编辑、分布式锁或租约。

## Requirements

- 平台从经过验证的 invocation principal 推导 team、package、action、workflow 和 user 身份，不接受插件自行上报调用者 ID。
- 默认配额为 key 最长 128 字符、单值 64 KiB、单命名空间 10 MiB，可由平台配置但必须服务端强制。
- key 只能使用规范化 UTF-8 字符，不允许空 key、路径语义、控制字符或保留前缀。
- 写入前校验 JSON 可序列化、schemaVersion 对应的已声明 schema、策略、配额与可选 expected revision，并把 schemaVersion 与值一起持久化。
- 读取必须返回持久化 schemaVersion 并按该版本校验；调用方不支持该版本时返回稳定错误，不得静默按当前 schema 解读或自动转换。
- schema 破坏性升级只能由显式迁移 action 执行：按旧 schemaVersion 读取和校验，转换后按目标 schemaVersion 校验，并以 expected revision CAS 写回；迁移可重试且不得覆盖并发新值。
- ArtifactRef 写入只接受 STANDARD invocation 的有效 source grant；SharedStateService 在值事务内为 namespace ID + generation + key + value revision acquire canonical SHARED_VALUE grant 与有界可续 hold，action-owned subjectKey/holderKey 数据库唯一。读取先完成 `shared_data_read` 策略，再把该精确 live value grant 原子兑换为当前 STANDARD invocation grant；PREVIEW、同 team 但未授权调用者或旧 revision 均不能读取。
- 更新/delete/key recreate/namespace delete-reactivate 必须在值/outbox 事务中切换 artifact edge，写旧 SHARED_VALUE grant.revokedAt/hold.releasedAt；reconciler 只可按 live value revision insert-or-read/延长仍 live 的 canonical rows或清除孤立 row，expired/revoked/released row 不 reopen。共享值超过平台 artifact retention 上限后显式返回 artifact expired并要求写新 revision，不允许无限 pin 或退化成 team-wide 读取。
- 共享 KV 不是凭证存储；API、文档和审核禁止在其中保存 token、密码、私钥或 provider key。
- 审计只记录 team、namespace、key、revision、调用主体、动作、字节数和结果，不记录值正文。
- 团队停用或策略撤回后立即拒绝访问；release 更新不改变命名空间身份。
- 卸载本地插件不得自动删除团队云端数据；删除必须由命名空间所有者或管理员显式执行。namespace 删除只清空值并逻辑停用，保留不可访问的 identity/allocator 元数据；同 owner/name 重建复用原 identity、递增 generation，value revision/change cursor 永不重置。
- 旧 setSharedData/getSharedData/listSharedKeys 继续保持本机语义，避免静默上传历史 localStorage；新能力使用正式 sdk.shared API。
- Presence 默认 30 秒心跳、90 秒过期；生产多实例部署必须使用共享实时适配器，不能依赖单进程内存。
- 每次已提交变更在所属 namespace 内分配单调、持久且不复用的 change cursor；cursor 与单 key revision 是两套不同序列。
- value revision 从 namespace 级持久 `nextValueRevision` 单调分配，跨 key/create/update/delete 均永不复用；DELETE 可移除值行，但删除事件保存新 revision，重建必须再分配更大 revision。旧 expected revision 在 delete -> recreate 后必须返回 409，不能发生 ABA 覆盖。
- changes-after API 按 cursor 顺序返回持久变更。首版变更至少保留 7 x 24 小时，只允许配置延长；cursor 早于保留窗口时返回显式 410 `shared_change_cursor_expired`，客户端必须全量分页 relist，取得新 snapshot cursor 后继续增量同步。
- 全量 relist 的 snapshot cursor 必须在第一页任何 value 查询之前从主库捕获，并通过不变的 relist token 贯穿所有分页；SDK 完成分页后只接受更高 key revision，再从该 snapshot cursor 补齐 changes，不能在列表结束后才读取 watermark。

## Acceptance Criteria

- [ ] 两个团队使用相同 package/key 时数据完全隔离，跨团队读取、订阅和 ArtifactRef 解析均被拒绝。
- [ ] 默认只有 namespace owner 可写；显式团队策略可以按 package/action/workflow 收窄开放读或写。
- [ ] set/get/delete/list 与 compare-and-set 在 MySQL 和 PostgreSQL 渲染模式下行为一致。
- [ ] 并发 expected revision 写入只有一个成功，失败方收到 409、当前 revision 和可重试信息。
- [ ] key 从 revision N 删除并重建后 revision 大于 N；持有旧 expectedRevision=N 的客户端更新必定收到 409，DELETE 后 GET/list 不返回已删除值正文。
- [ ] namespace 删除并以相同 owner/name 重建后沿用原 allocator 且 generation 增加；旧 value revision、relist token、runtime token 和订阅均不能命中新 generation，值正文已不可恢复。
- [ ] 每条 PluginSharedValue 均持久保存并返回 schemaVersion；未声明或不受支持的版本写入/读取被拒绝，显式迁移通过源/目标 schema 校验与 CAS，且不会覆盖并发更新。
- [ ] 配额、非法 key、不可序列化值、过期/越权 ArtifactRef 和 secret-like manifest usage 被明确拒绝或审核拦截。
- [ ] ArtifactRef 写入会验证 STANDARD source grant并原子创建 value-revision-scoped SHARED_VALUE grant/hold；授权读取只为当前精确 invocation 兑换权限，PREVIEW、其他 key/revision/package/team 均拒绝。
- [ ] 覆盖 ArtifactRef 的 CAS 更新、delete/recreate、namespace delete/reactivate 与事务后崩溃；旧 grant/hold 不再授权，新值不会因普通 runtime TTL 提前清理，reconciler 不产生 team-wide 或无限 hold。
- [ ] 并发 set/reconciler 对同一 value revision/artifact 只产生一个 canonical grant/hold row；revoked/released/expired row 不 reopen，错过续租后必须写新 value revision。
- [ ] 审计与日志不包含 JSON 值、token、签名 URL 或 ArtifactRef 私有下载凭据。
- [ ] 现有本机共享数据不会在升级或登录时自动同步；旧插件行为保持兼容。
- [ ] Presence 在加入、心跳、离开和超时后产生正确成员投影；断线重连按 namespace change cursor 补取变更，不把 key revision 当作全局游标。
- [ ] changes-after 在 7 天保留窗口内按 cursor 无缺口返回已提交更新；重复事件按 namespace/cursor 幂等处理。
- [ ] 全量 relist 在第一页前固定 snapshot cursor，所有 page token 绑定同一 snapshot；分页期间并发 create/update/delete 通过 revision 去重和 changes-after 补齐，不会漏项或把新值回退到旧 revision。
- [ ] cursor 过期返回 410 `shared_change_cursor_expired`，SDK 全量分页 relist 并使用新 snapshot cursor 恢复订阅，不静默跳过缺失变更。
- [ ] SDK、desktop、collab-api、contract 的类型、单测与跨层回归通过。

## Dependencies

- 团队插件策略与治理：namespace 读写授权。
- 跨插件 Action 调用：InvocationPrincipal、ArtifactRef、action/workflow 身份。
- 工作流插件平台：workflow namespace 与运行时 SDK 注入。
- Cloud 插件与定时自动化：cloud worker 对 sdk.shared 的调用上下文。

## Out of Scope

- 自动迁移、合并或上传现有 localStorage 共享数据。
- Secret vault、凭证代理或任意二进制文件存储。
- CRDT、富文本共同编辑、锁、租约、离线多主合并或完整事件溯源数据库。
- 面向普通成员的全团队数据浏览器。

## Decisions

- Milestone 1 交付团队 JSON KV 与 compare-and-set 原语；Milestone 3 仅增加 presence、变更订阅和基于既有 CAS 的协作 SDK 流程。
- 新 sdk.shared 与旧本机 API 并存，不改变旧 API 的存储位置。
- 服务端 package/workflow 身份和团队策略是访问真相，客户端插件 ID 只作展示。
- schemaVersion 持久化到每条共享值；平台只做声明版本的校验与显式 CAS 迁移，不做隐式 schema 转换。
- 实时续传使用 namespace 单调持久 cursor，首版最低保留 7 天；过期后以显式 410 驱动全量 relist。
