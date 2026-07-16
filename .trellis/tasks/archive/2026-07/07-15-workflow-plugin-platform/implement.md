# 工作流插件平台实施计划

按顺序执行。每个 review gate 通过后再进入下一阶段；保持现有 v4 插件路径持续可编译、可测试、可运行。

## Step 0 - Dependency And Contract Gate

- [ ] 与 `07-15-cross-plugin-action-runtime` 冻结 action descriptor、含 `actionSurfaceSha256` 的精确 target、受限 JSON Schema、`ArtifactRef`、执行语义、invocation envelope/gateway 和稳定错误码。
- [ ] 与 `07-15-team-plugin-policy-governance` 冻结 workflow/action preflight 与 decision ID 接口；确认新增能力默认拒绝。
- [ ] 与 Cloud 子任务确认唯一 `WorkflowRun` / `WorkflowStepAttempt` 状态机和 `WorkflowExecutorPort`，禁止各自建表表达同一运行。
- [ ] 将 contract、collab-api、desktop、lingfang-desktop、plugin-sdk 相关 spec 与本任务设计加入 implement/check context manifests。

### Review Gate 0

- action target 字段和 owner 无重复定义。
- 本地与 Cloud 两种 executor 能消费同一个冻结计划。
- 无阻塞契约问题后才修改 `RuntimeType`。

## Step 1 - Shared Contract And Pure Workflow Engine

- [ ] 在 `packages/contract` 增加 workflow runtime、definition/draft selector、含 action surface digest 的精确 target、declared version range、mapping、plan、`DesktopExecutorSession`、含 `FAILING` 的 run/attempt 状态、DTO、错误码和限制常量；所有边界字段使用 snake_case。
- [ ] 更新 plugin-sdk manifest validator、后端 runtime allowlist、桌面类型和 Rust v4 artifact/runtime allowlist；旧四类 manifest fixtures 保持不变。
- [ ] 新建 `packages/workflow-engine`，接入 `@dagrejs/graphlib`，实现 parse -> graph -> cycle/limit -> topology -> ready set 的纯函数。
- [ ] 复用 action schema validator，实现 pointer 解析、source/target schema 定位、冲突检测、input/output materialization；禁止 JSONPath/脚本表达式。
- [ ] definition literal 递归拒绝 contract 保留且结构可判定的 runtime identity tagged objects；普通 URL/path-shaped string 只按 schema 判断，credential issuer 不向 definition API 暴露短期值。mapping engine 输出 frozen artifact transfer descriptors，只允许同 execution kind 的 root input/source attempt -> exact consumer invocation。
- [ ] 实现纯 run reducer 与 expected-state transition table，覆盖 request/effect key 分离、retry、`RUNNING -> FAILING -> FAILED` 关闭流程、skip、cancel 和终态幂等；`FAILED` 前必须确认全部并行 attempt 已收口。
- [ ] 添加嵌套闭包/递归检测与稳定 definition/plan hash helper。

### Validation 1

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C packages/workflow-engine typecheck
pnpm -C packages/workflow-engine test
pnpm -C packages/plugin-sdk typecheck
```

### Review Gate 1

- contract 是唯一 payload owner，server/desktop 没有私有重复类型或本地 cast。
- graph 与 mapping fuzz/property tests 覆盖重复 ID、unknown edge、cycle、fan-in/out、pointer escaping、重叠写入和上限边界。
- side-effect retry 在 reducer 层不可表达；`FAILING` 不再产生 ready node，迟到 attempt 回报只能推动 closing 收口。

## Step 2 - Additive Schema And Registry Publishing

- [ ] 为 `WorkflowRelease`、含 `declaredVersionRange/actionSurfaceSha256` 的 `WorkflowReleaseNode`、`DesktopExecutorSession`、含 host-derived requestScopeSha256/inputDigest/requestDigest/resultRetainUntil 的 `WorkflowRun`、含 request/effect key 与 root logical path 的 `WorkflowStepAttempt` 增加 Prisma 模型、唯一键、关系和高频查询索引；root unique 为 `(requestScopeSha256,idempotencyKey)`，更新 PostgreSQL/MySQL schema renderer 回归。
- [ ] 扩展 v4 artifact parser：runtime=workflow 时必须完整读取并校验精确 entry，比较 manifest default action 与 workflow overall schema。
- [ ] 将合法空对象 default action schema 纳入 Creator/template/contract golden fixture，拒绝裸 `{}` 或缺少 `additionalProperties:false` 的无界 schema。
- [ ] 实现 resolve-targets 与 validate 服务；范围解析只返回当前 principal 可见、可授权的 action release，并把规范化 declared range 与精确 target 分别标记为升级溯源和执行身份。
- [ ] 在 registry release 创建事务中写不可变 workflow snapshot 与节点投影；断言 `declaredVersionRange` 可重放且执行 target 为精确六元组（含 actionSurfaceSha256），失败时沿用 artifact orphan cleanup。
- [ ] 实现递归依赖闭包、cloud eligibility 派生、release 撤回影响查询和升级建议查询。
- [ ] 为旧客户端 catalog 增加 workflow compatibility 投影，不把 workflow 当 client/cloud 入口。

### Validation 2

```bash
pnpm -C apps/collab-api prisma:generate
pnpm -C apps/collab-api prisma:validate
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test -- --testTimeout=60000 plugin-workflow
pnpm -C apps/collab-api build
```

### Review Gate 2

- migration additive，旧 package/release/listing/entitlement 查询计划无回归。
- ZIP/CRC/大小/path 既有安全门禁仍覆盖 workflow entry。
- snapshot 与节点投影同事务一致，declared range 与精确 target 均不丢失，任何发布失败均无可运行半成品。

## Step 3 - Run Service, Ledger And Desktop Lease API

- [ ] 实现 `DesktopExecutorSession` create/refresh/heartbeat/revoke：由 Tauri 提交无路径的规范化安装清单，服务端生成 inventory hash，token 只存 hash并绑定 principal/team/device且短期有效。
- [ ] 实现 create-run 幂等事务：从 team/principal/trusted caller/trigger/exact workflow release/target/scope 派生 request scope，比较包含 canonical input、ArtifactRef source grant identity 和选择参数的 request digest；同 scope/key/digest 返回原 run，差异 `workflow_run_conflict` 且零写。随后执行输入校验、递归 preflight、精确 root workflow compound decision 与叶子策略/权益/发行状态检查；DESKTOP run 另校验并冻结 executor session ID 与 inventory hash，CLOUD plan 冻结 deployment bindings，再完成含 root decision/nested plan slices 的 plan freeze、run/first attempts 创建和审计。schedule/nested child 使用各自可信 identity，不接受客户端 key。
- [ ] 实现 run list/detail/cancel 的 team/permission isolation 与稳定错误响应。
- [ ] 实现 attempt claim/start/heartbeat/complete/fail CAS API；DESKTOP claim 同时校验 executor session/token/inventory hash，attempt token 只存 hash并绑定 principal/run/attempt。
- [ ] 接入纯 reducer：ready-node 并行调度、fan-in、retry、`FAILING` closing、skip、cancel 和 nested child run；每个 attempt 用独立 request key 通过 ActionInvocationService 创建/claim，idempotent retries/nested path 复用 effect key，kind 继承 run scope，最终节点失败后先关闭全部 invocation/attempt，再写 `FAILED`。
- [ ] complete 路径重新验证 output schema、ArtifactRef scope 和 mapping；超限输出拒绝提交。
- [ ] run create 验证 live source invocation/prior run/upload grant及 artifact parent STANDARD/PREVIEW 一致性后原子建 WORKFLOW_RUN RUN_INPUT grant+hold；action terminal transaction acquire canonical `HANDOFF_PENDING`，step complete 在同一事务按 unresolved edges/final output upsert canonical destination holds后 CAS release pending，consumer invocation create 原子附加同 kind 最小 grant，final output授予带 resultRetainUntil 的 root grant。终态 revoke input grants/release transient holds，结果到期 revoke final grants/release final holds；reconciler 使用 canonical subject/holder key 幂等收口且不 reopen。覆盖同 team 无 source grant、PREVIEW -> PRODUCTION composite-FK deny/copy-new-ID、queue delay超 TTL、terminal-to-step crash/concurrent reconcile、A->B/nested/final transfer、run result ACL/expiry、其他 holder 保留对象和 cleanup。
- [ ] 添加租约过期 reconciler；结果未知的 side-effect 明确失败，不重放。
- [ ] 审计 publish/run/step/cancel/deny/upgrade，结构化日志只记录 ID 与摘要。

### Validation 3

```bash
pnpm -C apps/collab-api test -- --testTimeout=60000 workflow-engine workflow-run workflow-security
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api build
```

### Review Gate 3

- 并发 claim、重复 complete、失败/取消/完成竞态、租约超时均以 CAS 保持单一终态；run 不得在并行 attempt 收口前离开 `FAILING`。
- 过期/撤销 executor session 或变化的 inventory hash 拒绝新 claim，且页面无法伪造安装清单绕过 Tauri 预检。
- 每个节点调用都经过统一 invocation gateway 和最新策略决策。
- root DESKTOP/CLOUD/PREVIEW requiredOperations 组合正确且只有一个 root decision；run_workflow deny 时零 run/attempt，nested child 消费父 decision 而不重复 evaluator。
- root idempotency scope 隔离 principal/caller/release/target/scope；同 key 不同 canonical request 只返回 workflow_run_conflict，schedule occurrence 与客户端 key 不混用。
- concurrent coordinator/reconciler 只产生一条 canonical active hold；run result retention 到期后旧 WORKFLOW_RUN grant 不可下载/转授权，即使 artifact 仍被其他 holder 保留。
- run detail 不返回 secret、Bearer token、本机路径或二进制正文。

## Step 4 - Desktop Creation, Preview And Manual Executor

- [ ] Draft workspace 增加 workflow 模板与 runtime；Creator tools/prompt 支持生成、读取、校验和修复 `workflow.json`。
- [ ] Artifact Inspector 接入只读 `@xyflow/react` + dagre 自动布局，固定节点尺寸，禁用拖拽/连线，提供节点与 mapping diagnostics。
- [ ] 扩展 plugin registry/runner 路由，安装项 runtime=workflow 时进入 `WorkflowRunner`，不进入 iframe 或脚本 runner。
- [ ] 根据受限 input schema 渲染配置控件，并展示精确依赖、缺失安装项、本地/Cloud eligibility 和策略拒绝。
- [ ] 实现 desktop executor：通过 Tauri 枚举安装清单并创建/刷新 `DesktopExecutorSession`，按冻结 inventory hash 领取 run lease，再按 ready set 和并行度调用 action gateway/local Tauri adapter，发送 heartbeat 与 attempt 结果。
- [ ] 所有 workflow 运行入口统一走 `createWorkflowRun`；pinned/recent/standalone 不得直接构造 plan。
- [ ] 实现运行 DAG 状态、attempt 详情、ArtifactRef 结果、取消与断连恢复显示。
- [ ] Rust local adapter 严格按 installation/release/SHA 解析；错误通过 `errorMessage()` 在前端保留真实原因。

### Validation 4

```bash
cargo fmt --all -- --check
cargo test -p lingfang-desktop
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C apps/desktop exec playwright test e2e/workflow-plugin.spec.ts --project=chromium
```

### Review Gate 4

- 普通用户无自由拖拽编辑入口，开发者仍可通过 Creator/files 修改定义。
- 390x844、1024x768、1440x900 下图、输入、进度和错误无重叠/溢出；亮暗主题均使用语义 token。
- local action 不可通过 iframe message 替换 plan 中的 plugin/release/action identity、executor session 或 device inventory hash。

## Step 5 - Upgrade And Nested Workflow Integration

- [ ] 新 action release 只按持久化 `declaredVersionRange` 触发/查询兼容升级建议，包含逐节点差异与失败原因；不从当前精确 target 反推范围，也不自动修改任何 release 或 schedule。
- [ ] 实现采纳建议 -> 新草稿 -> 全量验证 -> 新版本发布流程。
- [ ] 实现 workflow default action 的 child run 调用、递归预检、父子取消传播和分层详情。
- [ ] 覆盖直接/间接递归、深度/展开上限、嵌套 policy/entitlement deny、child output mapping，以及 nested DESKTOP session/CLOUD binding/scope 继承、父/child retry request key 变化但 effect key 稳定、零重新选路和零重复 evaluator。

### Validation 5

```bash
pnpm -C apps/collab-api test -- --testTimeout=60000 workflow-upgrade workflow-nested
pnpm -C apps/desktop test -- workflow
pnpm -C apps/desktop typecheck
```

### Review Gate 5

- 历史 workflow/run 精确引用在 action 更新、撤回和升级建议采纳后保持不变。
- 根 plan 可以追溯全部嵌套 definition hash 与叶子 action target。
- 父子状态与取消不会形成孤儿 RUNNING run。

## Step 6 - End-To-End And Cross-Child Handoff

- [x] 建立 A 图片、B 视频、C 配乐 fixture：图片 -> 视频，配乐并行，最后聚合 ArtifactRefs。
- [ ] 覆盖免费/付费 entitlement、团队 policy allow/deny、精确安装缺失、release yank、schema mismatch、retry 和 cancel。
- [ ] 将 `WorkflowExecutorPort`、run ledger schema、plan contract 和 Cloud eligibility fixtures 交给 Cloud 子任务复用。
- [ ] 执行旧 client/cloud/nodejs/python 发布、安装、更新、购买和运行回归。
- [ ] 检查源码文件大小，按 spec 抽分 DTO、纯 reducer、query helper、hooks 和 fixtures，避免新增巨型模块。

## Full Quality Gates

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C packages/workflow-engine typecheck
pnpm -C packages/workflow-engine test
pnpm -C packages/plugin-sdk typecheck
pnpm -C apps/collab-api prisma:validate
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test -- --testTimeout=60000
pnpm -C apps/collab-api build
cargo fmt --all -- --check
cargo test -p lingfang-desktop
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C apps/desktop exec playwright test e2e/workflow-plugin.spec.ts --project=chromium
pnpm -r typecheck
git diff --check
```

## Risk And Rollback Points

- **Runtime enum drift**：先落 contract alignment tests，再同步 backend/desktop/Rust allowlist；任一消费者未识别 workflow 时保持 feature flag 关闭。
- **Registry partial publish**：workflow snapshot 与 release 同事务提交，artifact promotion 失败沿用 orphan cleanup；不覆盖旧 release。
- **Duplicate side effects**：domain idempotency/CAS 与 transport retry 分离；side-effect 结果未知时 fail closed，绝不自动再发。
- **Desktop disconnect/inventory drift**：短期 `DesktopExecutorSession`、inventory hash、租约和 heartbeat 可检测；session 失效后停止新 claim，回滚只关闭新 run，保留 ledger 供诊断，不伪造成功。
- **Mapping/schema defect**：纯 engine 可单独回滚；已发布 snapshot 不迁移，修复通过新 definition contract version 与新 workflow release 发布。
- **UI regression**：workflow runner 独立路由，关闭 `WORKFLOW_PLATFORM_ENABLED` 后普通插件中心与四类 runner 不受影响。
- **Cross-child conflict**：action/policy/ArtifactRef owner 出现变化时回到 Step 0 更新设计，禁止在 workflow 模块复制临时协议。

## Ready-To-Start Checklist

- [ ] 用户已统一评审父任务与八个子任务规划。
- [ ] 前置 action 与 policy 子任务的共享契约已无冲突。
- [ ] `prd.md`、`design.md`、`implement.md` 与 context manifests 通过 `task.py validate`。
- [ ] 明确首个实现分支、base branch 与可用的 PostgreSQL/MySQL/desktop 测试环境。
- [ ] 只有以上条件满足后才运行 `task.py start 07-15-workflow-plugin-platform`。
