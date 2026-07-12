# Design: 插件导入、发布与治理系统

## Architecture

```text
外部源码目录 / .lfplugin / 灵枋创建器
                 |
                 v
桌面端本地检查与来源采集
                 |
                 v
Tauri 流式打包/上传 ------------------------------+
                 |                                |
                 v                                |
POST /plugin-registry/releases                    |
  -> v4 ZIP/manifest 校验                         |
  -> immutable PluginRelease + provenance         |
  -> audit                                        |
                 |                                |
          +------+-------+                        |
          |              |                        |
          v              v                        |
      团队目录      submit-marketplace            |
                         |                         |
                         v                         |
               PENDING -> admin review -> listing+
```

本机 installation origin 继续描述制品从哪里安装；PluginRelease provenance 描述该版本由什么创作/接入方式发布，两者不合并。

## Shared Contract

在 `packages/contract/src/plugin-registry.ts` 增加：

- `PluginReleaseSourceKind`：`LINGFANG_CREATOR | EXTERNAL_TOOL | LOCAL_ARTIFACT | COPIED_INSTALLATION | API | LEGACY_MIGRATION | UNKNOWN`。
- `PluginIngestChannel`：`DESKTOP | API | MIGRATION`。
- `PluginReleaseSummary.sourceKind/sourceLabel/ingestChannel`。
- `DraftWorkspace.sourceKind/sourceLabel`，旧本地 ledger 缺字段时默认 `UNKNOWN`。
- 团队发布管理 item/detail/listing 投影和状态变更请求 schema。

`sourceLabel` 只允许去首尾空白后的 0..80 字符。路径、token、环境变量和任意 JSON metadata 不进入该字段。

## Database

`PluginRelease` 增加 additive 字段：

- `sourceKind PluginReleaseSourceKind @default(UNKNOWN)`
- `sourceLabel String @default("")`
- `ingestChannel PluginIngestChannel @default(API)`

`MarketplaceListing` 增加：

- `delistedBy MarketplaceDelistActor?`，取值 `OWNER | PLATFORM`
- `delistReason String @default("")`
- `delistedAt DateTime?`
- `delistedByUserId String?`

已有 `DELISTED` listing 回填为 `PLATFORM`，因为旧系统只有平台管理员下架入口。旧 registry release 回填 `UNKNOWN/API`；显式 legacy migration 新建 release 使用 `LEGACY_MIGRATION/MIGRATION`。

## Upload Boundary

上传仍使用 raw ZIP stream，避免 multipart 或 WebView 内存缓冲。来源通过受长度限制的请求 metadata 传递：kind/channel 为 ASCII 枚举，label 使用 UTF-8 base64url header。服务端决定 ingest channel 的默认值并再次校验，不信任本地路径或客户端安全声明。

Tauri 抽取一个共享的 `upload_artifact_file()`：

- `publish_draft_workspace` 先打包 workspace，再调用共享上传器并标记 workspace 已发布。
- `publish_local_artifact` 先本地 inspect，再直接调用共享上传器，不创建 installation 或 workspace。
- 上传成功后，前端按目标决定是否调用 `submit-marketplace`。

## State Machines

### Package

```text
ACTIVE --archive--> ARCHIVED --restore--> ACTIVE
```

- archive 原子地将 ACTIVE listing 置为 DELISTED/OWNER。
- ARCHIVED 禁止发布新 release、提交审核和恢复 listing。

### Release

```text
PUBLISHED --yank--> YANKED --restore--> PUBLISHED
```

- yank 当前 ACTIVE listing release 时同步 owner delist。
- yank PENDING release 时将 review 状态撤回到 DRAFT 并写 review/audit。
- restore 不自动恢复 listing。

### Marketplace Review

```text
DRAFT|REJECTED --submit--> PENDING
PENDING --withdraw--> DRAFT
PENDING --approve--> APPROVED
PENDING --reject--> REJECTED
```

submit/withdraw/approve/reject 使用 `updateMany(where: id + expected state)` 抢占。count != 1 返回 409；只有抢占成功者写 review/audit。

approve 后从同包 `PUBLISHED + APPROVED` releases 中按严格 SemVer 选择最高版本作为 current release，避免旧版晚通过造成降级。

### Listing

```text
DRAFT --approve--> ACTIVE
ACTIVE --owner delist--> DELISTED(OWNER)
ACTIVE --platform suspend--> DELISTED(PLATFORM)
DELISTED(OWNER) --owner relist--> ACTIVE
DELISTED(PLATFORM) --platform relist--> ACTIVE
```

恢复前必须验证 package ACTIVE、current release 属于该 package 且 `PUBLISHED + APPROVED`。owner 无权恢复 PLATFORM 下架；platform 恢复清空 delist metadata。

## Permissions

- 新 release：`team.plugin.upload`。
- 现有 package 新版本/撤回 release：作者或具备 `team.plugin.edit_draft` 的成员。
- package archive/restore：`team.plugin.edit_metadata`。
- submit/withdraw/owner listing status：`team.plugin.submit_marketplace`；价格仍需 `team.plugin.edit_price`。
- 市场购买：`team.plugin.install`。
- approve/reject/platform suspend/relist/review artifact：`platform.plugin.review`。

Service 不再只用旧 `membership.role === TEAM_ADMIN` 判断自定义角色能力；细粒度权限由 guard/helper 执行，作者限制只用于保护个人 package 所有权边界。

## Binary Integrity

新增 tagged file payload：文本返回 UTF-8，非 UTF-8 返回 base64 + `binary=true`。所有 workspace 加载/刷新和持久化路径使用同一 helper；文本批量写，二进制调用 byte writer。打包直接读取工作区文件系统，因此只要本地读写不破坏字节，最终 artifact SHA 即稳定。

## Manifest Validation

Rust 和 Node 保持同一关键约束：

- `_meta.json` 与 `manifest.json` 各自不超过 256 KiB。
- id/name/description/entry 有长度上限，entry 必须为安全相对路径并存在。
- runtime/visibility 为共享枚举。
- capabilities 不超过 64 项，kind/risk/requires_admin/reason 结构有效。
- ZIP 数量、大小、CRC、路径与缓存目录规则继续使用现有 v4 防护。

## UI Boundaries

- `DraftPlugins` 成为“本地草稿 / 已发布”工作台，并提供本地上传入口。
- 共享发布 Dialog 负责来源、目标和价格；Creator 与草稿列表复用同一目标语义。
- 团队发布管理按 package 列表，详情按需加载 releases，并只显示当前状态允许的动作。
- Plugin Center 的 Team/Market 仍是消费目录，只补来源展示，不承载完整作者治理。
- collab-admin 按 package 展示，release 详情显示来源和精确 currentReleaseId；平台动作走明确按钮与确认 Dialog。

## Compatibility And Rollout

顺序：contract/schema -> migration/generate -> backend state machine/tests -> Tauri upload/binary -> desktop UI -> admin UI/metrics。

所有 schema 变化为 additive；旧 desktop 不传来源时服务端记录 `UNKNOWN/API`。旧 local workspace ledger 通过 serde default 自动读取。若 UI 阶段回滚，新增 API 和字段不影响现有团队/市场 catalog。

现有 `07-12-admin-governance-center` 继续负责把插件治理与团队管理员申请合并为单一治理中心；本任务只实现插件领域所需的来源、状态和正确投影，避免重复改造非插件审批。
