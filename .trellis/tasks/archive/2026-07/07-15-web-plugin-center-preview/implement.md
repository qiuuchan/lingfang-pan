# Web 插件中心与预览实施计划

## Preconditions

- [ ] 跨插件 action、ArtifactRef、`ActionInvocation(kind=PREVIEW)`、质量层级以及现有基础价格/购买 contract 已冻结；Milestone 2 不等待市场结算与营销 contract。
- [ ] 确认独立 Web origin 与 preview origin、CORS、CSP、cookie 和 CSRF 部署配置。
- [ ] 确认桌面 deep link 与当前发布下载投影。

## 1. Contract And Backend Read Models

- [ ] 在 @lingfang/contract 新增 PublicPluginCard、PluginDetail、Compatibility、PreviewMode、PreviewSession、CloudTrialProjection 与统一错误码；projection 导入 action owner 的 invocation status，不复制运行枚举。Milestone 2 价格字段使用现有基础价格和 opaque `priceVersion: string`，不暴露 internal priceRevision；Milestone 3 营销字段保持可选、可增量演进且不改 token 类型。
- [ ] 新增匿名 catalog/detail API，只投影 APPROVED + LISTED + PUBLISHED 数据。
- [ ] 新增登录 overlay API，返回服务端计算的 team entitlement、policy、balance 和 allowed operations。
- [ ] 为搜索、分类、runtime、质量、价格和 compatibility 增加分页/稳定排序查询与索引。
- [ ] 增加 contract round-trip、未审核字段泄漏、跨团队 overlay 和撤回缓存失效测试。

## 2. Web App Foundation

- [ ] 新建 apps/web workspace package，接入 React、Vite、Tailwind、ui-tokens、lucide 和 react-router-dom。
- [ ] 为新应用建立 .trellis/spec/web/frontend/index.md 与必要的 app shell、API/preview、UI 规范，并更新 Trellis spec layer 索引。
- [ ] 建立独立普通用户 session/team context、API decoder、401/403/409/429 错误边界和路由级 loading/error 状态。
- [ ] 实现 /plugins 与 /plugins/:packageId 的目录、筛选、详情、质量解释、价格、权益和兼容性布局。
- [ ] 保持工具型紧凑 UI，不复制 collab-admin 导航或桌面本机安装状态。

## 3. Web Session Security

- [ ] 增加普通用户 Web cookie session 入口，保持桌面 bearer API 兼容。
- [ ] 对变更请求实施 CSRF 校验，对认证 cookie 设置 HttpOnly/Secure/SameSite。
- [ ] 配置 Web CORS allowlist、Helmet/CSP 与生产 fail-close 检查。
- [ ] 测试 tokenVersion/teamContextVersion 变更后 cookie 会话失效。

## 4. Client Preview Pipeline

- [ ] 在 release 审核流程增加 client preview compatibility 检查和不可变 bundle 提取。
- [ ] 抽取通用对象存储 key，按 releaseId + sha256 服务资源，拒绝路径逃逸和未审核 bundle。
- [ ] 部署独立 preview origin 与 CSP/sandbox/frame-ancestors headers。
- [ ] 实现一次性 PreviewSession 握手：仅接受 `event.origin === "null"`、`event.source === iframe.contentWindow`、匹配 sessionId 和未消费 nonce；原子消费 nonce 后转移 session 专用 `MessagePort`，仅暴露 preview-safe capability。
- [ ] 增加 token/DOM/storage 读取、非白名单 capability、错误 source/sessionId、真实预览域 origin、nonce 重放的负向测试，并保留合法 `origin === "null"` 握手的正向测试。

## 5. Cloud Trial And Static Preview

- [ ] 增加 cloud trial API，原子执行每日 5 次/1 并发默认配额并支持平台配置，然后调用共享 `ActionInvocationService` 创建 `kind=PREVIEW` invocation。
- [ ] 以 PREVIEW principal 通过统一 invocation 状态机和 cloud adapter 执行，禁止 side-effect/shared write/schedule，输出 ArtifactRef 24 小时过期；不创建 PreviewRun 表或状态机。
- [ ] 实现试跑进度、取消、失败、配额耗尽和结果展示。
- [ ] 增加 listing preview media 上传/审核/读取投影。
- [ ] 实现 Node.js/Python 静态示例与 desktop deep link/download fallback。

## 6. Entitlement And Purchase

### Milestone 2: Basic Purchase

- [ ] 免费获取和付费购买复用 registry 与现有基础购买幂等事务，不接受前端价格；依赖已在 LEGACY writer 中实现 string token 校验的 dark commerce foundation，但不依赖 V2 writer、活动价、T+7 或退款服务。
- [ ] 页面在购买前重新加载 basePrice/`priceVersion: string`并提交 `expectedPriceVersion: string`；版本变化在任何业务写前返回 price changed并刷新，同时处理余额不足、重复购买和策略拒绝。
- [ ] 购买成功只更新 entitlement/余额视图；本地插件仍显示“在桌面端运行”。
- [ ] 在只部署 dark commerce foundation、writerMode=LEGACY 且未启用结算/营销的环境运行 Web 购买回归，证明 Milestone 2 可独立上线且资金行为不变。

### Milestone 3: Settlement And Marketing Integration

- [ ] 市场结算与营销 contract 冻结后，以可选字段接入 effectivePrice/campaign、T+7 卖家结算与 7 天退款状态。
- [ ] 活动价购买重新校验服务端 campaign/price version；Web 只提交命令，不计算活动结束、结算或退款资格。
- [ ] 增加活动结束、退款幂等、结算状态与关闭营销投影后回到基础标价 UI 的回归测试；断言 settlement-v2 writer 切换后基础价订单仍走清算/T+7，核心不可用时 fail-close 且 legacy writer 零调用。

## 7. Quality Gates

- [ ] Contract：pnpm -C packages/contract typecheck && pnpm -C packages/contract test
- [ ] API：pnpm -C apps/collab-api typecheck && pnpm -C apps/collab-api test -- --testTimeout=60000
- [ ] Web：pnpm -C apps/web typecheck && pnpm -C apps/web test && pnpm -C apps/web build
- [ ] Admin：pnpm -C apps/collab-admin typecheck
- [ ] Desktop：pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test
- [ ] Playwright 覆盖 1440x900、390x844 的目录/详情/购买/三类预览和安全负向用例。
- [ ] 对 client canvas/iframe 内容做截图与非空像素检查，确认没有空白预览、遮挡或越界。
- [ ] 运行 git diff --check，并检查没有预览 bundle、token、对象存储临时文件或构建产物进入提交。

## Review Gates And Rollback

- [ ] Gate A：公共投影和登录 overlay 完成安全评审后才接 UI。
- [ ] Gate B：client sandbox 负向测试通过后才开启 CLIENT_PLUGIN_PREVIEW_ENABLED。
- [ ] Gate C：cloud 配额、计费隔离和清理任务通过后才开启 CLOUD_PLUGIN_TRIAL_ENABLED。
- [ ] Gate D：Milestone 2 基础购买守恒与幂等测试通过后才在 Web 开启付费按钮，不等待完整市场结算与营销。
- [ ] Gate E：活动价、T+7、退款及展示回退测试通过后才独立开启 Milestone 3 营销结算投影；回退只影响展示/命令入口，不改变已切换的 settlement-v2 writer。
- [ ] 任一 preview 事故可独立关闭对应 feature flag；Web 目录回滚不影响桌面市场、权益或历史订单。
