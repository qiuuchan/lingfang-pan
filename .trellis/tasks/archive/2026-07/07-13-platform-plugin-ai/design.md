# 技术设计：平台托管的插件 AI 调用

## 1. 目标形态

插件只声明并调用平台能力，不持有平台 JWT、上游 Key 或可配置的模型地址：

```text
HTML 插件 -> iframe host bridge ------------------\
                                                   -> collab-api relay -> 当前团队额度 -> 平台渠道池 -> 上游
Node/Python -> localhost bridge + 会话 token -----/
```

- `llm.chat` 与 `image.generate` 是唯一正式插件 AI 能力。
- `fast` / `premium` 是唯一插件可见模型档位；真实 provider、模型、Key 和 URL 留在平台渠道配置。
- Node/Python 可使用 OpenAI-compatible 客户端，但只能连接宿主注入的 localhost bridge。
- 开发试跑与正式运行使用同一 relay 和同一团队扣费，只在调用日志来源上区分。
- 有插件访问权的成员可直接使用 manifest 已声明的 AI 能力，不增加管理员二次审批。

## 2. 模块边界

| 模块                     | 职责                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `packages/plugin-sdk`    | 薄类型客户端、脚本 bridge fallback、结构化插件 AI 错误               |
| `apps/desktop`           | 绑定当前插件、注入 bridge、开发检查/试跑、来源标记                   |
| `apps/desktop/src-tauri` | localhost token、capability gate、JWT 隔离、relay 转发、进程生命周期 |
| `apps/collab-api`        | JWT/团队校验、政策扫描、渠道路由、额度、计费与调用日志               |
| `apps/collab-admin`      | 平台渠道、定价、团队额度与调用日志；不再管理外部 relay Key           |

平台管理员仍在渠道管理中配置上游 `baseUrl` 和加密 Key。这是平台内部运营能力，不进入插件 manifest、设置或运行参数。

## 3. JWT 与团队额度边界

### 3.1 会话契约

保持现有“签发会话时选择最新 ACTIVE membership”为当前团队的产品语义，但只选择一次，不允许 relay 每次重新推算：

- `User` 新增 `teamContextVersion Int @default(0)`。
- 登录 JWT 新增签名 claim：`teamId: string | null`、`teamContextVersion: number`。
- `AuthService.sessionFor()` 用同一条 membership 同时构造响应 `team` 和 JWT `teamId`。
- `JwtAuthGuard` 校验 `tokenVersion` 与 `teamContextVersion`，并把签名的 `teamId` 写入 `request.user`。
- 缺少新 claim 的旧 JWT 直接 401，客户端重新登录后取得新契约 token。

会改变当前团队的 membership 操作（邀请码兑换、公开加入、移除成员等）必须递增受影响用户的 `teamContextVersion`。操作成功后当前客户端取得新 token；旧 token 与旧脚本 bridge 在下一次 relay 调用时失败。

- 自助加入/兑换在事务提交后调用专用 `sessionAfterTeamContextChange()`，响应必须包含按新 version 签发的 token；不能复用当前不返回 token 的 `auth.me()`。
- 管理员移除/停用其他成员时无法向目标设备回传 token，目标用户的旧 token 直接失效并强制重新登录。
- 桌面收到带新 token 的 session 时，先请求撤销本机 bridge sessions，再原子替换 token 与 tenant 状态；撤销失败不继续使用旧 token，服务端 version 校验仍是最终防线。

本任务不新增多团队切换 UI 或持久化 `currentTeamId`。未来若增加显式切换接口，必须在同一事务中递增 `teamContextVersion` 并签发新 token。

### 3.2 Relay 鉴权

- 删除 `DualAuthGuard` 和 `@Public()` relay 例外。
- relay 先通过全局 `JwtAuthGuard`，再由 controller 级 `RelayTeamGuard` 精确查询 `(teamId, userId)`。
- membership 与 Team 均须为 `ACTIVE`；失败时不创建预扣、不写扣费流水。
- `RelayAuth` 收敛为 `{ teamId, userId }`，删除 `apiKeyId`、`scopes` 与 API Key scope 分支。
- 所有 reserve/reconcile/refund 和 `LlmCallLog.teamId` 只使用 guard 确认的团队，不回退其他 membership。

`PermissionsGuard` 同步改用 JWT 绑定的 `teamId` 精确查角色，避免页面权限与 relay 团队发生漂移。

## 4. 完整删除外部 Relay Key

一次性删除以下能力：

- Prisma `PlatformApiKey`、`ApiKeyStatus`、User/Team 反向关系。
- `LlmCallLog.apiKeyId`、外键和索引；历史日志其余字段保留。
- `api-key.service`、团队 Key controller、平台 Key 总览 API、DTO、测试和 module 注入。
- `lf_...` 判断、hash 查询、状态/scope 校验和 `lastUsedAt` 更新。
- `team.api_key.manage`、`platform.billing.api_key.manage` 及陈旧的 relay docs 权限。
- 桌面“AI 接入密钥”Tab、平台管理端 API Key 视图、相关类型、导航和预加载。
- contract schema、公开文档和插件示例中的外部 Key 接入说明。

权限数据清理由确定性的 post-deploy data migration 执行，既删除 `PermissionEntry`，也从系统/自定义 Role 的 `permissions` 数组移除废弃码。PostgreSQL migration 可直接更新数组；MySQL 通过同一幂等 TypeScript migration helper 更新 JSON。seed 只复用 helper，不是部署正确性的唯一入口。

### 4.1 数据库迁移

PostgreSQL 使用两个独立 migration，与发布检查点严格对应：

1. 检查点 A 的 additive migration 增加 `User.teamContextVersion`、默认 `platform` 的 `LlmCallLog.clientSource`，以及 legacy `Plugin` / v4 `PluginRelease` 的 `aiPolicyVersion`、`aiPolicyStatus`、脱敏 `aiPolicyReason`；同时把全部 `PlatformApiKey` 状态置为 `DISABLED`，暂不删除旧表和关联。
2. 检查点 B 的 destructive migration 在确认所有实例均为 JWT-only 并完成备份后，删除 `LlmCallLog.apiKeyId` 外键、索引和字段，再删除 `PlatformApiKey` 表和 `ApiKeyStatus` enum。

MySQL 使用生成 schema + `prisma db push`。删除表/列必须显式设置一次性 destructive flag 才追加 `--accept-data-loss`；普通 deploy 永不默认接受数据丢失。

已应用的历史 migration 不修改。

## 5. 插件 AI 发布政策门禁

### 5.1 单一实现

新增 collab-api 纯函数模块 `plugin-ai-policy.ts`，同时被以下路径调用：

- `POST /api/plugins/policy/check`：创建器 `Check`、Agent `RunPlugin` 和手动草稿试跑的提前反馈。
- legacy JSON 插件 upload/update normalization 后、写库前。
- v4 `.lfplugin` artifact 解压校验后、promote/创建 release 前。
- 存量政策盘点命令：扫描 legacy 文件与 v4 artifact，并写入 policy version/status；失败或不可扫描的版本禁用/yank。

不在客户端复制规则，也不新增需要 CommonJS/Vite/Docker 双构建的 workspace package。创建器本来就依赖平台模型与登录态；政策检查 API 不新增离线能力回归。检查 API 不可用时，开发试跑 fail closed，上传门禁仍是最终权威。

所有新写入版本保存 `aiPolicyStatus=PASSED` 与当前 `policyVersion`。`runtimeAccess`、下载/安装入口只返回当前 policy version 已通过的版本。部署后先运行存量盘点；`UNCHECKED`、`FAILED` 或 artifact 缺失均不可运行，修复后必须发布新版本，不能人工改状态绕过扫描。

本地草稿/手工制品/已安装本地包在安装、开发试跑或当前内容哈希首次运行前调用政策检查 API；桌面仅缓存 `{policyVersion, contentHash, ok}`。内容变化或 policy version 提升会使缓存失效。平台内置插件作为受信任产品代码进入同一 CI fixture 扫描，不依赖用户运行时检查。

### 5.2 诊断契约

```ts
type PluginAiPolicyDiagnostic = {
  code:
    | 'ai.config.forbidden'
    | 'ai.endpoint.third_party'
    | 'ai.sdk.third_party'
    | 'ai.bridge.custom'
    | 'ai.bridge.secret_sink'
    | 'ai.model.invalid'
    | 'ai.capability.missing'
    | 'ai.policy.unscannable';
  path: string;
  line?: number;
  message: string;
  capability?: 'llm.chat' | 'image.generate';
};

type PluginAiPolicyResult = {
  policyVersion: 1;
  ok: boolean;
  diagnostics: PluginAiPolicyDiagnostic[];
  requiredCapabilities: Array<'llm.chat' | 'image.generate'>;
  truncated: boolean;
};
```

结果确定性排序、去重、最多返回 50 条；消息不包含命中的完整 secret 或完整私有 endpoint。

### 5.3 规则

- 结构化解析 manifest，拒绝模型语境下的 `apiKey/apiUrl/baseUrl/provider/authorization/endpoint` 配置；`model` 只允许 `fast|premium`。
- 结构化解析 `package.json` 依赖与逐行解析 `requirements.txt`。
- 允许 `@lingfang/plugin-sdk`、`openai`、`@ai-sdk/openai`；标准客户端必须同时从精确的 `LINGFANG_PLUGIN_BRIDGE_URL` 与 `LINGFANG_PLUGIN_BRIDGE_TOKEN` 取值，且无非空 fallback。
- 拒绝已知第三方 AI SDK、已知 AI 服务域名/路由、硬编码模型 secret、自定义 bridge 值、打印或持久化 bridge token/URL。
- 推断 chat/image 使用并校验 manifest capability。
- 不因通用 `fetch/requests/axios`、普通 URL、普通 Bearer header 或普通业务字段 `provider` 单独拒绝，避免误伤合法 `net.fetch` 插件。

扫描可执行/配置文本扩展，先去除源码注释但保留字符串与 HTML UI。可扫描文本上限为单文件 4 MiB、依赖文件 256 KiB、总计 32 MiB；超限、入口非法 UTF-8 或含 NUL 时 fail closed。二进制媒体继续走现有 artifact 限额，不进入文本扫描。

该门禁防止正常开发、误用和直接违规，不是恶意代码沙箱；故意混淆与运行时任意联网不在本任务承诺内。

## 6. 插件运行与开发测试

### 6.1 API 形态

- SDK：`sdk.llm.chat({ messages, model? })`、`sdk.image.generate({ prompt, model?, size?, n? })`。
- SDK bridge：`/llm/chat -> {content}`、`/image/generate -> {images}`。
- OpenAI-compatible：`/v1/chat/completions`、`/v1/images/generations`、`/v1/models` 原始兼容形态。
- 标准客户端只允许：`baseURL = LINGFANG_PLUGIN_BRIDGE_URL + '/v1'`、`apiKey = LINGFANG_PLUGIN_BRIDGE_TOKEN`。

省略 `model` 使用 `fast`；显式值只接受 `fast|premium`。未知值返回 `unsupported_model`，不再静默改成 `fast`。本地 bridge 暂不支持 streaming，`stream:true` 返回 `unsupported_streaming`。

collab-api `wireToTier()` 是权威解析：只接受 `fast|premium`，再由 `ChannelRouterService.selectCandidates({teamId, kind, tier})` 从 SHARED 与该团队 DEDICATED 资源池选择渠道及其真实模型。服务端不在 fast/premium 之间降级；请求档位无渠道返回 `no_channel_available`，候选无定价返回 `pricing_not_configured`。`GET /relay/v1/models` 只返回当前团队资源池实际可用的档位。host/Rust 的同名校验仅用于更早报错。

### 6.2 Capability 与试跑

- Agent `RunPlugin` 从 manifest 传真实 capability，不再固定空数组。
- 手动草稿预览和 draft workspace loader 同样保留 manifest capability。
- 未声明 AI capability 时不注册 bridge session，也不向子进程注入 bridge URL/token。
- AI 试跑超时使用 180 秒；其他 capability 保持现有短超时。
- AI 示例与生成提示词把 AI capability 的 `requires_admin` 设为 false；服务端和桌面对旧 AI capability 的 `requires_admin:true` 统一忽略并规范化为 false，不保留任何 AI 管理员授权接口、状态或运行时审批分支。通用字段仅可继续服务非 AI capability。

### 6.3 调用来源与扣费

新增 `LlmCallLog.clientSource`：`platform | plugin_runtime | plugin_test`。

- `X-Client: desktop-plugin` -> `plugin_runtime`
- `X-Client: desktop-plugin-test` -> `plugin_test`
- 其他/未知 -> `platform`

该字段由可伪造的 `X-Client` 映射，只是客户端自报 telemetry，不是可信审计证据。它不参与鉴权、路由、定价或额度；管理端明确标为“客户端来源”。三种来源都按同一 `RelayAuth.teamId` 扣费。

### 6.4 Bridge token 生命周期

- token 改用 OS CSPRNG (`uuid` v4)，按插件进程会话签发，可在会话内多次请求。
- 测试进程完成、失败或超时后立即撤销，短 TTL 只作兜底。
- 正式进程的 token 在停止、删除、替换和自然退出时撤销；宿主退出后内存 session 自然消失。
- 登出、团队 token 更新或后端切换时桌面调用 `revoke_all_plugin_bridge_sessions`。

### 6.5 结构化错误

bridge 保留 relay 的 HTTP status、稳定 `code`、产品 `message` 与 `requestId`，但不向插件暴露供应商细节。

OpenAI-compatible 错误同时返回嵌套 `error` 与顶层兼容字段。`@lingfang/plugin-sdk` 抛出带 `code/status/requestId` 的 `PluginAiError`；iframe postMessage 保留相同字段。未登录、团队不可用、能力未声明、额度不足、无渠道与上游失败不再全部退化为字符串 `relay_error`。

## 7. 兼容、发布与回滚

- 采用两个发布检查点，不能让仍接受 `lf_...` 的旧 API 与已 drop 表的数据库混跑。
- 检查点 A（可前滚恢复）：执行 additive migration（team version、client source、policy 状态），把所有 Key 置为 DISABLED，部署 JWT-only 且不再读写 Key 表的兼容应用；旧表/列暂留。
- A 验证所有实例版本、旧 Key 全部失败、新 JWT/插件调用正常、存量政策盘点完成后，才进入检查点 B。
- 检查点 B（破坏性）：备份数据库，执行删除 `apiKeyId`/PlatformApiKey/enum 的 migration 或 MySQL destructive push，再部署最终 schema 应用。
- A 失败可回滚应用且 Key 保持禁用；B 失败优先修复前滚，恢复旧能力只能使用 B 前备份和旧应用。
- 检查点 A 起所有 `lf_...` Key 立即失效；缺团队 claim 的旧 JWT 要求重新登录；旧 bridge 会话下一次请求失败。
- PostgreSQL 回滚和已删除 Key 数据恢复只能依赖切换前备份并同步回滚应用。
- MySQL destructive push 必须显式运维确认；失败时停止部署，不自动忽略。
- 政策门禁可通过回滚应用关闭，但已删除 Key 表仍需数据库备份才能恢复。

## 8. 验证重点

- JWT team claim/version、精确 membership、团队暂停/移除、多 membership 不漂移。
- `lf_...` 统一 401，代码/Schema/UI/权限无 PlatformApiKey 残留。
- plugin test/runtime 使用同一团队扣费，日志来源不同。
- SDK、iframe、Node/Python bridge 的 chat/image、默认/高级档、超时与结构化错误。
- 创建器检查、legacy upload 与 v4 artifact 对相同政策用例给出相同诊断。
- 存量盘点、runtimeAccess 与本地 content-hash preflight 隔离旧违规版本。
- 普通 HTTP 插件、媒体大文件与允许的标准 OpenAI bridge 客户端不被误判。
