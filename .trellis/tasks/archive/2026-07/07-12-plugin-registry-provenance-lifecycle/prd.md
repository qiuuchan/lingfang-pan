# 插件来源与生命周期后端基础

## Goal

为 v4 插件 registry 增加 release 级来源、可恢复的 package/release/listing 生命周期、作者撤回提审、平台治理并发保护和稳定的管理投影，为桌面端与管理端提供同一套可信后端契约。

## Requirements

- 在共享 contract 和 Prisma 中增加 release source kind、source label、ingest channel；旧记录兼容回填。
- MarketplaceListing 记录 owner/platform 下架方、原因、时间和操作者，支持权限隔离的恢复。
- 提供团队发布管理列表，包含全部 ACTIVE/ARCHIVED package、release 摘要、pending 数量和 listing 状态，不复用只显示可下载项的 team catalog。
- 提供 package archive/restore、release yank/restore、market submission withdraw、owner delist/relist API。
- 提供 platform suspend/relist 和审核制品下载能力；平台操作继续保留 artifact/history/entitlement。
- approve/reject/withdraw 等终态转换使用事务内条件更新；同一 expected state 只能被一个请求抢占。
- approve 后按严格 SemVer 从 APPROVED+PUBLISHED releases 选择市场 current release。
- 非 current release 不能执行 release-based delist；current 判断必须返回给消费者。
- 新版本发布持久化来源并写审计；legacy migration 显式写 `LEGACY_MIGRATION/MIGRATION`。
- publish 现有 package 时允许作者或具备对应插件编辑权限的自定义角色，不再只依赖旧 TEAM_ADMIN 枚举。
- purchase 增加 `team.plugin.install` 权限保护。
- manifest metadata 增加字段长度、visibility、capability 和 256 KiB 元数据上限，失败时不创建 release 或永久 artifact。

## Acceptance Criteria

- [ ] Contract schema 能解析所有新增 provenance、management 和 listing delist 字段，并拒绝非法枚举/超长 label。
- [ ] additive migration 可在现有数据上部署，旧 DELETED/DELISTED 与 legacy release 有明确回填语义。
- [ ] 新上传 release 返回并持久化准确的 sourceKind/sourceLabel/ingestChannel。
- [ ] package/release/review/listing 所有合法动作成功并写 audit，非法前置状态返回 409。
- [ ] owner 不能恢复 PLATFORM 下架，platform 可以恢复平台下架；恢复前验证 current release 不变量。
- [ ] 并发 approve/reject 只有一方成功且只有一条终态 review/audit。
- [ ] 旧版本晚 approve 不会把 currentReleaseId 从更高 SemVer 降级。
- [ ] team catalog 不出现 ARCHIVED/YANKED；manage list 仍可看到并恢复它们。
- [ ] marketplace entitlement 不能下载未审核 release；平台审核者可以审计式下载待审 artifact。
- [ ] 超大 metadata、非法 visibility/capability/entry 明确拒绝且 artifact store 无悬挂对象。
- [ ] contract 与 collab-api tests/typecheck/build 通过。

## Out Of Scope

- 桌面文件选择、上传 Dialog 和本地 workspace 实现。
- collab-admin 的最终视图布局。
- 本机 installation enable/disable。

## Planning Status

- 父任务已完成证据审计并批准本子任务先行实施，无开放问题。
