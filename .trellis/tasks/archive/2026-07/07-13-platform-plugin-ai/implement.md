# 实施计划：平台托管的插件 AI 调用

## 执行状态（2026-07-13）

- 本地实现、跨层接线、政策加固、外部 relay Key 删除和质量门禁已完成。
- 已验证：collab-api 759 tests、desktop 296 tests、Rust 195 tests、contract 28 tests、plugin-sdk 6 tests；相关 typecheck/build、PostgreSQL/MySQL Prisma generate+validate、`cargo fmt`、`git diff --check` 均通过。
- 最终审查补齐 marketplace 已安装插件的精确 `releaseId + sha256` 在线运行门禁，避免 entitlement/review/policy 变化后继续运行。
- 尚未执行的仅为部署期动作：生产数据库备份、检查点 A/B 分阶段发布、实际运行存量政策盘点与线上 chat/image/扣费 smoke test。
- 当前工作区未提交；按用户要求不自动创建提交或执行破坏性数据库部署。

## 0. 开发前门禁

- [ ] 运行 `trellis-before-dev`，读取 collab-api、contract、desktop、lingfang-desktop、plugin-sdk、ui 相关规范。
- [ ] 记录基线 `git status`，确认仅任务规划文件有预期修改。
- [ ] 核对 `design.md` 的原子发布/备份前提，不修改已应用历史 migration。

## 1. 检查点 A：加法迁移、团队 JWT 与纯 JWT Relay

- [ ] Prisma 兼容 schema 先增加 `User.teamContextVersion`、`LlmCallLog.clientSource` 与 legacy/v4 policy 状态字段；暂留旧 Key 表/关联。
- [ ] 新增 additive PostgreSQL migration：增加字段、把所有 PlatformApiKey 置为 DISABLED，不删除表。
- [ ] 更新 Prisma schema render 测试，生成 PostgreSQL/MySQL client 并 validate。
- [ ] JWT 签发/校验加入 `teamId + teamContextVersion`；旧 claim、版本漂移返回 401。
- [ ] 自助 membership 加入路径递增团队上下文版本并通过专用方法返回含新 token 的 session；管理员移除递增目标版本并强制其重新登录。
- [ ] 桌面替换团队 token 前撤销本机 bridge sessions，再原子写入 token/tenant 状态。
- [ ] PermissionsGuard 使用 JWT 绑定团队，不再独立选择最新 membership。
- [ ] 删除 DualAuthGuard；relay 改用全局 JWT + `RelayTeamGuard` 精确校验 membership/team。
- [ ] RelayAuth 删除 Key scope 行为但兼容 schema 暂留 nullable `apiKeyId`；运行时不再读取/写入 PlatformApiKey，确保只扣 guard 团队。

验证点：先运行 auth/guard/relay/prisma 定向测试；失败时不继续 UI 删除。

## 2. JWT-only 应用、权限数据迁移与 UI 收口

- [ ] 停止注册 `api-key.service`、团队/平台 Key endpoints 和 Key 鉴权；检查点 A 代码不再接触旧表。
- [ ] 删除 `team.api_key.manage`、`platform.billing.api_key.manage`、陈旧 relay docs 权限。
- [ ] 新增幂等 post-deploy data migration，确定性清理 PermissionEntry 与系统/自定义 Role 数组；接入 deploy 流程而非依赖可选 seed。
- [ ] contract/对外响应先删除 PlatformApiKey schema/type 和 LlmCallLog `apiKeyId`，更新测试。
- [ ] 桌面删除 TeamApiKeysTab、导航/权限判断、本地类型及误导文案。
- [ ] collab-admin 删除 API Key 视图、View union、导航、lazy import、preload 和 call-log key 字段。
- [ ] 更新 docs、示例 README、当前 `.trellis/spec`；保留历史 migrations、归档任务和历史 changelog 原样。

验证点：在旧表仍存在时，所有 `lf_...` 已失败且新应用无 Key 表查询；权限验证查询返回 0 stale codes。

## 3. 服务端插件 AI 政策

- [ ] 新增纯政策扫描器、稳定诊断类型、去重/排序/脱敏/截断与文本限额。
- [ ] 实现 manifest、依赖、源码、bridge env、secret sink、模型档位与 capability 规则。
- [ ] 新增认证政策检查 endpoint 和 DTO/限流；不可用或超限 fail closed。
- [ ] legacy JSON upload/live/draft update 写库前执行政策检查。
- [ ] v4 artifact 校验在 promote/release insert 前流式收集候选文本并执行同一扫描器。
- [ ] 确保政策失败时不 promote artifact、不创建 release、不留下永久对象。
- [ ] 新版本写入当前 `aiPolicyVersion/PASSED`；runtimeAccess、下载与安装拒绝 UNCHECKED/FAILED/旧 policy version。
- [ ] 新增存量盘点命令，扫描 legacy 文件与 v4 artifact；失败/缺失版本禁用或 yank，并记录脱敏原因。
- [ ] 为本地草稿、手工制品和本地安装增加 `policyVersion + contentHash` preflight/cache；内容或版本变化后重新检查，未验证时 fail closed。
- [ ] 平台内置插件进入 CI 政策扫描，修复示例中打印 bridge URL/token 等违规。
- [ ] 增加允许/拒绝/误报/超限/无效 UTF-8/大二进制 fixture 测试。

回滚点：扫描器与调用点独立提交边界；若规则误伤，先回滚规则/调用，不回滚数据库迁移。

## 4. 创建器与草稿试跑

- [ ] 增加桌面 policy API helper；`Check` 展示服务端原始诊断并保留现有非 AI capability/语法检查。
- [ ] Agent `RunPlugin` 和手动草稿试跑执行同一政策检查，失败时不启动进程。
- [ ] `RunPlugin` 从 manifest 透传 chat/image capability；AI 试跑使用 180 秒超时。
- [ ] draft workspace/HTML 预览保留 manifest capability，并标记 `plugin_test`。
- [ ] 更新生成提示词与开发 skill：允许标准 OpenAI 客户端仅连接宿主 bridge，禁止自定义上游。
- [ ] AI capability 模板/示例固定 `requires_admin:false`；manifest 规范化层把旧 AI capability 的 `requires_admin:true` 改为 false，同时不影响非 AI capability 的通用字段语义。
- [ ] 删除或绕过所有 AI 管理员授权接口、状态、弹窗和运行时审批分支；覆盖普通成员、旧 `requires_admin:true` AI manifest、版本升级新增 AI capability 和未声明 capability。

## 5. SDK、iframe 与 Rust bridge

- [ ] SDK 为 chat/image 使用 AI 专用超时并新增 `PluginAiError`；HTTP fallback 解析嵌套/顶层结构化错误。
- [ ] iframe shim/host 透传 `code/status/requestId`，按 draft/runtime 设置受限 `X-Client`。
- [ ] host 与 Rust 对 `model` 严格接受缺省/fast/premium，拒绝真实或未知模型；拒绝 bridge streaming。
- [ ] collab-api `wireToTier`/模型列表保持服务端权威：无跨档 fallback，按团队 SHARED/DEDICATED 池选择渠道与真实模型。
- [ ] Rust bridge session 增加 test/runtime 来源；仅声明 AI capability 时注入 env。
- [ ] token 使用 UUID v4；测试 finally、正式替换/停止/删除/自然退出均撤销。
- [ ] 新增 revoke-all command，并在登出、团队 token 更新、后端切换时调用。
- [ ] Rust relay 转发保留产品错误码/requestId，隐藏上游细节。

## 6. 调用日志与管理端

- [ ] Relay 根据 `X-Client` 写非可信 `clientSource` telemetry，未知值归 `platform`；管理端明确标注“客户端来源”。
- [ ] `plugin_test` 与 `plugin_runtime` 经过完全相同的 reserve/reconcile/refund。
- [ ] contract/collab-admin call-log 类型与列表/详情展示来源；不再展示 API Key 维度。
- [ ] 测试来源伪造不影响鉴权、模型、渠道、定价或扣费。

## 7. 检查点 B：物理删除 Key 数据

- [ ] 确认检查点 A 所有实例已是 JWT-only、旧 Key 全部失败、存量政策盘点已完成并记录健康检查结果。
- [ ] 备份数据库；PostgreSQL migration 删除 `LlmCallLog.apiKeyId` 外键/索引/字段、PlatformApiKey 表和 ApiKeyStatus enum。
- [ ] 最终 Prisma schema 删除 PlatformApiKey、ApiKeyStatus、User/Team 反向关系和 `LlmCallLog.apiKeyId`。
- [ ] 为 MySQL `db push` 增加显式 destructive opt-in；默认 deploy 继续 fail closed，并只在检查点 B 使用。
- [ ] 物理删除 `api-key.service`、测试、controller/DTO/module 残余代码。
- [ ] 重新 generate/validate 两种 provider；全仓 `rg` 仅允许历史 migration/archive 中残留 `PlatformApiKey/lf_...`。

## 8. 测试与质量门禁

- [ ] `pnpm -C packages/contract typecheck`
- [ ] `pnpm -C packages/contract test`
- [ ] `pnpm -C packages/plugin-sdk typecheck`
- [ ] `pnpm -C packages/plugin-sdk test`（新增测试脚本后）
- [ ] `pnpm -C apps/desktop typecheck`
- [ ] `pnpm -C apps/desktop test`
- [ ] `pnpm -C apps/desktop vite:build`
- [ ] `pnpm -C apps/collab-admin typecheck`
- [ ] `pnpm -C apps/collab-admin build`
- [ ] `perl -e 'alarm shift; exec @ARGV' 60 pnpm -C apps/collab-api test`
- [ ] `pnpm -C apps/collab-api typecheck`
- [ ] `pnpm -C apps/collab-api build`
- [ ] PostgreSQL/MySQL Prisma generate + validate；只对临时测试库验证 destructive migration/push。
- [ ] `cargo fmt --check`
- [ ] `cargo test -p lingfang-desktop`
- [ ] 全仓检查 Key/API URL UI、旧权限、Key endpoint、DualAuthGuard 和 call-log `apiKeyId` 残留。
- [ ] 运行 `trellis-check` 做 spec、跨层契约、复用、lint/typecheck/test 最终复核。

## 9. 发布与回滚检查

- [ ] 记录 PostgreSQL 备份与 MySQL destructive opt-in 命令，不在代码中默认开启数据丢失。
- [ ] 产出检查点 A/B 的独立提交或发布引用；A 先部署并验证，B 才允许 drop 数据。
- [ ] 验证旧 `lf_...`、旧 JWT、旧 bridge token 均失败；新 JWT 的 chat/image 成功并只扣当前团队。
- [ ] A 失败回滚应用且保持 Key 禁用；B 失败优先修复前滚，恢复旧数据必须配套 B 前备份和旧应用。

## 风险文件

- `apps/collab-api/src/modules/plugin-artifact.ts`：ZIP/CRC/zip-bomb 安全边界，政策收集不得绕过现有流式校验。
- `apps/collab-api/src/security.ts`、`permissions.guard.ts`：全局鉴权面，必须先跑定向测试再扩全量。
- `apps/desktop/src-tauri/src/plugin_runner.rs`：大文件且含进程并发，token cleanup 改动保持小范围并覆盖自然退出/替换。
- `apps/desktop/src-tauri/src/plugin_llm_bridge.rs`：本地秘密与转发边界，错误体不得泄露上游细节。
- Prisma destructive migration：不可逆删除 Key 数据，发布前必须备份。
