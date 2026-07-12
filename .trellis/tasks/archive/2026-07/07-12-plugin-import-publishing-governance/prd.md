# 完善插件导入、发布与治理系统

## Goal

让使用其他编程软件或灵枋创建器制作的插件，都能从本地安全导入并选择发布到团队或提交插件市场；同时为每个不可变发行版记录可追踪的发布来源，并为团队作者与平台治理者提供完整、受权限约束的生命周期状态操作。

## User Value

- 外部开发的插件不再只能本机安装或绕道创建器，合法 `.lfplugin` 与源码目录都有清晰的上传入口。
- 用户发布时明确选择“团队”或“市场”；市场始终复用同一个团队发行版并进入审核，不产生第二份制品。
- 团队成员和平台管理员能看懂插件由何种方式产生、当前处于哪条状态轴、下一步允许执行什么动作。
- 插件撤回、归档、下架和恢复不会删除历史制品、审核记录或已购权益。

## Confirmed Facts

- v4 registry 已支持流式接收并严格校验 `.lfplugin`，云端领域模型是 `PluginPackage -> PluginRelease -> MarketplaceListing`。
- 桌面插件中心的“本地导入”目前只创建本机 installation；草稿页导入可发布，但发布目标固定为团队。
- 市场提审 API 已存在，桌面端没有调用入口。
- 云端没有 release 级发布来源字段；现有 `builtin/local/team/marketplace` 仅表示本机安装渠道。
- Package、Release、Review、Listing 的状态枚举已存在，但作者侧归档/撤回/恢复 API 和 UI 不完整。
- approve/reject 当前先查后改，存在并发双成功；旧版本晚通过还可能覆盖更高市场版本。
- 外部源码目录导入会把二进制转为 base64，但草稿持久化和再次加载未完整保留二进制语义。
- 当前相关未提交改动集中在管理端 UI foundation 与创建器工作区；本任务必须在其上增量实现，不覆盖或回退这些改动。

## Requirements

### 1. Local Import And Publish Targets

- 桌面端提供统一、可发现的本地插件入口，支持 `.lfplugin v4` 和已有的源码目录导入路径。
- 不要求用户手工记忆绝对路径；Tauri 环境使用原生文件选择器，浏览器开发态保留可测试的路径回退。
- 发布目标至少包含“发布到团队”和“发布团队版本并提交市场”。
- 市场目标必须先成功创建唯一的团队 release，再调用提审；提审失败时保留已发布 release，并允许只重试提审。
- 目标选择受 `team.plugin.upload`、`team.plugin.submit_marketplace` 等权限控制，后端继续作为最终授权边界。

### 2. Release Provenance

- 发布来源记录在不可变 `PluginRelease`，因为同一 package 的不同版本可能来自不同工具。
- 来源至少区分：灵枋创建器、外部开发工具/源码目录、本地制品、已安装插件复制、API、旧数据迁移和未知历史数据。
- 可记录简短来源标签（例如 VS Code、Cursor、Trae），但不得上传本机绝对路径、密钥或其他隐私数据。
- 同时记录接入通道（desktop/API/migration），并在团队管理、市场目录、版本历史和平台治理详情中展示。
- UI 明确区分“发布来源”和“安装来源”，不把来源记录表述为安全认证或签名。

### 3. Lifecycle State Management

- Package 支持 `ACTIVE <-> ARCHIVED`；归档会停止团队目录曝光和新版本发布，并安全下架活动市场 listing。
- Release 支持 `PUBLISHED <-> YANKED`；撤回当前市场版时同步下架 listing，恢复 release 不自动恢复市场上架。
- Review 支持作者 `DRAFT|REJECTED -> PENDING`、`PENDING -> DRAFT` 撤回，管理员 `PENDING -> APPROVED|REJECTED`。
- Listing 支持作者主动下架/恢复和平台暂停/恢复，并记录操作方与原因；作者不得恢复平台暂停的 listing。
- 状态操作使用明确动作而不是万能下拉，并由服务端校验合法前置状态、权限和跨模型不变量。
- 所有状态变化写入审计；历史 release、artifact、review、purchase 和 entitlement 不物理删除。

### 4. Integrity And Compatibility

- 外部目录中的 PNG、字体、音频等二进制文件经过导入、保存、再次编辑和打包后字节保持一致。
- 源码目录导入限制与 v4 对齐为最多 1500 文件，不再无条件排除可能作为真实入口的 `dist`/`build`。
- Rust 与服务端对 manifest 的 runtime、entry、visibility、capability、字段长度和元数据大小执行一致的关键校验。
- 不升级 `.lfplugin` formatVersion，不把设备安装状态写入云端制品。

### 5. Governance Consistency

- 管理端按 package 和 release 展示发布来源、package/release/review/listing 四轴状态。
- “市场当前版”必须以 ACTIVE listing 的 `currentReleaseId` 精确判断。
- approve/reject 使用事务内条件更新，同一 PENDING release 只能有一个终态操作成功。
- 同包多个版本通过审核时，市场 current release 保持最高严格 SemVer，不因旧版晚通过而降级。
- 平台下架和团队主动下架要可区分；恢复动作只能由对应权限方执行。
- Dashboard 和插件治理统计以 v4 Package/Release/Listing 为事实来源，不继续依赖旧 `Plugin.reviewStatus`。

## Acceptance Criteria

- [x] 用户可从本地 `.lfplugin` 或已有源码目录路径进入发布流程，并选择团队或市场目标。
- [x] 市场发布只上传一次制品；提审失败后可单独重试，不产生重复版本。
- [x] 每个新 release 都持久化并返回 source kind、来源标签和 ingest channel；旧数据有诚实的迁移/未知来源。
- [x] 团队目录、版本历史、发布管理和平台治理均能看到发布来源，安装列表继续单独显示安装来源。
- [x] Package archive/restore、release yank/restore、review submit/withdraw/review、listing owner/platform delist/relist 都遵守合法状态机并写审计。
- [x] 并发 approve/reject 只有一个成功；旧版晚通过不会替换更高 SemVer 市场版本。
- [x] 非当前市场 release 不会错误触发整个包下架，也不会显示“市场当前版”。
- [x] 外部目录二进制文件导入、保存、重新加载、打包后的 SHA/字节不变。
- [x] manifest/capability/metadata 非法的外部包在客户端或服务端明确失败，不写 release 或永久 artifact。
- [x] Contract、collab-api、desktop、Tauri 和 collab-admin 的相关测试、类型检查与构建通过。

## Out Of Scope

- 允许插件运行时通过 SDK 自行发布插件；发布仍是宿主应用的受控用户操作。
- 改变 `.lfplugin` v4 的基本 ZIP 结构或引入新的制品格式版本。
- 本机 installation 的启用/禁用开关；本轮“状态修改”覆盖云端 package/release/review/listing 生命周期。
- 团队管理员申请等非插件审批领域的重构；现有治理中心任务继续负责其独立流程。

## Product Decisions

- 用户已明确要求不再提问并授权直接采用最优方案；所有无阻塞产品决策按现有领域模型和最小破坏原则收敛。
- 来源是 release 级可追踪声明，不是代码签名或可信认证。
- 市场是团队 release 的审核投影，不维护另一份市场制品。
- 状态恢复必须显式执行，归档/撤回后不自动重新上架市场。

## Task Map

- `07-12-plugin-registry-provenance-lifecycle`：共享契约、数据库迁移、来源持久化、状态机 API、并发与审计基础。
- `07-12-desktop-plugin-import-publish`：外部目录/制品导入、二进制完整性、团队/市场发布向导和团队发布管理。
- `07-12-plugin-governance-source-status`：管理端来源/状态展示、市场当前版与平台治理动作、v4 指标整合。

## Planning Status

- 仓库事实与历史任务已审计，无阻塞开放问题；用户已预先批准按本计划直接实施。
