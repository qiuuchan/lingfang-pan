# 工作流插件平台

## Goal

交付可创建、预览、发布、安装、运行和升级的工作流插件。工作流以受限 DAG 组合多个插件的具名 action 或子工作流，并在发布与运行时保持严格的数据契约、精确版本和完整审计。

## User Value

- 开发者或 AI 创建器可以把图片生成、视频生成、配乐等现有插件能力组合成一个可复用产品，而不必重复实现这些能力。
- 普通用户安装工作流后，只需填写工作流输入、选择允许的运行方式并查看结果，不需要理解插件间调用细节。
- 团队管理员能够确认工作流会调用哪些精确发行版、action 和数据范围，并通过统一策略控制其运行。
- 插件作者发布兼容更新后，工作流作者能得到可审核的升级建议；既有工作流和历史运行不会被静默改变。

## Confirmed Baseline

- 现有 v4 `.lfplugin` 已具备不可变 package/release、精确 SHA、市场审核、权益、团队授权和桌面安装/回滚能力。
- 现有运行类型没有 workflow，manifest 也没有 action、依赖或 action 输入输出契约。
- 跨插件 action、受限 JSON Schema、`ArtifactRef` 和统一 invocation gateway 由前置子任务 `07-15-cross-plugin-action-runtime` 交付，本任务不建立第二套调用协议。
- 团队策略解析由前置子任务 `07-15-team-plugin-policy-governance` 交付；工作流节点只能收窄权限，不能扩大调用者权限。
- Cloud 执行和定时任务由后续子任务 `07-15-cloud-plugin-automation` 接入同一工作流运行账本；本任务先完成与执行位置无关的定义、计划和桌面手动运行闭环。

## Requirements

### R1. 正式工作流制品

- 工作流是 v4 插件发行版的一种新增运行类型，沿用现有 package、release、listing、entitlement、安装、更新和回滚生命周期。
- 一个工作流发行版包含声明式 `workflow.json`，并向其他插件或工作流导出一个与整体输入输出契约一致的 `default` action。
- 已发布工作流版本不可修改；草稿节点声明的原始 SemVer range 在发布前必须解析为精确的 `package_id + release_id + sha256 + action_id + action_contract_version + action_surface_sha256`。`WorkflowReleaseNode` 同时保留规范化的 declared range 作为升级建议溯源，但执行只读取精确 target，永不按该范围重新解析。
- 工作流更新必须发布新的插件发行版，不得覆盖旧版本或在运行时解析 `latest`。
- 现有 client、cloud、nodejs 和 python v4 插件不需要迁移即可继续安装和运行。

### R2. 受限 DAG 与显式数据映射

- 首版只支持有向无环图、依赖顺序执行和无依赖节点并行执行。
- 每个节点只调用一个具名 action 或一个工作流的 `default` action，并声明稳定节点 ID、显式依赖、输入绑定和 0-2 次重试上限。
- 节点输入只能显式来自工作流输入、前置节点输出或定义中的 JSON 字面量；字段路径采用受限 JSON Pointer，不支持表达式求值或运行时 AI 推断。
- 工作流输出同样通过显式映射生成；同一目标字段不得被多个映射覆盖，也不得通过隐藏数据引用制造未声明依赖。
- 发布前验证整体输入输出、节点输入输出、映射路径和 `ArtifactRef` 类型。类型不兼容时必须加入显式转换 action，平台不得静默转换。
- workflow definition 的 literal 只允许普通 JSON，递归拒绝 contract 保留且可结构判定的 runtime identity tagged objects，例如 `type=artifact_ref|platform_credential_ref|runtime_artifact_grant|runtime_artifact_hold`；普通 string（包括 URL 形状）只按目标 schema 校验，不做凭证启发式识别。平台签名 URL/短期 credential 永不由 definition API 返回或写入，固定发布资产必须通过专用 release-asset/import action 产生运行时引用。
- 首版限制单个定义最多 64 个节点、256 条依赖边和 8 个并行节点；子工作流最大嵌套深度为 4，展开后最多 128 个节点。限制作为共享契约常量维护，并可被平台策略进一步收窄。

### R3. 创建、预览与配置体验

- 开发者可以在插件工作区创建 workflow 草稿；AI 创建器能够生成或修改 `workflow.json`、解释字段映射并根据校验错误修正定义。
- 创建器提供只读 DAG 预览、节点详情、精确依赖、映射和发布诊断；首版不向普通用户提供自由拖拽的无代码编辑器。
- 普通用户安装工作流后，根据整体输入 schema 填写参数、查看节点与运行方式兼容性，并手动启动运行。
- 包含本地 action 的工作流必须列出所需安装项和不兼容节点；缺少精确发行版时不得开始运行，并提供下载或更新路径。
- 本地运行必须绑定一个短期 `DesktopExecutorSession` 及其规范化 device inventory hash；session 过期、撤销或安装清单变化后不得继续领取新节点，必须重新预检并创建或刷新 session。
- 工作流详情和运行界面必须能区分本地手动可运行、全部节点可 Cloud 运行以及当前策略禁止三种状态。

### R4. 执行、失败与取消

- 每次启动先对精确 root workflow release + plan digest 做一次 compound governance decision：requiredOperations 以 `run_workflow` 为基线，Cloud target 增加 `execute_cloud`，PREVIEW 增加 `web_preview`；再校验调用者、团队、权益、发行状态、精确 SHA 和 action 契约并冻结完整执行计划。root deny 时不创建 run。
- 桌面手动运行通过统一 invocation gateway 调用每个 action；工作流不得调用插件私有入口或绕过 action 授权与审计。
- 每个 WorkflowStepAttempt 必须关联 action owner 的 ActionInvocation；kind 从 WorkflowRun.executionScope 派生，PREVIEW run 的全部节点/子工作流保持 PREVIEW。executor 只通过 ActionInvocationService/gateway 启动 adapter，不直接调用本地或 Cloud handler。
- nested child run 只能由父 attempt 内部创建并引用 root frozen plan 的不可变子计划；继承 executionTarget、executionScope、principal、DesktopExecutorSession/inventory 或 Cloud deployment bindings，不接受客户端覆盖，也不重新解析 range、选路或重复评估同一 action decision。
- root run 创建时先验证发起人对 source invocation/prior run/upload 的 live 具体 grant及其 STANDARD/PREVIEW kind 与目标 executionScope 一致，再对合法 workflow input ArtifactRef 原子建立 WORKFLOW_RUN grant + 有界 hold；同 team 本身不足以授权，PREVIEW output 不能直接进入 PRODUCTION。workflow-linked invocation 在公开成功终态前先事务性 acquire canonical `HANDOFF_PENDING` hold；coordinator 在同一事务 upsert 仍被未完成下游/final output mapping 引用的 canonical holds 后 CAS release pending。创建消费者 invocation 时依据 frozen edge + source attempt 原子授予同 kind invocation；RUN_INPUT grant 在终态撤销，final output grant 的 expiresAt 绑定结果 retention并到期撤销，即使 artifact 被其他 holder 保留也不能继续读取/转授权。
- root run 请求幂等必须绑定 team、principal、可信 caller、trigger kind、精确 workflow release、execution target 和 execution scope 的宿主生成 scope digest。数据库按 `(requestScopeSha256,idempotencyKey)` 唯一；同时保存 canonical input/request digest，同 scope/key 同请求返回原 run，不同 input、ArtifactRef grant scope 或选择参数返回 `workflow_run_conflict`。schedule fire 使用独立的 schedule/generation/occurrence 唯一键，不复用客户端 key。
- 只有 `read_only` action，或携带平台稳定 effect idempotency key 的 `idempotent` action，可以自动重试；最多重试两次。每个 domain attempt 使用不同 request idempotency key 去重 transport 重放，`side_effect` action 不自动重试。
- 任一节点最终失败后，工作流先进入 `FAILING` 关闭态，停止调度新节点，将尚未开始的节点标记为跳过，并尽力取消仍在运行的并行节点；只有全部在途 attempt 成功、失败、取消或按租约规则明确收口后才进入 `FAILED`。首版不执行自动补偿或回滚已完成副作用。
- 用户可以请求取消运行。取消后不再启动新节点，进行中的调用按 action 取消协议尽力终止，最终状态和未能取消的副作用必须可见。
- 桌面执行器 session 过期、撤销、inventory hash 改变、断开或租约过期时不得再领取节点，也不得盲目重放未知结果的副作用 action；运行按关闭规则以明确错误结束并保留诊断。

### R5. 运行记录与子工作流

- 每次工作流运行具有稳定 run ID、发起人、团队、触发来源、执行位置、冻结计划、输入、输出、开始/结束时间和终态。
- 每个节点的每次尝试记录精确 action 引用、状态、request key、可选 effect key、耗时、结构化错误和输出引用；敏感输入和二进制正文不得写入普通日志。
- 工作流的 `default` action 可以作为另一个工作流节点。启动前必须递归预检完整依赖闭包，拒绝直接或间接递归，并保持父子运行链路可追踪。
- 同一运行的状态转换必须幂等；重复完成回报、过期租约和乱序回报不得覆盖已确定的终态。
- 用户只能查看当前团队内自己有权访问的工作流和运行；跨团队读取必须拒绝并审计。

### R6. 升级、治理与兼容

- 兼容 action 新版本只生成升级建议和兼容性报告；通过校验后仍需创建并发布新的工作流版本。
- 已撤回、封禁、未通过当前平台门禁或不再满足团队策略的节点发行版阻止新运行，但不改写历史定义或历史运行记录。
- Owner/Admin 运行工作流时与普通成员一样接受平台门禁、权益和团队策略检查，没有隐式绕过。
- 工作流新增 action、Cloud 能力、共享数据范围或其他高风险能力时必须重新进入团队策略评估，不继承旧版本未声明的授权。
- 工作流发布、启动、节点开始/完成/失败、取消、升级建议采纳和访问拒绝均产生可关联审计记录。

## Acceptance Criteria

- [ ] `runtime_type=workflow` 的 v4 制品可以创建、校验、发布、进入团队库或市场、安装、更新和回滚；旧四类运行时回归通过。
- [ ] 工作流制品缺少或包含非法 `workflow.json`、重复节点 ID、未知依赖、循环、超出节点/边/嵌套/并行限制时被拒绝，并返回可定位到字段或节点的错误。
- [ ] 草稿 action 版本范围在发布前解析为包含 `actionSurfaceSha256` 的精确六元引用；`WorkflowReleaseNode.declaredVersionRange` 保留规范化原始范围用于升级建议，但已发布定义的可执行 target 和每次冻结计划中不存在 `latest`、以范围代替精确 target 或裸 URL。
- [ ] A 图片 action 的 `ArtifactRef` 可通过显式 mapping 传给 B 视频 action，C 配乐 action 可与无依赖节点并行；最终输出按声明映射生成。
- [ ] 映射源路径不存在、目标路径冲突、源节点不是显式前置依赖、schema 不兼容或把大文件当内联 JSON 传递时，发布校验失败并指出具体 mapping。
- [ ] definition literal 中任意层级的保留 runtime identity tagged object 被确定性拒绝；普通 JSON literal 与符合 schema 的 URL-shaped string 仍可用，平台 credential 不进入 definition API，固定媒体通过显式 import/release-asset action 后再进入节点输出。
- [ ] 运行时不执行 AI 推断或隐式数据转换；加入显式转换 action 后，同一不兼容场景可以通过验证。
- [ ] 只有依赖满足的节点进入可运行状态；无依赖节点最多按允许并行度并行，fan-out 和 fan-in 均按 DAG 语义完成。
- [ ] `read_only` 与具备平台 effect key 的 `idempotent` 节点最多自动重试两次；每个 attempt 的 request key 不同且同 attempt 重投复用，idempotent retries 共享 effect key，首个 FAILED 不阻止下一 attempt；`side_effect` 节点失败后调用次数始终为一次。
- [ ] 节点重试耗尽后运行先进入 `FAILING`，未启动节点为跳过，运行中的并行节点收到取消请求；在全部 attempt 收口前不得进入 `FAILED`，已完成节点结果和副作用保持可审计。
- [ ] 用户取消、桌面断连、重复状态回报、过期租约和进程重启测试不会产生重复终态、悬挂 attempt 或重复副作用调用。
- [ ] 同一个 root request scope/idempotency key 与同一 canonical request 返回原 run；同 key 不同 input、ArtifactRef 来源、workflow release、execution target/scope 或 principal 不会错误复用，冲突返回稳定错误且不创建第二个 run。
- [ ] 工作流启动时重新检查每个节点的精确 release、SHA、action 契约、权益和策略；撤回或封禁任一节点后，新运行被拒绝且不会自动换版。
- [ ] root DESKTOP/CLOUD/PREVIEW workflow 分别请求正确 compound operations 并只得到一个 root decision；run_workflow deny 无法由叶子 invoke_action allow 绕过，nested child 不重复根授权。
- [ ] 已开始运行继续使用冻结计划；节点插件发布新版本不会改变运行中或历史运行的引用。
- [ ] 工作流导出的 `default` action 可被另一工作流调用；直接递归、间接递归、深度超限和展开节点超限均被拒绝并返回完整依赖路径。
- [ ] 创建器能生成 workflow 草稿、显示只读 DAG 和逐节点诊断；普通用户界面没有自由拖拽连线入口。
- [ ] 普通用户可以按整体 input schema 配置并手动运行；缺少本地精确发行版时运行前被阻止并列出需要安装或更新的节点。
- [ ] 每个 DESKTOP run 都绑定未过期的 `DesktopExecutorSession` 与 device inventory hash；session 过期/撤销、inventory 变化或页面伪造设备清单时，新 attempt claim 被拒绝并要求重新预检。
- [ ] 每个 step attempt 都唯一关联 ActionInvocation；PREVIEW/PRODUCTION scope 分别产生 PREVIEW/STANDARD kind，executor 零直接 adapter/endpoint 调用。
- [ ] run input/中间 ArtifactRef 在 queue/桌面断连超过普通 TTL 后仍因有界 RUN hold 可用；producer 在 invocation 成功提交与 step 映射之间崩溃时由 `HANDOFF_PENDING` 保留输出；A->B/final/nested 只按 frozen mapping 给同 execution kind 的精确 consumer invocation grant，其他节点/团队/kind 被拒绝。并发 coordinator/reconciler 只产生 canonical 单行 holds；终态后 hold 释放、run grants 按各自 retention 撤销并可清理。
- [ ] direct POST workflow input 仅在当前 principal 有 live source invocation/prior run/upload grant 时建立 run grant；同 team 无 grant 被拒绝。final output 只在 run result retention 内经 team+initiator/admin 与 live grant 双重授权读取/作为新 run 输入；到期后即使 artifact 因其他 run/shared hold 存在也拒绝。
- [ ] nested DESKTOP/Cloud workflow 继承 root 子计划与 executor binding；客户端伪造 child target/session 被拒绝，routing/release 更新不改变 child，且同一 nested action decision 不重复调用 evaluator。
- [ ] 运行列表和详情可显示根运行、子工作流、节点尝试、结构化错误、ArtifactRef 结果和取消状态，同时不暴露密钥、Bearer token、本机路径或二进制正文。
- [ ] 兼容 action 更新生成可审核升级建议；采纳建议只创建新草稿，通过全量校验并发布新工作流版本后才影响新运行。
- [ ] 跨团队运行或读取、无 entitlement、策略 deny、Owner/Admin 试图绕过门禁均被拒绝并产生审计。
- [ ] 工作流任务与 Cloud 子任务共享同一 run/step 状态机；Cloud 接入不需要迁移或复制既有运行记录。
- [ ] 端到端测试覆盖图片生成 -> 视频生成与配乐并行 -> 聚合输出，并能从最终结果追溯到全部精确 release 和 action contract version。

## Dependencies

- 前置：`07-15-cross-plugin-action-runtime` 提供 action descriptor、受限 JSON Schema、精确 target、`ArtifactRef`、执行语义和 invocation gateway。
- 前置：`07-15-team-plugin-policy-governance` 提供工作流/action 默认拒绝、策略解释和运行时决策接口。
- 后续：`07-15-cloud-plugin-automation` 复用冻结计划、运行账本和 executor port，交付离线 Cloud 与定时执行。
- 集成：`07-15-plugin-shared-collaboration-state` 提供工作流节点获授权后的团队共享 KV，不由本任务实现存储。

## Constraints

- 本任务处于规划阶段，用户统一评审前不得启动实现。
- 工作流必须复用 v4 registry 和跨插件 invocation gateway，不创建独立市场、权益、授权或 Artifact 格式。
- 本地工作流是新增高风险能力，首版运行需要连接平台完成实时门禁；不承诺离线绕过策略运行。
- 工作流定义和运行记录中的 JSON 受共享 action 契约大小限制，大文件只使用 `ArtifactRef`。

## Out of Scope

- 循环、条件分支、switch、动态 fan-out、人工审批、暂停等待、补偿事务和通用 saga。
- 面向普通用户的自由拖拽无代码工作流编辑器。
- 运行时 AI 自动补字段、猜测映射、选择插件或静默转换数据。
- 自动升级已发布工作流、自动回退到其他插件版本或修改历史运行计划。
- 在本任务内建设 Cloud worker、定时触发、Webhook、业务事件触发、自定义 cron 或团队共享 KV。

## Planning Status

- 产品和技术边界已按父任务推荐方案收敛，无阻塞性开放问题。
- 规划完成后与其余子任务统一提交用户评审；评审前不调用 `task.py start`。
