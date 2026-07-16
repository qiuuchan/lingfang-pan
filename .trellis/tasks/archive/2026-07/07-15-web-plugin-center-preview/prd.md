# Web 插件中心与预览

## Goal

交付面向普通用户与团队成员的 Web 插件中心，使用户无需安装桌面端即可发现、评估和购买插件，并按 runtime 获得安全、明确的预览或桌面承接体验。

## User Value

- 未登录访客可以浏览公开市场、搜索插件并理解质量、价格和运行兼容性。
- 登录用户可以切换团队、查看权益、购买插件，并试跑支持 Web 的能力。
- 用户在购买前能够看到真实 UI、受限 cloud 输出或可信示例，而不是仅凭描述判断。

## Confirmed Facts

- 当前面向用户的插件中心只存在于桌面端，使用“已安装 / 团队库 / 插件市场”三类来源。
- apps/collab-admin 面向平台管理员，其规范明确不承担普通用户产品工作台。
- v4 package/release/listing/entitlement 与现有基础价格/购买事务是市场事实源，Web 不应建立第二套插件目录或购买状态。
- client 插件已有 opaque-origin iframe 沙箱经验；Node.js/Python 依赖桌面本地运行；cloud 尚需本计划其他子任务提供正式执行入口。

## Scope

### Web Catalog

- 新增独立的用户端 Web 应用，提供市场首页、搜索/筛选、分类、插件详情、版本与兼容性、质量层级、价格和作者信息。
- 公开已上架 listing 可匿名浏览；购买、权益、团队信息和 cloud 试跑要求登录。
- Web 与桌面共享 package/release/listing/entitlement、质量层级和服务端价格投影，不在前端推导业务状态。

### Runtime-Aware Preview

- client 插件在独立预览源的浏览器沙箱中运行，只获得预览白名单能力。
- cloud-capable 且显式标记 previewable 的 read-only/idempotent action，可由登录用户限额试跑。
- 仅本地 Node.js/Python 插件展示作者审核后的截图、短视频或样例输出，并提供打开/下载桌面端的明确入口。
- 预览、试跑和正式工作流运行在 UI、配额、审计与数据保留上明确区分。

### User Operations

- 登录用户可以查看当前团队余额、已有权益和适用团队策略。
- Milestone 2 中，免费插件直接获得权益，付费插件复用现有基础价格、购买与 entitlement 事务，并依赖不切换资金 writer 的 dark commerce foundation；该 foundation 已提供 opaque string priceVersion/expectedPriceVersion 的 LEGACY 事务校验。Web 上线不等待 settlement-v2 writer、活动价、T+7 或退款能力。
- Milestone 3 在市场结算与营销子任务就绪后，再以增量 contract 接入活动价、T+7 卖家结算和 7 天退款状态，不改变 Milestone 2 已有订单与权益语义。
- Web 不提供本地安装假象；需要本地执行的插件只触发桌面承接。

## Requirements

- Web 应用必须独立于 collab-admin 的平台管理员认证与导航边界。
- 所有公开接口只返回审核通过、可上架字段的轻量投影，不暴露 manifest 私有字段、制品路径或作者内部信息。
- 预览 iframe 必须使用独立部署源、严格 CSP 和不含 `allow-same-origin` 的受限 sandbox；其文档因此是 opaque origin。握手只接受 `event.origin === "null"`、`event.source === iframe.contentWindow`、匹配的 preview `sessionId` 与尚未使用的一次性 nonce，成功后立即消费 nonce；不得按预览域真实 origin 放行，也不得获得父页面 DOM、认证 token 或同源存储。
- client 预览只能调用显式 preview-safe 能力；文件系统、剪贴板、系统通知、共享数据写入、购买和发布能力不可用。
- cloud 试跑默认每用户每日 5 次、最多 1 个并发，数值由平台配置；输出制品默认保留 24 小时。
- cloud 试跑必须创建 `ActionInvocation(kind=PREVIEW)`，复用统一 invocation 状态机、团队策略、权益、精确 release、action schema 和 ArtifactRef 校验，但不得写团队共享 KV、创建定时任务或建立第二套 preview run 账本。
- 本地插件详情必须显示支持的桌面平台、runtime 与最低客户端版本；桌面不可用时不展示无效运行按钮。
- 搜索、分类、质量、价格、runtime 和兼容性筛选需要可复制 URL，支持分页和稳定排序。
- 页面必须覆盖加载、空结果、未登录、无团队、无权益、配额耗尽、预览不兼容、release 撤回和网络失败状态。
- 桌面与移动视口均可完整浏览、购买和查看预览结果；键盘导航、焦点、对比度和可访问名称通过检查。

## Acceptance Criteria

- [ ] 新用户端 Web 应用与 collab-admin 分离构建、部署和鉴权，普通用户无法进入平台管理接口。
- [ ] 匿名用户可浏览、搜索和筛选公开已上架插件，未审核或下架 release 不出现在任何公开响应。
- [ ] Milestone 2 登录用户可切换团队并看到服务端返回的基础价格、余额、权益和策略结果，不依赖活动价、T+7 或退款能力。
- [ ] Milestone 3 接入前，Milestone 2 的购买和权益流程可独立运行；settlement-v2 writer 切换后，关闭营销展示只回到基础标价 UI，任何新付费订单仍走 settlement-v2，结算核心不可用时 fail-close 而不回退 legacy writer。
- [ ] client 预览在独立部署源的 opaque-origin 沙箱中运行；合法握手仅在 `origin === "null"`、source、sessionId 和一次性 nonce 同时匹配时成功，且无法读取父页面 token/DOM/storage 或调用非预览白名单能力。
- [ ] previewable cloud action 受每日/并发配额约束，以 `ActionInvocation(kind=PREVIEW)` 运行，结果与正式 invocation 隔离且 24 小时后可清理；Web 只消费投影，不拥有平行状态机。
- [ ] Node.js/Python 本地插件只展示静态示例和桌面承接，不在浏览器执行，也不显示误导性的 Web 运行按钮。
- [ ] Milestone 2 的免费获取与付费购买复用既有基础价格、entitlement 与购买事务；重复请求幂等，余额不足和策略拒绝有明确错误。
- [ ] M2 catalog/购买只收发 opaque string priceVersion/expectedPriceVersion，内部 Int priceRevision 不进入响应；LEGACY 事务遇到版本变化在任何业务写前返回 marketplace_price_changed 并刷新，Web 不提交或计算金额。
- [ ] Milestone 3 的活动价、T+7 和 7 天退款复用市场结算与营销服务，且不在 Web 前端自行计算价格或账本状态。
- [ ] release 被撤回、封禁或不再兼容后，新预览立即被拒绝，已打开页面刷新到可解释状态。
- [ ] Playwright 覆盖桌面与移动视口的目录、详情、登录、购买、三类预览分流、配额和安全边界。
- [ ] contract、collab-api、Web typecheck/build/test 以及相关桌面市场回归通过。

## Dependencies

- 跨插件 Action 调用：action schema、previewable/side-effect metadata、ArtifactRef、精确版本门禁与 `ActionInvocation(kind=PREVIEW)` 状态机。
- 团队插件策略与治理：Web 预览和购买的策略决策。
- Cloud 插件与定时自动化：cloud PREVIEW 运行与配额。
- 市场质量与推荐：三层质量与推荐投影。
- 现有市场基础能力 + dark commerce foundation：Milestone 2 复用基础价格、购买、权益和余额，并要求 additive priceVersion/expected version 校验；不要求启用 V2 writer。
- 市场结算与营销：不是 Milestone 2 前置；仅用于 Milestone 3 增量接入活动价、T+7 卖家结算和 7 天退款。

## Out of Scope

- 在 Web 端创建或编辑插件/工作流。
- 在浏览器或平台上执行任意上传的 Node.js/Python 代码。
- Web 端模拟本机安装、文件系统或桌面专属能力。
- 个性化推荐、评论社区、直播演示或多人共同操作预览。

## Decisions

- 新建独立用户端 Web 应用，不扩展 collab-admin 为混合壳。
- client 使用独立部署源上的 opaque-origin 沙箱；cloud 使用登录限额试跑；本地脚本插件只做静态示例与桌面承接。
- 公开浏览匿名开放，产生权益、费用或计算资源的操作必须登录并绑定团队。
- Milestone 2 先基于现有基础价格/购买交付完整 Web 发现与购买；Milestone 3 再增量接入营销和结算，不形成反向依赖。
