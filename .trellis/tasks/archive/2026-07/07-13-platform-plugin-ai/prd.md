# Platform-backed plugin AI calls

## Goal

让插件在正式运行时直接使用灵坊平台提供的大模型能力，覆盖文本对话与图片生成。终端用户不创建、不复制、不填写任何模型 API Key 或 API URL；同一团队的模型接入与费用归属由平台统一管理。

## Confirmed Facts

- 平台已经定义 `llm.chat` 与 `image.generate` 插件能力，并由宿主桥转发到平台 relay。
- 插件 SDK 规范禁止在调用参数或插件设置中出现 `apiKey`、`apiUrl`、`baseUrl`、provider、Authorization header、上游模型 ID 或计费数据。
- 宿主桥同时提供 SDK 形态接口和 OpenAI-compatible 本地接口，供 JavaScript/TypeScript 与第三方 Python/Node SDK 使用。
- HTML/iframe 插件当前使用宿主登录 JWT，Node/Python 插件使用仅监听 localhost 的一次性桥 token；两条路径都由服务端解析团队，插件拿不到 JWT 或上游密钥。
- 平台管理员在渠道管理中维护上游 `baseUrl` 与加密的供应商密钥；平台可按共享资源池或团队专属资源池为请求选择 chat/image 渠道。
- 平台另有一类 `lf_...` 团队共享 API Key，只用于外部程序直接调用 OpenAI-compatible relay。它与平台上游渠道密钥不是同一个 Key，插件与 Agent 不读取它。
- 桌面端当前仍向有 `team.api_key.manage` 权限的团队管理员展示“AI 接入密钥”页，可生成、复制、轮换和吊销上述外部 relay Key。
- 插件创建提示词已禁止 API Key/API URL/provider/第三方 AI 直连，但现有草稿结构校验和服务端发布门禁尚未扫描密钥字段与第三方 AI 直连。
- 当前没有受保护的 development/production 插件模式；创建期试跑和正式脚本运行复用本地桥机制。
- 创建器 Agent 的自动 `RunPlugin` 目前固定传空 capability 列表，无法在自动试跑中真实验证 chat/image；手动预览则会传 manifest capability。
- Node/Python 插件是软隔离进程，仍能直接联网；仅靠 SDK 类型与静态提示无法从运行时强制阻止其绕过平台 relay。
- 存量 legacy/v4 服务端插件与本地已安装插件尚未经过统一 AI 政策检查，不能只给未来上传增加门禁。

## Requirements

- 正式插件必须通过平台能力调用 chat 与图片生成，不得直接请求第三方模型供应商。
- 终端用户无需在客户端生成模型 API Key。
- 插件的配置页、manifest、调用参数和正式运行环境不得提供 API Key 或 API URL 输入入口。
- 团队共用同一套平台侧模型接入配置与计费归属；密钥不得下发给插件代码或终端用户。
- 删除面向团队的 `lf_...` 外部 relay Key 生成、查看、复制、轮换和吊销能力；外部程序直调平台 relay 不属于产品范围。
- 完整移除 `PlatformApiKey` 数据模型、存量数据、`LlmCallLog.apiKeyId` 关联、`lf_...` 鉴权分支、团队/平台管理 API、权限、契约、管理页面及文档；迁移生效后所有现有 `lf_...` Key 立即失效。
- 历史 LLM 调用日志继续保留，但不再保留或展示外部 Key 关联。
- 平台继续执行登录态、团队归属、manifest 能力声明、既有插件访问权、额度/计费与审计检查；不增加 AI 管理员审批。
- 每次插件 chat/image 调用只能使用并扣减 JWT 所绑定的当前会话团队额度；不得使用个人额度、平台公共额度，也不得在余额不足时回退扣减用户加入的其他团队。
- 开发试跑调用同样扣减当前团队额度，并在调用日志中标记为插件开发测试；不提供免费额度或计费旁路。
- 当前会话团队必须绑定进服务端签名的会话凭证；relay 精确校验该用户在该团队的 ACTIVE membership 与团队 ACTIVE 状态，不得在每次调用时按 `joinedAt` 重新推算团队。
- membership 变更导致会话团队上下文改变后，旧凭证及由其创建的本地桥会话不得继续调用；客户端需取得绑定新团队的新凭证。
- 有权运行插件的团队成员可直接使用插件已声明的 `llm.chat` / `image.generate` 能力；AI 能力不保留团队管理员授权、二次审批或版本升级重新审批流程。
- manifest 仍必须声明 AI 能力，供宿主门禁、审计和发布政策校验使用；能力声明本身不构成管理员审批。
- 旧 manifest 中 AI capability 的 `requires_admin:true` 必须被忽略并规范化为 `false`；该通用字段可继续服务其他非 AI capability，但不得触发任何 AI 授权分支。
- 插件可选传平台模型档位 `fast` / `premium`，省略时默认 `fast`；不得传真实上游模型名或借 `model` 选择 provider/Key/URL。
- collab-api 是模型档位的权威校验与解析边界；host/SDK 校验只负责提前反馈，不替代服务端按团队资源池、能力类型与档位选择渠道/真实模型。
- HTML/JavaScript 插件使用 `@lingfang/plugin-sdk`；Node/Python 插件还可使用标准 OpenAI-compatible 客户端连接宿主 localhost 桥。
- 标准客户端只能从宿主注入的 `LINGFANG_PLUGIN_BRIDGE_URL` 与一次性 `LINGFANG_PLUGIN_BRIDGE_TOKEN` 取得连接参数；这些值不得由用户输入，不得写入 manifest、插件设置、日志或持久化文件，也不得替换为自定义值。
- 本地桥 URL/token 不是平台 JWT、团队外部 Key或上游供应商密钥，只在受控插件运行会话中有效。
- 插件开发阶段保留 chat/生图试跑能力；试跑与正式运行使用同一平台 relay，不允许开发者配置自定义上游、Key、API URL 或 provider。
- 开发测试调用应有独立审计标记，使用并扣减当前团队额度，不得形成免费额度、计费旁路或第二套模型路由。
- 所有团队插件上传/发布必须经过服务端 AI 使用政策门禁；创建器本地检查使用同一规则并提供更早反馈。
- 存量 legacy/v4 插件必须执行一次性政策盘点；不合规或无法扫描的版本分别禁用/yank，修复并发布通过当前 policy version 的新版本后才能恢复。
- 本地草稿、手工安装制品和已安装插件在开发试跑、安装或首次运行当前内容哈希前必须通过同一服务端政策检查；结果按 `policyVersion + contentHash` 缓存，未验证的 AI 相关插件在平台不可达时 fail closed。
- 政策门禁检查 manifest、文本源码及依赖声明，拒绝模型密钥/API URL/provider 配置、已知第三方 AI SDK/端点和未声明的 `llm.chat` / `image.generate` 使用。
- 普通网络功能仍可按既有 `net.fetch` 等能力使用；本任务不引入 OS 级进程网络沙箱，也不承诺阻止故意混淆的恶意脚本绕过静态政策检查。

## Acceptance Criteria

- [ ] 已登录且团队具备可用平台模型通道时，已声明相应能力且成员有访问权的插件可完成 chat 调用。
- [ ] 已登录且团队具备可用平台模型通道时，已声明相应能力且成员有访问权的插件可完成图片生成调用。
- [ ] chat/image 对省略 `model` 的请求使用 `fast`；显式 `premium` 只选择平台高级档，不暴露或固定任何上游模型。
- [ ] 同团队用户的插件调用归属同一团队配置与账单，且插件进程无法取得平台或上游明文密钥。
- [ ] 用户加入多个团队时，调用只记入 JWT 绑定的会话团队；membership 顺序变化不能让同一 JWT 漂移到另一团队，取得新团队 token 后旧插件会话失效。
- [ ] 开发试跑与正式运行均扣当前团队额度；调用日志以非安全遥测字段区分客户端自报的 `plugin_test` 与正式插件调用，该字段不影响任何授权或计费决策。
- [ ] 当前团队 membership 被移除或团队被暂停后，已有 JWT/本地桥下一次调用失败且不扣费。
- [ ] 普通团队成员运行已有访问权的插件时可直接调用其已声明 AI 能力，无管理员授权弹窗；未声明能力仍被宿主拒绝。
- [ ] 插件安装、配置及正式使用流程中不存在 API Key、API URL、provider 或 Authorization header 输入项。
- [ ] 桌面客户端不再展示“AI 接入密钥”入口，团队侧不再提供 `lf_...` Key 自助管理 API 与对应权限。
- [ ] 平台管理端不再展示 API Key 总览；relay 对 `lf_...` Bearer 不再走 Key 查询，按无效 JWT 返回未授权。
- [ ] Prisma 的 PostgreSQL/MySQL 渲染与迁移均不再包含 `PlatformApiKey`，`LlmCallLog` 不再包含 `apiKeyId`。
- [ ] 未登录、manifest 未声明能力、团队无可用通道或余额不足时，返回平台定义的产品错误，不引导用户填写密钥。
- [ ] JavaScript/TypeScript SDK 插件及使用 OpenAI-compatible 客户端的脚本插件均有覆盖测试。
- [ ] Python 与 Node 标准 OpenAI 客户端可通过宿主桥完成 chat/image；使用硬编码、自定义或持久化 bridge/upstream 配置的发布包被政策门禁拒绝。
- [ ] 开发测试模式与正式运行模式有明确来源和生命周期隔离；规则覆盖的明文配置、已知第三方 SDK/端点、自定义 bridge fallback 与直接违规发布包会被拒绝。
- [ ] 创建器自动试跑能按草稿 manifest 的能力声明真实验证平台 chat/image，而不是以空 capability 运行。
- [ ] 创建器检查和服务端上传/发布对同一组违规插件夹具给出一致结论；服务端门禁不可由客户端跳过。
- [ ] 合法普通网络插件不会仅因包含通用 HTTP 请求而被误判为第三方 AI 直连。
- [ ] 存量服务端插件完成政策盘点并隔离失败版本；本地未验证插件不能绕过安装/试跑/首次运行门禁。
- [ ] 旧 `requires_admin:true` AI manifest 被规范化为 `false` 且不存在 AI 管理员授权接口、状态或弹窗；普通成员、升级新增 AI capability 与未声明 capability 场景均有测试。
- [ ] 过期 API Key 权限码从 PermissionEntry 和所有系统/自定义角色数据中确定性清除，不依赖人工运行可选 seed。

## Out of Scope

- 向插件或普通团队成员展示平台/上游明文密钥。
- 任何外部程序通过团队 `lf_...` Key 直接调用平台 relay 的兼容接入能力。
- 通过 OS 级网络沙箱绝对阻止故意混淆的恶意插件直连第三方模型。
- 让每位终端用户维护自己的模型供应商账户或密钥。
- 新增多团队选择器或完整的团队切换产品流程。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
