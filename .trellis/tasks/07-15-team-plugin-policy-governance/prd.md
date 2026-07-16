# 团队插件策略与治理

## Goal

在现有 v4 package/release、团队 RBAC、PluginGrant、权益和发行门禁之上，交付一套团队级插件策略，使安装、更新、运行及新增高风险能力都经过同一个可解释、可审计的决策入口。

## User Value

- 团队管理员可以直接控制团队允许使用的插件来源、能力、版本和运行方式，不需要维护另一套角色或审批系统。
- 团队成员在桌面、工作流、Cloud、Web 预览和共享数据入口得到一致的允许或拒绝结果，并能看到可理解的原因。
- 现有 v4 本地插件升级后继续可用；跨插件调用、Cloud、定时任务和团队共享数据不会因安装或升级自动获得权限。
- 策略变更具有版本、审计、预检和回退能力，误配置可以快速恢复。

## Confirmed Facts

- 当前远端插件事实模型是 `PluginPackage -> PluginRelease -> MarketplaceListing`；发行版具有不可变 `releaseId + sha256`、来源、审核、撤回和 AI policy 状态。
- 当前团队角色以 `Role(scope=TEAM)` 和预定义权限码为准；HTTP 守卫与 service helper 都从当前 membership 的 `teamRoleId` 解析权限。
- 当前 `PluginGrant` 已支持 package 级 USER/ROLE ALLOW/DENY，解析顺序是用户优先于角色、同一主体 DENY 优先、无 grant 默认允许。
- 当前 v4 registry 和旧插件服务仍有系统团队管理员默认放行分支；这与本任务确认的“Owner/Admin 运行时无隐式绕过”不一致，必须收敛到统一决策器。
- 当前团队来源插件运行前已有在线 `runtime-access` 校验；已购市场插件可本地长期运行，本机安装账本是设备安装状态事实源。
- 当前没有团队策略修订、统一高风险默认值、按 action/workflow 的允许项、决策解释或策略回滚模型。
- 用户已确认首版保持简单：Owner/Admin 在现有 RBAC 权限内直接修改允许项并留审计，不做 break-glass、临时豁免、二次审批或自动过期。

## Scope

- 团队策略的共享契约、持久化修订、发布、历史、预检、回滚和决策解释。
- 对插件来源、manifest capability、发行版本、安装、更新、本地运行和既有市场/团队访问条件的统一约束。
- 对跨插件 action、工作流、Cloud 执行、定时触发和团队共享数据的默认拒绝及 package/action/workflow 级显式允许。
- 复用现有团队 RBAC 管理权限和 package 级 PluginGrant，由一个治理 evaluator 统一读取 release/listing、安全政策、entitlement、团队策略及 USER/ROLE grant，形成单一解析链。
- 桌面端团队管理控制面，以及所有策略变更和高风险决策的审计。
- 对现有 v4 安装、更新、下载和运行入口的兼容接入；后续子任务通过同一决策接口接入各自的新入口。

## Requirements

### R1. 单一决策入口

- 所有策略消费者必须提交明确的 team、principal、非空 requiredOperations 和精确插件资源，并且每个请求只调用一次治理 evaluator；不得在 UI、桌面壳、invocation runtime 或各业务 service 内预先/再次读取 entitlement、release 状态、团队策略或 PluginGrant 来复制授权判断。
- requiredOperations 只能由可信宿主按执行上下文派生，插件 payload 不得自选。evaluator 在同一次事实装载和同一 policy revision 下分别计算每个 operation，只有全部允许才返回整体 ALLOW；任一拒绝都使复合请求整体拒绝并保留逐 operation 原因。
- evaluator 在一次一致的事实装载中统一读取 membership、精确 release/listing、安全政策、entitlement、团队策略和 USER/ROLE PluginGrant。决策顺序固定为：平台硬门禁、权益和发行状态 > 团队策略上限 > 用户显式 PluginGrant > 角色 PluginGrant > 调用或工作流请求。
- 下层 ALLOW 不能突破上层 DENY；用户规则可以覆盖角色规则；同一层级与同一具体度内 DENY 优先。
- Owner/Admin 只因 RBAC 权限获得策略管理能力，不因身份获得运行时绕过；其插件运行和调用与普通成员经过相同解析链。
- action 联合 gate 的依赖顺序固定为：治理 core evaluator 先稳定，action 任务再提供 contract/surface digest，治理模块随后提供 `GovernanceActionAdapter`，最后 invocation runtime 接入；invocation 只调用该 adapter 一次，不直接调用 core evaluator 或其他授权 service。

### R2. 团队策略范围

- 团队策略至少约束发行来源、声明 capability、版本或精确 release、安装、更新、本地运行和既有审核/发行条件。
- 策略可以按 package、具名 action 或已发布 workflow 设置允许或拒绝，并能绑定版本范围、精确 release 或已批准能力表面。
- package、action 或 workflow 规则的目标必须可稳定定位；显示名、latest 版本或 UI 当前选择不能成为授权键。
- 治理 contract 拥有 versioned `PackagePolicySurfaceV1` canonicalizer；registry 在 release 发布时从已验证 action/cloud、workflow plan、shared namespace 和 schedule eligibility 投影计算并持久化 digest。package 级高风险 ALLOW 必须绑定该精确 digest，缺失或任一表面变化均 fail closed。
- 平台审核、package/release 状态、AI policy、团队 membership、市场 entitlement 等现有事实继续是不可突破的门禁，但由统一 evaluator 装载和判定，而不是由调用方串联多个 gate。

### R3. 新增高风险能力默认拒绝

- 未配置团队和没有匹配允许项的团队默认拒绝跨插件 action、工作流运行、Cloud 执行、定时触发及团队共享数据读写。
- 管理员可以显式允许选定 package、action 或已发布 workflow；团队范围的“一键全部允许”不属于首版。
- package 级允许只覆盖管理员批准时已存在的高风险能力表面；新增 action、action contract、Cloud 标记、schedule 或共享数据范围必须重新授权。
- workflow 级允许只覆盖其冻结的发布版本和执行计划；计划或节点身份变化后必须作为新 workflow 版本重新评估。

### R4. v4 兼容默认

- 没有持久化策略的现有团队继续允许既有 v4 本地安装、更新和本地运行，保持当前无 grant 默认可用的体验。
- 兼容默认不适用于任何新增高风险 operation；高风险能力在迁移、灰度和回滚期间始终保持默认拒绝。
- 现有 PluginGrant 记录和用户优先于角色的语义必须保留，但系统团队管理员默认绕过必须移除。
- 策略上线不得修改不可变 release、设备安装账本或既有 entitlement，不得静默卸载、降级或替换本机插件。

### R5. 简单直接的管理流程

- 具有现有插件授权管理权限的 Owner/Admin 可以查看有效默认、编辑规则并直接发布新策略修订。
- 发布使用乐观并发，冲突时拒绝覆盖他人的新修订并提示刷新；不引入申请、审批、豁免或定时失效状态机。
- 发布前可以预检新策略对代表性或当前已安装资源的影响；已发布修订不可变。
- 管理员可以从历史修订发起回滚；回滚形成新的活动修订并完整记录操作者和来源修订。

### R6. 解释、审计与安全生效

- 每次决策返回稳定结果、命中的层级、规则或门禁标识和面向用户的原因；调用方不得自行推导业务真相。
- 策略发布、回滚和规则变更必须审计；高风险允许/拒绝及所有拒绝决策必须能按 request/invocation 追踪。
- 现有本地 operation 支持先观察后强制的灰度方式；观察模式不得把默认拒绝的高风险 operation 变成允许。
- 策略缓存必须按 team + active revision 隔离，并在发布、回滚、membership、grant、release 或 entitlement 变化后安全失效。

## Acceptance Criteria

- [ ] 未配置策略的现有团队仍可安装、更新和运行既有 v4 本地插件；同一团队的跨插件 action、workflow、Cloud、schedule 和共享数据请求默认被拒绝。
- [ ] 管理员显式允许一个 package、action 或 workflow 后，只对应冻结的目标和 operation 被放行，未选目标仍被拒绝。
- [ ] 平台门禁、团队策略、用户 grant、角色 grant 和请求范围的组合测试证明：下层 ALLOW 无法突破上层 DENY，用户规则可覆盖角色规则，同级同具体度 DENY 优先。
- [ ] action invocation 的授权路径只调用一次治理 action adapter；测试证明 invocation service 不直接查询 release/listing、entitlement、团队策略或 USER/ROLE grant，也不再次调用 core evaluator。
- [ ] requiredOperations 以 invoke_action 为基线；target runtime=workflow 时增加 run_workflow，Cloud execution 增加 execute_cloud，Web preview 增加 web_preview。组合只装载一次事实、返回一个整体 decision，任一子 operation deny 时 handler/child run 不启动。
- [ ] Owner/Admin 的直接本地运行、action 调用和 workflow 请求不会跳过团队策略、grant、权益或发行状态。
- [ ] 已有 user/role PluginGrant 的行为保持；无 grant 的既有本地 operation 默认允许，系统管理员特殊放行分支被移除且显式 DENY 对管理员生效。
- [ ] 来源、capability、版本、精确 release、安装、更新和本地运行至少各有允许、拒绝和解释测试。
- [ ] action contract、Cloud 标记、schedule 或共享数据表面变化后，旧允许项不再匹配并返回需要重新授权的明确原因。
- [ ] PackagePolicySurfaceV1 canonical fixture 对输入排序稳定；新增/移除 action、修改 action surface/cloud/preview flag、workflow plan、shared namespace/schema 或 schedule eligibility 任一项都会改变 digest，旧 package ALLOW 不能命中新 release。
- [ ] compound decision cache key 包含排序后的完整 requiredOperations digest；单 operation ALLOW 缓存不能命中其 superset，请求审计保存全部 operation_results。
- [ ] workflow 允许项只匹配精确发布版本及计划摘要；workflow 新版本不会继承旧版本授权。
- [ ] 两名管理员并发发布同一基线修订时只有一方成功，另一方得到冲突；历史修订均不可变。
- [ ] 回滚产生新的活动修订，恢复目标行为并保留发布者、回滚者、前后 revision 和原因审计。
- [ ] 决策解释包含最终结果、策略 revision、命中层级和稳定 reason code，不泄漏其他团队规则或内部路径。
- [ ] 观察模式只影响既有本地 operation 的执行方式；所有新增高风险 operation 仍默认拒绝。
- [ ] 桌面团队管理控制面可以查看有效默认、编辑并直接发布、查看历史及回滚，不出现 break-glass、临时申请或二次审批入口。
- [ ] v4 发布、审核、购买、下载、本机安装、更新、回滚和运行回归通过，策略数据不成为第二套 package/release/entitlement 事实源。

## Out of Scope

- break-glass、临时豁免、二次审批、限时授权和自动续期。
- 自定义策略脚本、通用布尔表达式语言、外部 OPA 服务或跨团队继承层级。
- 重写 Role、PermissionEntry、PluginGrant、PluginPackage、PluginRelease、MarketplaceListing 或 entitlement 模型。
- 在本任务中实现 workflow DAG、Cloud 执行器、scheduler、团队共享 KV 或 Web 预览；这些子任务只消费本任务的决策接口。
- 自动卸载、静默降级、自动改写 workflow 节点或把已撤回 release 替换为 latest。

## Dependencies

- 父任务：`.trellis/tasks/07-15-plugin-platform-phase-two` 的 R1、跨域身份约束和已确认默认值。
- 复用：`packages/contract`、collab-api v4 registry、`Role`/权限码、`PluginGrant`、`runtime-access`、AuditLog 和桌面安装账本。
- 跨任务落地顺序固定为：本任务先稳定通用 core evaluator；`.trellis/tasks/07-15-cross-plugin-action-runtime` 再提供 action contract、精确 target 和 surface digest；本任务基于该只读契约提供 governance action adapter；invocation runtime 最后接入该唯一 adapter。
- workflow、Cloud、Web 预览和共享状态子任务必须接入同一策略决策器；它们不得新增旁路授权实现。
