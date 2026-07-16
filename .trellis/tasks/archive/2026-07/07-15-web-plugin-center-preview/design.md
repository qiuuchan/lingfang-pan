# Web 插件中心与预览设计

## Architecture

新增 apps/web React + Vite 应用，复用 @lingfang/contract 与 @lingfang/ui-tokens，但不复用 collab-admin 的平台管理员 shell。collab-api 继续拥有 catalog、listing、entitlement、purchase 与 policy 事实；action 模块拥有 `ActionInvocation` 状态机，Web preview 模块只拥有 session、配额和读取投影。

数据流：

    Browser apps/web
      |-- public catalog/detail ----------> collab-api marketplace projection
      |-- web session/team context -------> collab-api auth/team
      |-- M2 purchase/entitlement --------> registry + existing purchase service
      |-- M3 campaign/settlement/refund --> settlement + marketing service
      |-- client iframe ------------------> isolated preview origin
      |-- cloud trial --------------------> preview API -> ActionInvocation(kind=PREVIEW) -> cloud adapter
      +-- local runtime CTA --------------> desktop deep link/download

## Package Boundaries

- apps/web：路由、登录/团队上下文、catalog UI、详情、预览控制器、购买 UX。
- packages/contract：公共 catalog/detail、compatibility、PreviewSession、CloudTrialProjection 与错误 schema；projection 复用 action owner 的 invocation 状态，不复制枚举。
- apps/collab-api/src/modules/web-marketplace：匿名安全投影、鉴权 overlay、预览 session 和桌面承接元数据。
- apps/collab-api/src/modules/plugin-preview：client preview bundle 授权，以及 cloud PREVIEW invocation 的配额与读取投影。
- 独立 preview origin：只服务不可变的已审核 client release 资源，不持有主站 cookie。

## Routes And Views

- /plugins：精选、分类热门、近期优质以及搜索/筛选后的目录。
- /plugins/:packageId：详情、质量依据、作者、版本、runtime、兼容性、价格、权益和 preview。
- /plugins/:packageId/preview：client 沙箱或 cloud 试跑结果；本地 runtime 跳回详情的桌面承接。
- /login、/register、/account/purchases：复用现有普通用户身份与团队上下文。

使用 react-router-dom 管理 URL 与数据路由，不在组件内手写 history 状态机。筛选器序列化到 query string，服务端排序使用稳定的 id 次级键。

## Contracts

PublicPluginCard 在 Milestone 2 只包含 packageId、listingId、name、summary、author display、category、runtime summary、qualityTier、rating/install aggregates、basePrice、`priceVersion: string`、previewMode、updatedAt。内部 `priceRevision: Int` 永不出 API。Milestone 3 以可选字段增量加入 effectivePrice 和 campaign projection，不改变 priceVersion 类型或基础价格字段语义。

PluginDetail 在登录前返回相同公开字段、当前公开 release compatibility 与审核后的 preview media；登录 overlay 额外返回 teamId、entitled、policyDecision、balance 与 allowedOperations。Milestone 3 再增量返回 settlement/refund 状态，Milestone 2 客户端不得要求这些字段存在。

PreviewMode 为 CLIENT_SANDBOX、CLOUD_TRIAL、STATIC_DESKTOP。PreviewSession 返回短期 sessionId、releaseId、sha256、mode、expiresAt 和一次性 channel nonce。CloudTrialProjection 只投影 action owner 返回的 invocationId、status、配额、过期时间和授权结果引用，不定义第二套运行状态。

所有 unknown 响应先由 contract decoder 校验；UI 不直接读取 Prisma 行或 manifest 任意字段。

## Authentication

现有桌面 bearer JWT 保持不变。Web 新增兼容的 HttpOnly、Secure、SameSite=Lax session cookie 入口，底层仍校验相同 tokenVersion/teamContextVersion。变更型 Web 请求使用 CSRF token；preview origin 不接收主站 cookie。

若 cookie 会话尚未上线，Web 任务不得退化为把长期 JWT 暴露给 preview iframe。预览消息只携带短期 nonce。

## Client Sandbox

发布审核后异步提取 client release 的 Web 资源到通用对象存储，key 包含 releaseId 与 sha256。预览域按不可变路径提供资源并设置：

- Content-Security-Policy 默认拒绝，script/style/img/media/connect 按审核结果收窄。
- iframe sandbox 仅允许脚本和必要下载，不设置 allow-same-origin、top-navigation 或 popups。
- frame-ancestors 只允许配置的 Web 主站 origin。
- 每次打开生成短期 sessionId 与一次性 channel nonce。由于 sandbox 不含 `allow-same-origin`，子文档是 opaque origin，浏览器发送的 `postMessage` 事件必须满足 `event.origin === "null"`，而不是预览部署源的真实 origin。
- 宿主握手同时校验 `event.source === iframe.contentWindow`、sessionId 与尚未使用的 nonce；任一项不匹配即拒绝。成功握手原子消费 nonce，并通过该握手转移专用 `MessagePort`，后续 bridge 流量只走绑定到该 session 的端口。

宿主只实现 preview-safe bridge。任何 fs、clipboard、shared write、purchase、publish、schedule 或 system capability 返回稳定的 preview_capability_denied。

## Cloud Trial

POST /api/web/plugin-actions/:packageId/:actionId/preview 调用共享 `ActionInvocationService` 创建 `ActionInvocation(kind=PREVIEW)`：

1. 由 action invocation 的单次 compound governance decision 原子校验登录用户、团队、listing、entitlement/免费规则、精确 release、action previewable metadata 及 `invoke_action + execute_cloud + web_preview`；任一项拒绝即整体拒绝。
2. 原子占用用户每日计数与并发槽。
3. 由同一 invocation 状态机经 cloud adapter 调用 action endpoint，但注入 preview principal、独立幂等键与更低资源上限。
4. 校验 output schema，将大输出写为 expiresAt=24h 的 ArtifactRef。
5. 终态释放并发槽；失败也计入滥用限额但不计正式运行 SLA。

默认 5 次/日、1 并发由 PlatformSetting 控制。preview action 禁止 shared KV 写入和 schedule 创建；side-effect action 不允许标记 previewable。

## Static And Desktop Handoff

作者提交的截图、短视频和示例输出作为 listing preview media，经审核后保存为 ArtifactRef。Node.js/Python 或不支持 Web 的 release 只渲染这些资源。

桌面承接优先使用受控 lingfang://plugins/:packageId deep link；协议不可用时展示平台发布页的当前 OS 下载地址。Web 不宣称插件已安装。

## Data Flow And Consistency

Catalog/read model 始终由 registry/listing/quality 数据生成，市场营销投影只在 Milestone 3 增量合并。Milestone 2 dark commerce foundation 由服务端返回基础价格与 opaque string priceVersion；Web 购买只提交同为 string 的 expectedPriceVersion，LEGACY purchase 事务已能重算，不匹配时在任何业务写前返回 marketplace_price_changed，不信任前端金额或内部 revision。

Milestone 3 上线后，服务端再按请求时刻计算活动 effectivePrice，并由市场结算与营销服务拥有活动版本、T+7 卖家结算和 7 天退款状态。Web 只渲染这些增量投影并调用对应命令，不自行计算活动价、结算时间或退款资格。settlement-v2 writer 切换后不可回退：关闭营销/投影 flag 只隐藏活动价、退款和结算展示，基础标价的新付费订单仍走 settlement-v2；结算核心不可用时付费购买 fail-close，绝不重新启用旧即时卖家入账 writer。

撤回、封禁和策略变更使新 preview session 失败；client preview 资源仍可物理保留，但授权端不再签发 session。缓存 key 包含 listing/release/policy version，变更后定点失效。

## Security And Abuse Controls

- 匿名 catalog 仅返回审核安全投影并受 IP 限流。
- 登录、购买与 cloud trial 复用现有账户锁定、团队绑定和审计。
- Preview media 和 bundle 使用短期签名 URL；对象 key 不接受用户路径。
- Cloud trial 记录 requestId、user/team/package/release/action、配额决策和终态，不记录 secret 或完整大输出。
- CSP、iframe sandbox、opaque-origin 握手、一次性 nonce 与独立部署源都必须有负向 Playwright 测试；测试必须证明合法的 `origin === "null"` 可通过，而真实预览域 origin、错误 source、sessionId 或重放 nonce 均被拒绝。

## Compatibility

- Desktop catalog API 和 UI 不改语义；公共 Web 投影作为新端点增加。
- 现有 client 插件只有通过 preview compatibility 检查并重新审核 release 才获得 CLIENT_SANDBOX，默认降级 STATIC_DESKTOP。
- 现有 cloud 字段不自动获得试跑能力；作者必须在 action metadata 显式 previewable。
- collab-admin 保持平台管理入口，仅新增审核 preview media/bundle 状态所需视图。

## Rollout And Rollback

- WEB_PLUGIN_CENTER_ENABLED 控制新应用入口。
- CLIENT_PLUGIN_PREVIEW_ENABLED 与 CLOUD_PLUGIN_TRIAL_ENABLED 独立灰度。
- 首先只读匿名 catalog，再开放登录 overlay、client sandbox、cloud trial 与基于现有基础价格的 Milestone 2 购买。
- 市场结算与营销就绪后再独立灰度 Milestone 3 活动价、T+7 和退款投影；展示灰度可关闭为基础标价视图，但 settlement-v2 writer 切换后所有新付费订单仍走清算账本/T+7，不能回退 legacy writer。
- 回滚时关闭 preview flags 与 Web 入口；registry、entitlement 和桌面市场继续运行，已购买权益不回退。
