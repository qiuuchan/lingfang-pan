# 跨插件 Action 调用

## Goal

交付跨 runtime 一致的具名 action 契约、发现与依赖解析、ArtifactRef、调用身份、授权门禁和执行适配层，使插件与工作流可以安全、可追踪地组合其他插件能力。

## User Value

- 插件作者可以把“生成图片”“生成视频”“生成配乐”等能力作为稳定 action 发布，并在其他插件或工作流中复用。
- 用户在组合插件前即可发现输入输出或版本不兼容，而不是运行到一半才失败。
- 图片、视频和音频通过平台制品引用传递，不依赖某台设备的路径、临时 URL 或巨大的 base64 字符串。
- 每次调用都保留实际用户、团队、调用方、目标精确版本、策略和结果，跨插件调用不会放大权限。

## Confirmed Facts

- 当前 manifest 只有宿主 `capabilities`，没有 action、dependency 或输入输出 schema；capability 的 `scope` 不能复用为 action contract。
- 当前 v4 release 已提供不可变 `packageId + releaseId + sha256`，并有来源、审核、撤回、AI policy、entitlement 和 runtime-access 门禁。
- 当前 client 插件通过 iframe `postMessage/__lingfangInvoke` 调宿主；Node/Python 通过 localhost 会话 token 桥调用少量平台能力；cloud 尚无生产执行器。
- 当前 Node/Python 持久化运行通道是用户权限下的不受控本地代码执行，action 边界不能宣称解决其 OS 级沙箱问题。
- 当前图片能力返回裸 URL/data URI，插件 artifactKey 仅指 `.lfplugin` 包；没有运行时 ArtifactRef 或通用运行制品模型。
- 当前没有跨插件 RPC、统一 invocation、调用链限制、action 幂等语义或 action 级审计。
- 用户已确认：一个插件可发布多个具名 action，单功能插件可只发布 `default` action；输入输出采用受限 JSON Schema；大型数据使用 ArtifactRef；发布工作流绑定精确 release/sha/action contract；运行时不静默推断或转换类型。

## Scope

- manifest 中 action 和 action dependency 的共享契约、发布校验、版本/兼容性规则和发现接口。
- 受限 JSON Schema 的语法、输入输出验证、兼容性检查和跨 runtime conformance fixtures。
- 平台运行时 ArtifactRef 的身份、完整性、团队授权、存储、读取、创建和清理边界。
- 统一 action invocation identity、状态、错误、超时、取消、幂等、调用链、并发、资源限制和审计。
- 统一 `STANDARD | PREVIEW` invocation kind；Web/Cloud 单 action 在线试跑使用同一 ActionInvocation 记录与状态机，不创建 preview 专用 run。
- client、Node.js、Python 的桌面 action adapter，以及供 Cloud 和 workflow 子任务注册的同一 adapter interface。
- 插件 SDK/宿主桥的 action 调用与 artifact API；所有 invocation 只调用一次治理模块提供的 action adapter。

## Requirements

### R1. 具名 Action 与依赖

- 一个 release 可以导出多个稳定 action；每个 action 声明 action ID、显示信息、action contract version、输入 schema、输出 schema、执行语义、超时、runtime-discriminated execution binding 和 cloud-capable 标记。
- 单功能插件可以只声明 ID 为 `default` 的 action；调用和工作流节点仍保存该 ID，不用空值或隐式入口表示。
- 插件可以按稳定 dependency alias 声明目标 package、release 版本范围、action ID 和 action contract version 范围；运行时不能调用未声明依赖。
- 同一 release 内 action ID 唯一；同一 action 的契约或执行表面变化必须提升 action contract version，并生成新的表面摘要。
- action 是对外能力；现有 manifest capability 仍表示 action handler 请求宿主权限，两者不得互换或相互推导。

### R2. 严格数据契约

- action 输入输出使用平台定义的受限 JSON Schema 子集，schema 和 payload 都有大小、深度与节点数上限。
- 发布时拒绝远程 `$ref`、递归、动态执行关键字、未支持组合器和无界对象；错误必须定位到 action、schema 路径和原因。
- MVP 不支持 JSON Schema `pattern` 或其他正则关键字，避免 JavaScript/Python/Rust 正则语义漂移和灾难性回溯；需要格式约束时只使用平台列出的固定 format/长度边界。
- 运行前验证输入，运行后验证输出；校验失败的结果不得传给下游节点。
- 兼容性检查使用同一受限子集；不兼容时必须由调用方选择其他版本或加入显式转换 action，运行时不自动猜测字段映射或转换。

### R3. ArtifactRef

- 小型 JSON 和文本可以内联；图片、视频、音频及其他大型或二进制值必须使用平台 ArtifactRef。
- ArtifactRef 包含不可伪造的制品身份、media type、大小、SHA-256 和团队授权范围；服务端仍须重新校验数据库授权，不把引用本身当作跨租户 bearer 权限。
- RuntimeArtifact 父行在创建时不可变保存 `executionKind=STANDARD|PREVIEW`；Grant/Hold 通过 `(artifactId,executionKind)` 复合关系匹配父行，数据库必须拒绝给 PREVIEW artifact 挂 STANDARD grant/hold。受信 preview -> production import/copy 必须创建新的 STANDARD artifact ID，不能只换 grant。
- RuntimeArtifact grant 可以绑定宿主生成的 logical effect scope。idempotent retry 若返回前一次 invocation 的 ArtifactRef，服务端只在 principal/caller/kind/target/effect scope 全匹配时为当前 invocation 原子追加 grant；不得退化为 team-wide 可读，Artifact retention 必须至少覆盖 effect replay window。
- 每个 Grant 使用 owner 规范化的 `subjectKey=hash(targetKind + targetId + scopeDigest + executionKind)`，数据库 unique `(artifactId,executionKind,subjectKey)`；同时保存 `expiresAt/revokedAt`。并发 create 使用 insert-or-read/upsert，只有仍 live 的同一 subject 可在 owner 上限内 CAS 延长，expired/revoked row 永不 reopen，新授权必须使用新的逻辑 subject/scope。
- 平台提供 host-only、带上限的 RuntimeArtifactHold；每个 hold 使用 `holderKey=hash(holderKind + holderId + purpose + scopeDigest + executionKind)`，数据库 unique `(artifactId,executionKind,holderKey)`。并发 acquire 只创建一条 active row或 CAS 延长 `retainUntil`；released row 不 reopen。hold 转换必须在同一事务先 upsert destination holds、再 CAS release source hold，cleanup 只统计 `releasedAt=null && retainUntil>dbNow()`。hold 不是读权限，实际消费者仍需基于冻结 mapping/call-chain/shared value revision 获得最小 invocation grant；插件 payload 不能创建/延长 hold。
- RuntimeArtifactGrant 目标至少支持 INVOCATION、LOGICAL_EFFECT、PRINCIPAL_IMPORT、WORKFLOW_RUN 和 SHARED_VALUE，并持久绑定 `executionKind=STANDARD|PREVIEW`。PRINCIPAL_IMPORT 由受信 upload/import service 创建并绑定 team + principal + import session，不是插件可自建的 grant。任何 grant 派生、hold 转换和 ArtifactRef 读取都必须保持相同 kind；PREVIEW 制品不能直接授权给 STANDARD/PRODUCTION，进入生产必须由受信 import/copy action 生成新的 STANDARD 制品。
- WORKFLOW_RUN grant 只能由 workflow service 在先验证 authenticated principal 对 source invocation/run/upload 的现有 live 具体权限和相同 execution kind 后创建；RUN_INPUT grant 最迟在 run 终态撤销，FINAL_OUTPUT grant 的 expiresAt 绑定结果 retention 并由 worker 写 revokedAt。run detail/download 与 `authorizeForRunInput` 都检查 grant 未撤销且 `expiresAt>dbNow()`，即使 artifact 被其他 run/shared hold 保留也不能复活旧 run 权限。SHARED_VALUE grant 只能由 shared-state service 在已授权 STANDARD 写入时创建，读取时再兑换为当前精确 invocation grant；value 更新、删除或 namespace 清理必须撤销对应 grant并释放 hold。两者都不允许任意插件读取，也不等同 team-wide grant。
- workflow-linked invocation 的成功事务必须在公开 `SUCCEEDED` 终态前，为输出 ArtifactRef 创建绑定 run/attempt 的短期 `HANDOFF_PENDING` hold；workflow coordinator 只能把它原子转换为冻结 edge/final hold 后再释放。崩溃恢复不得依赖制品仍处于普通 TTL 内。
- 本机路径、任意外部 URL、data URI 和裸 base64 不能作为已发布 action 的持久输入输出边界。
- 本地 handler 可以通过 action-scoped artifact API 临时物化或创建制品；临时路径不得出现在输出，调用结束后清理。

### R4. 精确调用身份与授权

- 每次调用绑定实际 principal/team、可信调用方、精确目标 `package_id + release_id + sha256 + action_id + action_contract_version + action_surface_sha256`、策略 revision、root/parent invocation 和调用链；surface digest 由 registry resolver 产出，不接受调用 payload 自报。
- principal、caller 和 team 由登录态、runtime session 或 workflow executor 派生；插件 payload 不得自报或替换。
- 调用前只通过一次 `GovernanceActionAdapter` 完成精确 release/listing、AI/safety、entitlement、USER/ROLE grant、团队策略和 action surface 授权；可信宿主按执行上下文一次提交完整 requiredOperations，invocation service 不得逐 operation 调用 evaluator、分别读取或再次判断这些事实。
- action 层拥有 action contract/canonical surface digest 的发布与解析，并在 invocation 中只保留依赖声明、input/output schema、ArtifactRef ACL/完整性和 call-chain/resource limit 校验；这些非授权校验不得演化成第二套治理 evaluator。
- 调用身份和授权沿调用链保持或收窄；目标插件再调用其他插件时不得切换用户、团队或扩大工作流允许范围。

### R5. 执行语义与可靠性

- invocation kind 仅为 `STANDARD | PREVIEW`。`PREVIEW` 必须复用与 STANDARD 相同的身份、governance adapter、状态机、幂等、账本与审计，只允许把 routing、quota 和 Artifact TTL 收窄到预览上限；不得放宽授权、改写 action contract 或产生第二套 preview 状态机。
- kind 由可信执行 scope 派生并沿 nested 调用继承：PREVIEW WorkflowRun 的所有节点/子工作流与单 action 试跑均为 PREVIEW，生产工作流和普通调用为 STANDARD；插件 payload 不能选择或把 PREVIEW 提升为 STANDARD。
- ActionInvocation 可以保存 adapter-specific execution binding；Cloud binding 至少冻结 environment、deployment ID 与 routing generation。binding 在 handler claim 前由可信 adapter resolver 产生并与 invocation 原子持久化，后续 retry/worker 不得重新选路。
- invocation request 幂等与 action effect 幂等是两个契约。宿主为每个 domain attempt 生成稳定 requestIdempotencyKey，并以绑定 team、principal、可信 caller、kind、精确 target 的 request scope digest + key 唯一去重 create/transport 重放；不同 domain retry 使用不同 request key。
- `idempotent` action 还必须收到宿主生成的 effectIdempotencyKey；同一逻辑 action effect 的所有 domain retries 共享该 key，不同 principal/caller/kind/target 的 effect scope 隔离。effect key 不作为 ActionInvocation 行唯一键，首个 FAILED 不得阻止下一 domain attempt；handler/endpoint 必须按该 key保证重复调用不重复副作用。`sdk.actions.call(..., { idempotencyKey })` 的插件值只作为当前 caller 内的 opaque logical-effect hint，宿主将它与 root logical call、principal/caller/kind/精确 target 绑定后派生最终 effect key；它绝不作为 request key或平台 scope。每个 request/domain attempt key 始终由可信宿主生成。
- action 必须声明 `read_only`、`idempotent` 或 `side_effect`。
- read-only 可以安全自动重试；idempotent 自动重试必须为新 request attempt 复用同一 effect key；side-effect 不得由基础设施自动重试。
- 每次调用具有授权、运行、成功、失败、取消和超时的明确终态；终态写入使用条件更新，迟到结果不能覆盖终态。
- 调用必须支持超时、best-effort 取消、稳定错误码、调用链循环/深度限制、并发和 payload/resource 配额。

### R6. Runtime Adapter

- client action 在不含 `allow-same-origin` 的 opaque-origin 沙箱中执行；消息必须同时满足 `event.origin === "null"`、`event.source === iframe.contentWindow`、匹配 runtime session/invocation ID 与尚未消费的一次性 nonce，导航后、错误 source/origin 和重复 response 均拒绝。
- Node.js/Python action 通过宿主提供的一次性 action host 调用指定 handler；协议输入输出与 stdout/stderr 日志分离，取消时终止进程树并撤销桥 token。
- client/Node.js/Python action 必须声明安全包内 handler；workflow action 由 workflow manifest entry/default action 与 definition digest 绑定，cloud runtime action 由已验证 deployment adapter 绑定，后二者不得为通过校验而声明虚假包内 handler。
- canonical action surface digest 必须包含对应 runtime 的真实执行身份：本地 handler entry/callable、workflow entry + definition digest，或 cloud deployment-adapter marker；cloud 的实际 deployment ID 另在 invocation/plan 创建时冻结。
- Cloud 和 workflow 使用相同 invocation envelope、schema、ArtifactRef 和策略门禁；本任务提供 adapter interface，Cloud endpoint 签名/部署和 workflow DAG 执行由对应子任务实现。
- 任一 runtime 不支持或 adapter 未注册时必须明确失败，不能回退到另一 runtime、latest release 或私有接口。

## Acceptance Criteria

- [ ] manifest 可声明多个 action；同一插件的不同 action 可被稳定发现和选择，单一 `default` action 无需额外选择 UI。
- [ ] 旧 manifest 不含 actions/dependencies 时继续发布、安装和本地运行，但不能被当作跨插件 action 目标。
- [ ] 非法 action ID、重复 ID、未提升的变更 contract、未知依赖、非法版本范围和不符合 runtime 分支的 execution binding 在发布前被拒绝；本地 handler 必须安全存在，workflow/cloud 不要求 dummy handler。
- [ ] 受限 JSON Schema 的 good/base/bad fixtures 在 contract、server 和所有实际 runtime adapter 上得到一致结果。
- [ ] 任意 `pattern`/正则关键字在发布前稳定拒绝；长字符串输入不会触发 runtime-specific RegExp 执行。
- [ ] 输入不合约时 handler 不启动；输出不合约时 invocation 失败且结果不进入下游。
- [ ] 图片 -> 视频 -> 配乐场景只传 ArtifactRef；路径、URL、data URI/base64 作为媒体边界时被拒绝或要求先导入平台制品。
- [ ] ArtifactRef 元数据或签名被篡改、制品被删除、跨团队引用或无权 principal 读取时均被拒绝并审计。
- [ ] RuntimeArtifact.executionKind 创建后不可修改；数据库复合约束拒绝 PREVIEW artifact 的 STANDARD grant/hold，受信 copy 生成新 STANDARD artifact ID、独立 SHA/审计和授权链。
- [ ] idempotent 首次 effect 已生成 ArtifactRef 但响应丢失后，新 request invocation 以同可信 effect scope 可复用旧引用；不同 principal/caller/kind/target 或过期 replay window 均拒绝，且无 team-wide grant。
- [ ] 有界 RuntimeArtifactHold 能跨 queue delay 保留 run 输入/中间产物，过期/释放后 cleanup 生效；hold 本身不能读取制品，插件伪造 holder/retainUntil 被拒绝。
- [ ] 并发 grant/hold acquire、HANDOFF_PENDING 转换和 shared reconciler 对同一 canonical subject/holder 最多产生一行；active row 只单调延长到 owner cap，released/revoked row 不 reopen，重复 worker 不会留下永久 cleanup blocker。
- [ ] workflow-linked invocation 在 `SUCCEEDED` 可见前已事务性建立 `HANDOFF_PENDING` hold；服务在终态提交后、step 映射前崩溃并超过普通 TTL，恢复仍能把该 hold 幂等转换为 EDGE/FINAL hold。
- [ ] workflow/nested consumer 只有在 frozen mapping/call-chain 明确引用 source artifact 时获得当前 invocation grant；不同 edge/node/target 无法复用，任何路径都不产生 team-wide grant。
- [ ] direct workflow input 在调用者无 source grant 时不能仅凭同 team ArtifactRef 建 hold；合法来源可原子转为 WORKFLOW_RUN grant+hold，final output 只经授权 run result endpoint读取/传给新 run。
- [ ] WORKFLOW_RUN RUN_INPUT/FINAL_OUTPUT grant 分别在 run 终态/结果 retention 到期撤销；即使同 artifact 因其他 run或 SHARED_VALUE hold 仍存在，旧 run 下载和 authorizeForRunInput 都拒绝。
- [ ] RuntimeArtifact grant/hold 全程绑定 STANDARD/PREVIEW；PREVIEW output 不能直接成为 PRODUCTION run input 或 SHARED_VALUE，显式 import/copy 后得到的新 STANDARD artifact 可以使用。
- [ ] shared-state service 只有在 STANDARD 写入已验证 source grant 后创建 SHARED_VALUE grant/hold，读取时只为当前 invocation兑换权限；update/delete/namespace clear 后旧 value revision 无法继续授权且 hold 可清理。
- [ ] 每次调用和错误可追溯到 principal/team、caller、精确 target、策略 revision、root/parent invocation 和调用链。
- [ ] package/release/sha/action/action contract/surface digest 任一不匹配、release 撤回/封禁、权益或团队策略不满足时，handler 不启动且不会改用 latest。
- [ ] Owner/Admin 调用也经过相同门禁；目标插件及其嵌套调用无法扩大 principal 权限或 workflow scope。
- [ ] 同 request scope/key + input 的创建重放返回同一 invocation，不同 input 返回冲突；下一 domain retry 使用新 request key 可创建新 invocation。idempotent retries 共享 effect key，side-effect 不自动重试。
- [ ] `sdk.actions.call` 的公开 `idempotencyKey` 只影响宿主派生的 logical effect identity；它不能成为、覆盖或预测 request key，也不能跨 principal/caller/kind/target 复用 effect。省略 hint 时不承诺 nested idempotent domain retry。
- [ ] 超时、取消、重复完成和迟到结果通过条件状态转换保持单一终态；本地 worker 和 token 得到清理。
- [ ] Web/Cloud 单 action 试跑写 `ActionInvocation(kind=PREVIEW)` 并经过同一状态机、governance、schema、ArtifactRef、幂等和审计；PREVIEW 只有更窄配额/TTL/routing，且不存在伪造 WorkflowRun 或独立 preview run 表。
- [ ] PREVIEW WorkflowRun 的所有节点和 nested invocation 都写 PREVIEW 并只用 PREVIEW deployment/artifact/quota；PRODUCTION run 写 STANDARD，payload 伪造 kind 被拒绝。
- [ ] standalone Cloud invocation 在创建时冻结 deployment/routing generation；同 invocation 的 claim/retry、routing 更新或 candidate 调整均不改变 binding，usage/audit 可追溯该 deployment。
- [ ] 相同 request key 在 STANDARD 与 PREVIEW 下可分别创建且结果不互用；同 request scope/key 的相同输入幂等复用，不同输入返回 conflict。
- [ ] 同团队不同 principal 或 trusted caller 使用相同 request/effect key 时不会读取、阻塞或复用彼此 invocation/effect；伪造 scope 被拒绝。
- [ ] invocation 在 AUTHORIZED 尚未启动时可以直接取消或超时；RUNNING claim 与 cancel/timeout CAS 只有一个成功，取消/超时先提交时 handler 永不启动。
- [ ] 自调用循环、重复 action 环和超出最大深度/并发/payload 配额的调用在执行前被拒绝。
- [ ] client、Node.js、Python adapter 均通过同一 conformance suite；未接线 Cloud/workflow adapter 返回稳定 `action_runtime_unavailable`。
- [ ] client action bridge 仅接受 origin=null + contentWindow source + session/invocation ID + 单次 nonce 全匹配；真实部署 origin、导航后的旧 frame、nonce/response 重放和错误 source 全部失败。
- [ ] action 调用统一经过团队策略 evaluator；没有直接调用 handler、localhost 私有路由或 Cloud endpoint 的授权旁路。
- [ ] 每个 invocation create 只调用一次 governance action adapter；测试证明 action runtime 不直接查询 release/listing 授权、entitlement、PluginGrant 或 TeamPluginPolicy，且 adapter 只调用一次 core evaluator。
- [ ] requiredOperations 以 invoke_action 为基线，workflow target、Cloud execution、Web preview 分别叠加 run_workflow、execute_cloud、web_preview；所有组合单次授权，缺少任一允许项整体拒绝且没有第二次 evaluator 调用。
- [ ] 现有 v4 发布、安装、更新、回滚和普通插件运行，以及现有 SDK capability API 回归通过。

## Out of Scope

- workflow DAG、字段 mapping UI、循环/条件/审批节点、workflow run/step 状态和升级建议 UI。
- 独立 preview 执行器、preview 状态机或用伪造 WorkflowRun 表示单 action 试跑。
- Cloud endpoint 注册、密钥托管、HTTPS 签名、队列、worker、scheduler 和任意上传代码托管；由 Cloud 子任务交付。
- presence、共享 KV、市场推荐、结算和 Web 插件中心。
- 通用媒体转码或运行时 AI 自动适配；类型不兼容需显式转换 action。
- 为现有不受控本地 Node/Python 执行补 OS 级硬沙箱。
- 让草稿、legacy `Plugin` 行或未发布的本机目录成为正式跨插件目标。

## Dependencies

- 父任务：`.trellis/tasks/07-15-plugin-platform-phase-two` 的 R2、跨域精确身份和 ArtifactRef 约束。
- 联合前置顺序：`.trellis/tasks/07-15-team-plugin-policy-governance` 先提供通用 core evaluator；本任务提供 action contract/resolver/canonical surface digest；治理任务再提供 `GovernanceActionAdapter`；本任务最后接入 invocation runtime。action runtime 不自建授权顺序，core evaluator 不依赖 action runtime。
- 复用：v4 registry、ArtifactStore 适配模式、runtime-access、PluginGrant、AuditLog、本机安装账本、iframe bridge、Node/Python runner 和 localhost token 会话。
- `07-13-plugin-dev-sdk` 已限定为 SDK 工具链且不改 runtime/contract；本任务不得改写其规划，SDK action 扩展需在其变更稳定后增量实施。
- 下游：workflow 绑定精确 action target 并复用 gateway；Cloud 子任务实现 cloud adapter；Cloud/Web 单 action 预览必须创建本任务拥有的 `ActionInvocation(kind=PREVIEW)`，共享数据和 Web 预览消费 ArtifactRef 与调用审计。
