# 审计维度 1

# lingfang-platform 用户全旅程完整性审计（产品经理视角）

## 一、用户全旅程路径评估

### 核心旅程：注册 → 加入团队 → AI 生成 → 预览 → 发布市场

**已打通的主路径（通路）**
- 注册（`Auth.tsx`）→ onboarding 状态机（`auth.service.ts:100` `resolveOnboarding`：NEEDS_INVITATION / PENDING_APPROVAL / APPLICATION_REJECTED / TEAM_SPACE / TEAM_ADMIN_SPACE / PLATFORM_ADMIN_WEB_ONLY）→ 邀请码兑换（`Onboarding.tsx:20` `redeem`）→ 进入 `TeamHome`。
- 创建插件（`PluginCreatorHome.tsx`）→ 对话生成 → sandbox 扫描 / 围栏块解析（`finalizeSession`，第 326 行）→ 预览大窗（`PreviewDrawer`）→ 上传团队共享（`uploadCloud`，第 860 行）→ 提交市场审核（`submitMarketplace`，第 882 行）。
- 后端 `plugin.service.ts` 覆盖 upload / mine / available / submit-marketplace / edit-draft / install；`marketplace.service.ts` 覆盖 search / detail / install / rate；`economy.service.ts` 覆盖 wallet / purchase。审核闭环在 `Review.tsx` + `admin.service.ts:adminApprovePlugin/adminRejectPlugin`。

**旅程中的真实断裂点（见下方严重度分级）**

---

## 二、按严重度列缺口 + 补齐建议

### P0 — 阻断型（直接卡死或伤害用户）

**1. 「注册即孤儿」死路：注册后没有团队就完全无法使用平台**
- 位置：`auth.service.ts:resolveOnboarding` → `NEEDS_INVITATION`；`Onboarding.tsx:98`。
- 现状：注册成功 toast 写「请输入团队邀请码」，但邀请码必须由「团队管理员」在 `TeamManage.tsx` 生成。普通用户根本没有获取邀请码的入口（无公开团队列表、无申请加入团队按钮、无联系方式）。若该用户勾选「我是团队管理员」，进入 `PENDING_APPROVAL`，平台管理员不审批就永远卡住。
- 商业影响：新用户注册后大概率流失——他们既拿不到邀请码，也等不到审批。这是「冷启动鸡生蛋」问题。
- 建议：
  - 增加「公开团队发现页」：列出 ACTIVE 且开放加入的团队，用户可一键申请加入（无需邀请码）。
  - 或允许平台管理员在创建用户时直接分配团队（admin.users.create 后台已有，但需在创建流程内集成）。
  - `PENDING_APPROVAL` 状态需 SLA（如 48 小时未审批自动通知），并在 Onboarding 页显示「预计审批时间」「联系平台」入口。

**2. 「无引导式新手教程」：用户首屏没有任何 onboarding tour**
- 位置：`PluginCreatorHome.tsx:984` 空状态只有 4 个 example 按钮（点击填入输入框），无分步引导。
- 现状：首次进入 `home` 视图，看到「今天想创建什么插件？」+ 4 个示例。但用户不知道：①需先去「设置 → CLI 与运行环境」装 CLI；②需在「设置 → 模型服务」填 API Key；③需要先加入团队才能上传。
- 关键门槛：`Settings.tsx` 的三 Tab（cli/gateway/backend）对普通用户过高——winget 安装、API 密钥、后端地址全是技术概念。
- 建议：
  - 首次登录后弹「新手任务清单」（5 步：装 CLI / 配模型 / 发起首条对话 / 预览 / 上传），完成打勾，全程引导跳转。
  - CLI/模型配置缺失时，在 `Composer` 上方挂「环境未就绪」横幅 + 一键跳转设置（现在 send 失败才 toast，用户不知道为什么失败）。
  - 提供示例插件的「一键运行 demo」：预置一个内置插件让新用户立即看到产品价值（现在内置插件仅在 `Plugins` 页，未在首屏引导）。

**3. 「找回密码 / 邮箱验证」完全缺失**
- Grep `forgot|reset-password|忘记密码|verification|verify-email` 全仓 0 命中。
- 现状：`Auth.tsx` 只有 login/register，密码忘了无法找回；注册不验证邮箱真实性（任何字符串都能注册）；`admin.service.ts:adminCreateUser` 默认密码 `ChangeMe123!` 但无强制首次登录改密。
- 商业影响：密码丢失 = 账号作废；邮箱不验证 = 垃圾注册、无法联系用户、找回失效。
- 建议：
  - SMTP 邮件服务 + 忘记密码流程（发重置链接）。
  - 注册后邮箱验证（未验证账号 7 天后清理）。
  - 管理员创建用户强制首登改密。

---

### P1 — 体验断层型（能用但严重伤害留存）

**4. 「AI 生成失败兜底」对非技术用户不友好**
- 位置：`creator-error.ts`（错误分类表）+ `PluginCreatorHome.tsx` finalizeSession 的 catch。
- 现状：错误分类做得不错（cli_start_failed / transcript_failed / interpreter_missing 等），但：
  - 错误详情仍偏技术（如「Node.js 插件需要 Node（≥18）」），普通用户不知道怎么处理。
  - 没有「联系支持」按钮，没有错误 ID 供反馈。
  - 没有「生成失败次数 / 成功率」指标采集——产品团队无法量化 AI 生成质量。
  - 多轮降级提示（`multiturnMode === 'degraded'`）显示「多轮能力有限」——对用户是黑话。
- 建议：
  - 错误卡片增加「一键复制错误信息」「联系支持」按钮。
  - 后端记录每次 CLI session 的 exit_code / duration / 是否产出 manifest，做生成成功率看板（admin 端）。
  - 降级提示改为人话：「当前模型在该对话中可能遗忘部分上下文，建议新开对话重述需求」。

**5. 「插件质量与成功率的可观测性」缺失**
- 位置：admin 端 `dashboard.tsx` 只统计 users/teams/pendingApplications/enabledPlugins/disabledPlugins/pendingPluginReviews。
- 现状：没有「AI 生成成功率」「平均生成耗时」「插件被运行次数」「插件卸载/差评率」等业务指标。产品经理无法判断核心价值是否成立。
- 建议：admin Dashboard 新增「生成质量」区块：成功率、平均轮数、失败 top 原因、热门 prompt。

**6. 「市场内容稀薄」：详情页信息密度低**
- 位置：`Market.tsx:184` Detail 组件。
- 现状：详情只有 name / version / description / 价格 / 评分 / capabilities badges / reviews。没有：截图、演示视频、更新日志、作者信息、使用文档链接、依赖说明、版本对比。
- 商业影响：付费插件转化率会很低——用户凭什么付钱买一个只有一句话描述的插件？
- 建议：
  - 插件 manifest 扩展 `screenshots` / `demoUrl` / `readme` 字段。
  - 详情页增加「作者」「更新历史」「相关插件」。
  - 审核流程要求作者提供截图/演示。

**7. 「钱包只能看不能充值」**
- 位置：`Wallet.tsx`（纯展示 balance + transactions）；`economy.service.ts` 只有 `ensureWallet`（注册赠 ¥10）+ `purchase`，无 `topup` / `withdraw`。
- 现状：用户余额用完无法补充，钱包形同摆设；作者卖出插件的收入无法提现。
- 商业影响：整个付费闭环不成立——用户买不了、作者赚了也拿不到钱。
- 建议：
  - 接入支付（微信/支付宝）充值；
  - 提现流程（作者申请 → 平台审核 → 打款）；
  - 至少先做「平台管理员手动调整用户钱包」（admin 端目前只能调团队余额，不能调个人钱包）。

---

### P2 — 角色体验不完整型

**8. 「团队管理员」体验单薄**
- 位置：`TeamManage.tsx`。
- 现状：只能生成邀请码 / 移除成员 / 看流水。缺少：成员角色管理（升级/降级副管理员）、成员活跃度、团队配额管理、团队插件审核（团队内 PRIVATE 插件谁来批？）、团队公告。
- 建议：扩展 TeamManage，增加成员详情、团队设置、配额管理。

**9. 「平台管理员」审核流程过于简陋**
- 位置：`Review.tsx`（桌面端）+ `plugins-view.tsx`（admin 端）。
- 现状：审核只看 name/version/description/price/ID，**看不到插件源码、无法试运行、无法预览 UI**。审核员凭什么判断插件安全/合规？
- 建议：审核详情页内嵌「源码查看 + 沙箱试运行 + capability 审查清单」。

**10. 「平台管理员」无插件下架流程**
- 位置：`plugin.service.ts:editPluginDraft` 禁止作者下架已 APPROVED 插件（注释 PLUGIN-04），需「联系平台管理员」。但 admin 端 `adminUpdatePlugin` 只能改 status=DISABLED（治理），**没有专门的「下架市场」动作**（marketplace=false + reviewStatus 重置）。
- 建议：admin 端增加「下架市场」按钮，原子置 marketplace=false + visibility=TEAM + 审计 + 通知作者。

---

### P3 — 易用性与商业成熟度

**11. 「反馈渠道 / 帮助文档」完全缺失**
- Grep `帮助|反馈|教程|feedback|help` 在 desktop 业务页 0 命中（仅 protocol 注释提到「引导」）。
- 现状：无帮助中心、无反馈入口、无 FAQ、无客服联系方式。Sidebar 8 个导航项无一指向帮助。
- 建议：Sidebar 增加「帮助」入口（FAQ + 视频教程 + 联系支持）；每页加「反馈」浮动按钮。

**12. 「后端地址配置」是反人类的**
- 位置：`Auth.tsx:129` + `Settings.tsx:273`。
- 现状：要求用户手动输入 `http://127.0.0.1:3000` 或 `https://api.example.com`。普通用户根本不知道后端地址是什么。
- 建议：客户端内置默认生产地址（打包时注入）；仅在企业私有部署场景才需手动配置（隐藏在「高级设置」）。

**13. 「多端一致性」缺失**
- 现状：只有 Windows 客户端（`CliRuntimeTab` 注释「仅 Windows 支持自动安装」），macOS/Linux 用户被排除。落地页 `DownloadPage` 虽展示三平台卡片，但实际 macOS/Linux 的 CLI 安装是「Unsupported」。
- 建议：补齐 macOS（brew）/Linux（apt/snap）的 CLI 安装脚本，或明确标注「仅支持 Windows」。

**14. 「数据导出 / 账号注销」缺失（GDPR/合规）**
- Grep 无 export / delete-account / 数据导出。
- 现状：用户无法导出自己的插件/对话/流水；无法自助注销账号（只能联系管理员 DISABLE）。
- 建议：增加「导出我的数据」「注销账号」入口（合规要求）。

**15. 「通知系统」缺失**
- 现状：审核通过/驳回、插件被购买、团队邀请等关键事件，用户只能主动刷新页面才知道。无站内消息、无邮件通知、无桌面通知。
- 建议：站内消息中心 + 关键事件邮件推送。

---

## 三、核心价值（AI 生成插件）可用性判断

**技术上可用，但商业上存疑：**
- 协议设计扎实（`plugin-creator-protocol.ts`：manifest/file/notes 围栏块 + sandbox 扫描双路径）。
- 错误处理细致（`creator-error.ts` 11 种 kind + retryable 标记 + `PluginCreatorHome` 多处 bug 修复注释）。
- **但**：成功率无量化、质量无保障（依赖外部 CLI 的能力）、失败后无人工兜底（没有「联系工程师帮你生成」选项）、生成结果无质量评分机制。作为商业产品的「核心卖点」，目前是「能用但不保证好用」。

---

## 四、优先级补齐路线图建议

| 优先级 | 缺口 | 预估工作量 | 商业价值 |
|--------|------|-----------|---------|
| P0-1 | 公开团队发现 / 注册即孤儿 | 中 | 解锁冷启动 |
| P0-2 | 新手引导教程 + 环境就绪检测 | 中 | 提升首日留存 |
| P0-3 | 找回密码 + 邮箱验证 | 中 | 账号安全基线 |
| P1-4 | AI 生成成功率看板 + 错误反馈通道 | 中 | 量化核心价值 |
| P1-6 | 市场详情页富化（截图/文档/作者） | 中 | 提升付费转化 |
| P1-7 | 钱包充值 + 提现 | 大 | 闭环商业化 |
| P2-9 | 审核流程增强（源码+试运行） | 中 | 平台治理 |
| P3-11 | 帮助中心 + 反馈渠道 | 小 | 降低支持成本 |
| P3-12 | 后端地址默认化 | 小 | 降低使用门槛 |
| P3-15 | 通知系统 | 大 | 提升活跃 |

**最关键的三件事**（若只能做三件）：①解决「注册即孤儿」（否则用户进不来）；②新手引导 + 环境检测（否则进来了也用不起来）；③AI 生成成功率量化（否则无法证明核心价值、无法迭代优化）。

相关文件路径（绝对路径）：
- `O:\lingfang-platform\apps\desktop\src\pages\Auth.tsx`
- `O:\lingfang-platform\apps\desktop\src\pages\Onboarding.tsx`
- `O:\lingfang-platform\apps\desktop\src\pages\PluginCreatorHome.tsx`
- `O:\lingfang-platform\apps\desktop\src\pages\Settings.tsx`
- `O:\lingfang-platform\apps\desktop\src\pages\Market.tsx`
- `O:\lingfang-platform\apps\desktop\src\pages\Wallet.tsx`
- `O:\lingfang-platform\apps\desktop\src\lib\creator-error.ts`
- `O:\lingfang-platform\apps\desktop\src\lib\plugin-creator-protocol.ts`
- `O:\lingfang-platform\apps\desktop\src\App.tsx`
- `O:\lingfang-platform\apps\collab-api\src\modules\auth.service.ts`
- `O:\lingfang-platform\apps\collab-api\src\modules\team.service.ts`
- `O:\lingfang-platform\apps\collab-api\src\modules\plugin.service.ts`
- `O:\lingfang-platform\apps\collab-api\src\modules\marketplace.service.ts`
- `O:\lingfang-platform\apps\collab-api\src\modules\economy.service.ts`
- `O:\lingfang-platform\apps\collab-api\src\modules\admin.service.ts`
- `O:\lingfang-platform\apps\collab-admin\src\components\dashboard.tsx`
- `O:\lingfang-platform\apps\collab-admin\src\components\plugins-view.tsx`
- `O:\lingfang-platform\apps\collab-admin\src\components\applications-view.tsx`

---
# 审计维度 2

我现在已经掌握了撰写一份全面的技术审计报告所需的一切资料。让我来整理一下调研结果。

---

# lingfang-platform 技术完整性与健壮性审计报告

按严重度（Critical / High / Medium / Low）列出缺口，每条附依据与补齐建议。

---

## 1. 后端 collab-api 错误处理 / 日志 / 监控 / 限流

### [HIGH] 完全缺失请求限流（Rate Limiting）
- **依据**：全仓搜索 `Throttle|RateLimit|@nestjs/throttler` 零命中。`main.ts` 未引入任何限流中间件。
- **风险**：`POST /api/auth/register`、`POST /api/auth/login` 无限流 → 暴力破解密码、撞库、注册轰炸。`POST /api/wallet/purchase` 无限流 → 并发竞态窗口虽被事务保护，但可被高频请求放大 DB 负载。`POST /api/plugins/upload`（2MB body）无限流 → 磁盘/DB 耗尽。
- **建议**：引入 `@nestjs/throttler`，对 auth 端点设严格限流（如 login 10次/分钟/IP），对写操作设中等限流。关键路径（register/login/purchase/upload）单独覆盖。

### [HIGH] 无结构化日志（Structured Logging）
- **依据**：全仓搜索 `Logger|Winston|Pino|morgan|nestjs-pino` 零命中。`main.ts` 仅用 `console.warn`，业务 service 无任何日志。
- **风险**：生产故障无法追溯。`AppExceptionFilter` 的 500 分支只返回泛化 `internal_error`，服务端无任何记录（无 stack trace、无请求上下文）。审计日志（AuditLog）只记录业务操作，不记录系统错误。
- **建议**：引入 `nestjs-pino`（pino + request-id 中间件），在 `AppExceptionFilter` 的 500 分支记录完整 error + stack + requestId。对 auth/purchase/upload 等关键端点记录 access log。

### [MEDIUM] 无健康度深度检查（Readiness/Liveness Probe）
- **依据**：`health.controller.ts:13` 仅返回 `{status:'ok', version}`，不检查 DB 连通性。
- **风险**：DB 宕机时 health 仍返回 ok，负载均衡器不会摘除节点。
- **建议**：health 端点增加 `prisma.$queryRaw('SELECT 1')` 探活，DB 失败时返 503。区分 `/health`（liveness，进程存活）与 `/health/ready`（readiness，依赖就绪）。

### [MEDIUM] 无 APM/指标采集（Metrics）
- **依据**：无 prom-client / opentelemetry / datadog 集成。
- **风险**：无法观测 P99 延迟、错误率、DB 慢查询。
- **建议**：引入 prometheus 或 opentelemetry，至少暴露 `/metrics` 端点供 Prometheus 抓取。

---

## 2. 数据库 Schema 与迁移

### [MEDIUM] 迁移 `20260614154734_llm_single_provider` 是破坏式 DDL，无回滚脚本
- **依据**：`apps/collab-api/prisma/migrations/20260614154734_llm_single_provider/migration.sql` 直接 `DELETE FROM "TenantLlmBinding"` + `DROP COLUMN` + `DROP CONSTRAINT`。注释自承「首版无生产数据，删旧 binding 重建最简（破坏式，不向后兼容）」。
- **风险**：若已有生产数据（用户已填 apiKey），此迁移会清空所有绑定且不可逆。后续若 schema 再变，无 down migration 回退。
- **建议**：Prisma 原生不支持 down migration，但应在迁移注释中标注「破坏式」并在 release notes 明确告知。对生产环境增加数据备份脚本（pg_dump）作为迁移前置步骤。

### [MEDIUM] 缺少部分高频查询的复合索引
- **依据**：`schema.prisma` 中：
  - `WalletTransaction` 有 `@@index([userId, createdAt])` 但 `Purchase` 表的 `sellerUserId` 无独立索引（只有 `@@index([buyerUserId])`），卖家收入查询（`findMany({where:{sellerUserId}})`）会全表扫。
  - `PluginRating` 有 `@@index([pluginId])` 但无 `(pluginId, createdAt)` 复合索引，`marketplace.service.ts:54` 按 `createdAt desc take 50` 取评论会回表排序。
  - `AuditLog` 无 `(action, createdAt)` 索引，按 action 类型筛选审计日志会全表扫。
- **风险**：数据量增长后查询变慢。
- **建议**：为 `Purchase(sellerUserId)`、`PluginRating(pluginId, createdAt)`、`AuditLog(action, createdAt)` 补索引。当前数据量小影响有限，但应在正式上线前补齐。

### [LOW] `Plugin.files` / `manifest` / `capabilities` 用 Json 列存大对象，无单独存储
- **依据**：`schema.prisma:228-229` `files Json @default("[]")` + `manifest Json @default("{}")`，插件源码全量存 DB JSON 列。
- **风险**：单插件 2MB 上限（`MAX_PLUGIN_TOTAL_BYTES`），大量插件时 `plugin` 表行均很大，全表扫描（如 `availablePlugins`、`search`）会把大 JSON 拖入内存。Postgres 的 TOAST 会压缩外存，但查询时仍需解压。
- **建议**：中长期考虑把 `files` 拆到对象存储（S3/MinIO），DB 只存 URL + contentHash。短期可接受（插件数量预期不大）。

---

## 3. 桌面 Rust 并发 / 资源管理 / 进程清理

### [已处理 - 良好] 进程组/进程树清理已修复
- `code_assistant.rs` 的 `kill_child_tree` 已覆盖 Unix（kill -PGID）与 Windows（taskkill /T）两平台杀整棵进程树。`SPAWN-01/02/05/06` 系列修复完整，包括：send_input 先杀旧 child 再 spawn 新的、waiter 用 Arc::ptr_eq 防 map 误删、reader join 防 output 丢失、try_wait Err 分支也回收。
- `plugin_script.rs` 的 sandbox LRU 清理（保留最近 8 个目录）+ `sanitize_plugin_id` 段级白名单已防穿越删除。

### [MEDIUM] `CURRENT_INSTALL` 全局 Mutex<Option<Child>> 是死代码，cancel_install 实际无效
- **依据**：`cli_installer.rs:44` `static CURRENT_INSTALL: Mutex<Option<Child>> = Mutex::new(None)`，但 `run_install` 内部 `run_capture_with_env` 自己 spawn child 不外露句柄，`CURRENT_INSTALL` 从未被赋值。`cancel_install`（行 664）take 出的永远是 None。
- **风险**：`cancel_install` 命令实际无法中断 winget 安装，用户点取消只能等 300s 超时。注释自承「首版简化...TODO 改造 run_captured_inner 暴露 child 句柄」。
- **建议**：改造 `run_captured_inner` 返回 Child 句柄（或在闭包中暴露），`run_install` spawn 后立即 `CURRENT_INSTALL.lock().replace(child)`，cancel 时 take + kill_child_tree。

### [MEDIUM] `AssistantStore` 并发写用 Mutex 串行化，但长持有锁可能阻塞 UI 命令
- **依据**：`store.rs:117-120` 注释说明此前无锁导致并发 RMW 丢更新，已修复为 Mutex 保护。但 `append_transcript` / `upsert_session` 等持有全局锁做文件 IO（read JSON + write JSON），`spawn_reader`（stdout/stderr 两个线程）+ `spawn_waiter`（一个线程）+ 命令线程可能竞争同一锁。
- **风险**：高频 output 行（claude 流式输出）时，每个 append_transcript 都 lock → read → write → unlock，reader 线程串行化可能导致 output 事件延迟到达前端（实际已被 waiter 的 join reader 兜底，但延迟仍存在）。
- **建议**：可接受（单会话输出频率不高），但若用户开多个会话并行（processes 是 HashMap<String, ...>），全局锁会成为瓶颈。可改为按 session_id 分片锁（每会话独立锁）。

---

## 4. 前端状态管理 / 路由 / 错误边界

### [已处理 - 良好] 桌面端有 ErrorBoundary + 会话恢复容错
- `main.tsx:12` `RootErrorBoundary` 覆盖整棵树，`componentDidCatch` 记录 console + 提供重置按钮。
- `App.tsx` 的 session 恢复逻辑完善：`sessionFromPayload` 校验 user 字段防畸形响应，401 全局事件派发，localStorage 配额满提示，启动 fetch 超时 5s。
- `App.tsx:170` sessionRef + 函数体内副作用（非 updater 内）修复了 React StrictMode 双调问题。

### [HIGH] 桌面端无路由库，状态机式 view 切换无 URL 持久化
- **依据**：`App.tsx:156` `useState<View>('home')` 管理 view，无 react-router。刷新/深链接无法直达特定页。
- **风险**：桌面端影响较小（Tauri 不刷新），但若未来转 web 或需要分享链接，无路由会成阻碍。
- **建议**：桌面端可接受（无刷新场景）。若转 web 需引入 react-router。

### [MEDIUM] 管理后台（collab-admin）无 ErrorBoundary
- **依据**：`apps/collab-admin/src/App.tsx` 无 `componentDidCatch` / `ErrorBoundary`。全仓搜索 `ErrorBoundary` 仅 desktop 有。
- **风险**：admin 页面任一组件渲染抛错 → 白屏，管理员无法自救。
- **建议**：为 collab-admin 顶层加 ErrorBoundary（可复用 desktop 的 RootErrorBoundary 模式）。

### [LOW] 桌面端无 React Suspense / 数据加载边界
- 各页面（Plugins/Market/Wallet）自行 fetch + try/catch toast，无统一的 Suspense + ErrorBoundary 组合。
- **建议**：非阻塞，当前 toast + ErrorBoundary 已够用。

---

## 5. 跨端契约一致性（contract 包 vs 实际端点）

### [MEDIUM] contract 包大量声明为「dead schema」，未真正用于运行时校验
- **依据**：`packages/contract/src/identity.ts:33` 注释「HTTP 响应契约当前为 dead schema（无运行时消费者），声明意图仅是对齐未来可能的客户端校验」。`AuthSession` 等 zod schema 定义了但前端未 `safeParse` 后端响应。
- **风险**：后端 DTO 变更（增删字段）不会触发前端编译错误，契约漂移无编译期保护。
- **建议**：在关键端点（auth/me、llm/binding、llm/active-provider）的 API 调用处用 `zod.safeParse` 校验响应，运行时捕获契约漂移。至少在 dev 模式下 `console.error` 提示。

### [MEDIUM] `marketplace.service.ts` 出参用 snake_case，与 contract 包约定的 camelCase 不一致
- **依据**：`marketplace.service.ts:39-44` 返回 `install_count`、`price_cents`、`is_free`、`avg_score`（snake_case），而 `plugin-package.ts:181` 的 `publicPlugin` 返回 `installCount`、`priceCents`（camelCase）。`identity.ts:6` 注释明确「HTTP 响应...一律 camelCase」。
- **风险**：前端需处理两套字段命名（marketplace 列表用 snake_case，plugin detail 用 camelCase），易混淆。
- **建议**：统一 marketplace 出参为 camelCase（`installCount` 等），与 `publicPlugin` 对齐。

### [LOW] contract 包的 `TenantRole` 与后端 `TeamRole` 枚举值不一致
- **依据**：`identity.ts:10` `TenantRole = z.enum(['owner','admin','developer','member'])`，但 `schema.prisma:25` `TeamRole { TEAM_ADMIN, MEMBER }`。contract 有 4 值，DB 只有 2 值。
- **风险**：contract 的 dead schema 误导（注释说是 manifest 边界用，但前端可能误用）。
- **建议**：清理 contract 中过时的枚举，或明确标注仅用于 manifest 权限声明（与 DB 的 TeamRole 无关）。

---

## 6. 测试覆盖率

### [HIGH] 后端无集成测试（e2e），仅单元测试覆盖 service 层
- **依据**：`apps/collab-api/**/*.spec.ts` 共 6 个文件 61 个测试，覆盖 plugin-package（归一化）、llm.service（mock prisma）、release.service（mock prisma）、credential-cipher（加解密）、collab.service、plugin.service。但无 `*.e2e-spec.ts`，无 controller 层 + 真实 DB 的集成测试。
- **风险**：鉴权链（JWT → JwtAuthGuard → ensurePlatformAdmin）、事务原子性（purchase/activate）、并发安全（redeemInvitation 原子扣减）未端到端验证。DTO 的 ValidationPipe（whitelist/forbidNonWhitelisted）未在真实 HTTP 层验证。
- **建议**：引入 supertest + testcontainers（PostgreSQL），至少覆盖：register→login→me 全链路、purchase 余额扣减+分成、plugin upload→submit→approve→install、llm binding upsert→decrypt。关键鉴权链（普通用户访问 admin 端点应 403）必须有 e2e。

### [HIGH] 前端测试极少，无组件测试
- **依据**：`apps/desktop/src/**/*.spec.ts` 仅 4 个文件（plugin-draft、plugin-creator-protocol、creator-error、plugin-draft-streaming），都是 lib 工具函数测试。无 React 组件测试（无 `@testing-library/react`），无页面级测试。
- **风险**：关键交互流程（PluginCreator 多会话状态机、Settings 页 CLI 配置注入、PluginPreview 大窗）无回归保护。
- **建议**：优先为 PluginCreator 状态机（start_session → output → exit → send_input 多轮）和 Settings 页（backendUrl/apiKey 配置）补组件测试。

### [MEDIUM] Rust 测试覆盖良好，但缺少并发场景测试
- **依据**：Rust 侧 115 个 `#[test]`，覆盖纯函数（sanitize/parse/serde）+ 带解释器实跑（node/python）+ sandbox LRU + timeout 杀进程树。但 `code_assistant.rs` 的 `spawn_and_attach` / `send_input` 多轮状态机无集成测试（需 mock CLI 二进制）。
- **建议**：可接受（状态机逻辑通过 SPAWN-01/02/06 修复注释已人工验证），但长期应有 mock CLI 的集成测试。

---

## 7. 性能瓶颈

### [MEDIUM] marketplace search 按 rating 排序时拉取 200 条到应用层排序
- **依据**：`marketplace.service.ts:27` `const take = sort === 'rating' ? 200 : 50`，然后 `mapped.sort((a,b) => b.avg_score - a.avg_score)` 应用层排序。
- **风险**：Postgres 无法直接对 `ratingSum/ratingCount` 表达式 orderBy（注释说明），取 200 条到内存排序。插件数超 200 时 rating 排序不准确（只排前 200）。
- **建议**：增加冗余列 `ratingAvg Float`（upsert 时计算并存储），建索引 `(marketplace, reviewStatus, status, ratingAvg desc)`，让 DB 直接排序。或用物化视图。

### [MEDIUM] `adminTeams` 无分页，一次性 include 全部成员
- **依据**：`admin.service.ts:88-97` `prisma.team.findMany` 无 take 限制，`include: { memberships: { where: { status:'ACTIVE' }, include: { user: true } } }`。
- **风险**：团队数或成员数增长时，单次查询拉取全量 + N+1（每 membership include user）。当前 `adminUsers` 有 `take: 200`，但 teams 无。
- **建议**：teams 查询加分页（cursor 或 offset），memberships include 限制 take。

### [MEDIUM] 长会话 transcript 无限增长，read_transcript 全量读取
- **依据**：`store.rs` 的 transcript 是 `append` 模式（每行 JSON），`read_transcript` 全量 `read_to_string`。`build_history_summary`（伪多轮）也全量读再过滤。
- **风险**：长会话（数百轮交互）transcript 文件可达数 MB，每次 send_input 全量读取解析历史。前端 read_transcript 也全量加载。
- **建议**：transcript 支持分页读取（offset + limit 按 JSONL 行）。历史摘要用增量缓存（只读上次 input 后的 output），避免全量重算。

### [LOW] 插件上传 2MB body limit 与 DB Json 列存储的组合
- **依据**：`main.ts:48` `json({ limit: '2mb' })`，`plugin-package.ts:47` `MAX_PLUGIN_TOTAL_BYTES = 2*1024*1024`。单插件包 2MB 全量存 DB Json。
- **风险**：高并发上传时 DB 写入压力（2MB * N 并发）。
- **建议**：可接受（MVP 阶段），长期拆对象存储。

---

## 总结优先级矩阵

| 严重度 | 缺口 | 建议动作 |
|--------|------|----------|
| **Critical** | 无 | （无致命缺陷，核心安全/并发已修复） |
| **High** | 无限流 | 引入 @nestjs/throttler，auth 端点严格限流 |
| **High** | 无结构化日志 | 引入 nestjs-pino，500 分支记录 stack |
| **High** | 后端无 e2e 集成测试 | supertest + testcontainers 覆盖鉴权链/事务 |
| **High** | 前端无组件测试 | PluginCreator 状态机 + Settings 页测试 |
| **Medium** | 迁移破坏式无回滚 | 生产迁移前 pg_dump + release notes 标注 |
| **Medium** | 索引缺失 | 补 Purchase/Rating/AuditLog 索引 |
| **Medium** | cancel_install 无效 | 改造 run_captured_inner 暴露 child 句柄 |
| **Medium** | contract dead schema 无运行时校验 | 关键端点 safeParse 响应 |
| **Medium** | marketplace snake_case 不一致 | 统一 camelCase |
| **Medium** | health 无 DB 探活 | 加 prisma.$queryRaw('SELECT 1') |
| **Medium** | admin teams 无分页 | 加 cursor/offset 分页 |
| **Medium** | rating 排序取 200 条应用层排 | 加 ratingAvg 冗余列 + 索引 |
| **Medium** | transcript 无限增长 | 支持分页读取 + 增量历史摘要 |
| **Medium** | collab-admin 无 ErrorBoundary | 顶层加 ErrorBoundary |
| **Low** | Plugin Json 大对象存 DB | 长期拆对象存储 |
| **Low** | 桌面端无路由库 | 桌面端可接受 |

**整体评价**：平台经过一轮 ultrareview 修复（代码注释中大量 `AUTH-04`/`XSEC-01`/`SPAWN-01`/`SCRIPT-01` 等修复标记），核心安全（JWT fail-fast、AES-256-GCM 加密、ValidationPipe 白名单、路径穿越防御、进程组清理）和并发安全（事务原子性、条件 updateMany 防超扣/超发）已较完善。主要缺口集中在**运维可观测性**（无日志/限流/监控）和**测试深度**（无 e2e/前端组件测试），这两项是「从能用到好用」的关键门槛，建议作为商业化上线前的首要补齐项。

---
# 审计维度 3

我已全面阅读了 economy、wallet、marketplace、plugin、admin、team、prisma schema 等关键代码，下面是商业化视角的审计报告。

---

# 商业模型与变现 审计报告

## 一、整体诊断

平台当前是「能转账、不能经营」的状态。架构上有两个独立但互不打通的账本系统（`Wallet` 个人钱包 / `BalanceLedger` 团队共享余额），存在一套最小化的「付费插件 P2P 转账」路径，但 **缺乏任何商业闭环**：

- 设计文档 `docs/adr/0002-llm-third-party-gateway.md:39` 明确写「放弃了平台抽成这条现金流，未来要变现可在订阅层做」。
- `docs/01-vision-and-architecture.md:41` 将「公开市场」列为 M4 后置非目标。
- 当前 `economy.service.ts` 仅 117 行，只有 3 个能力：注册赠送 / 查钱包 / 购买插件（全额入卖家账户）。
- 全仓 grep `subscription|invoice|refund|withdraw|recharge|commission|royalty|stripe|alipay|wechatpay` 在 collab-api / collab-admin / desktop 三端 **零命中**。

**结论：现有经济系统无法支撑商业运营，仅能做 demo 演示。**

---

## 二、按维度逐项缺口

### 1. 计费/订阅/付费 — 严重缺失

**现状**
- 只有一种「定价模型」：插件一次性 `priceCents`（`Plugin.priceCents`），存储在 `Plugin.priceCents Int @default(0)`。
- 钱包内账本（`Wallet.balanceCents`）只做加减，不挂外部支付通道。
- 全仓无任何 `Subscription / Plan / Tier / Quota` 概念，schema 里也没有订阅/会员/续费表。
- 模型层走第三方 newapi，平台 **不参与 LLM 计费**（ADR-0002 已明确放弃），平台无法基于 token 收费。

**缺口（按「能否支撑商业运营」排序）**
| 缺口 | 严重度 | 说明 |
|---|---|---|
| **无 SaaS 订阅层** | P0 | 无月/年套餐、无功能分级（免费/专业/企业），用户没有付费升级入口 |
| **无免费额度/试用机制** | P0 | `SIGNUP_BONUS_CENTS=1000`（¥10）一次性赠送是唯一「优惠」，无 quota/限速/续发机制 |
| **无计费挂钩** | P0 | 团队 `consume()` 接口存在但只是「扣减数字」，没有把它接到 LLM 生成用量上 |
| **无续费/到期模型** | P0 | 无续期、到期、降级、宽限期等任何订阅生命周期 |
| **无商品/价格目录** | P1 | 价格只在每个 `Plugin.priceCents` 上，平台层无统一价格表（plan catalog） |

**补齐建议**
- 新增 `Subscription` / `Plan` / `PlanPrice` schema（planCode、interval、priceCents、features、trialDays、status）。
- 团队/用户挂 `Subscription`（planId、status=TRIALING/ACTIVE/PAST_DUE/CANCELED、currentPeriodEnd、cancelAt）。
- `SIGNUP_BONUS` 改为 `Plan.trialDays`（N 天试用所有功能），与订阅生命周期对齐。
- `consume()` 真正接到 LLM 用量计量（即使 ADR-0002 说平台不自行计费，但商业化后必须自己计量，否则无法做套餐限额）。

---

### 2. 插件定价/分账/退款 — 严重缺失

**现状**（`economy.service.ts:82-113`）
```ts
// 卖家加款（upsert 兜底缺失钱包行）。
await tx.wallet.upsert({
  where: { userId: sellerId },
  update: { balanceCents: { increment: price } },
  create: { userId: sellerId, balanceCents: price },
});
```
- 购买时 **100% 全额进卖家钱包**，**平台抽成 = 0**。
- schema 里没有 `commissionRate / platformFee / settlement` 字段。
- 无退款表、无分账表、无结算表。
- `Purchase` 表只记 `priceCents`，不记 platformFee / sellerNet。

**缺口**
| 缺口 | 严重度 | 说明 |
|---|---|---|
| **平台抽成模式不存在** | P0 | 平台目前不收一分钱，无法形成商业闭环 |
| **退款机制完全缺失** | P0 | 无 Refund 表、无退款流程、无卖家扣回机制；用户买了之后 admin 无路径退款 |
| **分账/结算周期不存在** | P0 | 钱直接入卖家钱包「立即可花」，无 T+N 冻结、无月结对账 |
| **税务/合规扣款缺失** | P1 | 卖家收入无个税/服务费扣减、无发票关联 |
| **作者定价权受限** | P2 | 作者只能在 `submitPluginToMarketplace` 设 `priceCents`，无折扣/促销/阶梯价/订阅式插件定价 |
| **Purchase 表字段不足** | P1 | 缺 `platformFeeCents / sellerNetCents / refundStatus / settleStatus` |

**补齐建议**
- `Purchase` 表加 `platformFeeCents` `sellerNetCents` `commissionRateBps` `settleStatus` `refundedAt` 字段。
- 新增 `PlatformFeePolicy` 表（默认抽成率，按插件/作者/时段可覆盖）。
- 新增 `Refund` 表与 `POST /api/wallet/refund` 接口（带状态机：requested→approved→settled）。
- 卖家收入改为「待结算账户」，T+7 或月结对账后才能到 `Wallet.balanceCents` 可提现余额。

---

### 3. 免费额度/试用/升级引导 — 严重缺失

**现状**
- 唯一「免费资源」：注册一次性 `SIGNUP_BONUS_CENTS=1000`（¥10）。
- 全仓 grep `trial|试用|升级|quota` 在 collab-api/collab-admin 业务代码 **零命中**（只在 desktop updater 代码里出现「升级」一词，与商业化无关）。
- `Wallet.tsx:24-28` 的 REASON_LABEL 只有三种：`signup_bonus` / `purchase` / `sale`，没有「试用额度、推荐奖励、活动券」等品类。
- 没有「升级套餐」入口、没有「余额不足→充值」按钮（`Market.tsx:152-154` 只是跳到钱包页显示余额，没有任何充值路径）。

**缺口**
| 缺口 | 严重度 | 说明 |
|---|---|---|
| **试用/免费额度不闭环** | P0 | ¥10 赠送花完就死路一条，无自动续给、无配额限制提示 |
| **无升级引导 UI** | P0 | 余额不足时只 toast 提示「去钱包」，没有「升级套餐/购买额度」CTA |
| **无活动/优惠券机制** | P1 | 无 discountCode / coupon / promotion |
| **无推荐返利** | P1 | 无 referral / affiliate 链路 |

**补齐建议**
- 试用额度改为日/月发放（与订阅对齐），用完触发付费墙 + 升级 CTA。
- `Market.tsx` 余额不足时除了「去钱包」，应该新增「立即充值/升级套餐」二级动作。

---

### 4. 平台抽成模式 — 完全不存在

**现状**
- 全仓 grep `commission|royalty|platformFee|fee_rate|platformShare|抽成|分成|佣金` 在 collab-api、collab-admin 业务代码 **零命中**。
- `docs/adr/0002-llm-third-party-gateway.md:39` 明确写「放弃平台抽成这条现金流」。
- 购买路径 `economy.service.ts:82-113` 全额给卖家。
- `admin.service.ts:257-273` adminUpdatePlugin 能改 `priceCents`，但没有抽成比例字段。

**缺口**
- 平台目前 **0 收入**，没有抽成配置、没有结算账户、没有提现链路、没有对账能力。
- 这是一个 **商业模式级硬伤**，必须先决策抽成比例（如 15%/30%）才能上线商业市场。

**补齐建议**
- 新增 `PlatformRevenue` 账户（schema 里把抽成归入系统用户钱包或独立表）。
- 抽成比例进入 `Purchase.platformFeeCents`，并在 admin 后台可配置（全局默认 + 单插件覆盖）。
- admin 仪表盘增加「平台累计抽成」「平台月收入」「Top 卖家结算」指标。

---

### 5. 钱包充值/提现/对账 — 严重缺失

**现状**
- `WalletController` (`wallet.controller.ts`) 只有 2 个接口：`GET /wallet`、`POST /wallet/purchase`。
- **充值路径完全不存在**：用户钱包余额只能靠注册赠送（¥10）或卖插件得来，没有第三方支付通道接入。
- **提现路径完全不存在**：卖家收入进了 `Wallet.balanceCents` 后无任何出口，无法提现到银行卡/支付宝。
- `Wallet.tsx:48-95` 桌面端只有「余额展示 + 流水列表」两个卡片，**没有任何充值/提现按钮**。
- 全仓 grep `recharge|topup|deposit|withdraw|payout|stripe|alipay|wechatpay|微信支付|支付宝` 零命中。

**缺口**
| 缺口 | 严重度 | 说明 |
|---|---|---|
| **充值完全缺失** | P0 | 没有第三方支付集成，钱包永远只能有 ¥10，付费插件基本卖不动 |
| **提现完全缺失** | P0 | 卖家收入锁死在平台内，无法形成「创作者经济」 |
| **支付通道未集成** | P0 | 无 Stripe/支付宝/微信支付集成，无订单表、回调、对账 |
| **对账机制缺失** | P1 | 无对账单、无 T+N 结算、无卖家月结报表 |
| **风控/反洗钱缺失** | P1 | 无 KYC、无大额异常监控、无提现实名认证 |
| **双账本割裂** | P1 | `Wallet`(个人) 与 `BalanceLedger`(团队) 互不打通，无跨账本流转 |

**补齐建议**
- 新增 `PaymentOrder` / `PaymentChannel` schema（接入微信支付/支付宝/Stripe）。
- 新增 `WithdrawRequest` 表 + admin 审核流（requested→reviewing→paid→rejected）。
- `Wallet.tsx` 增加「充值」「提现」两个 Tab/按钮（现在完全没有）。
- 桌面端和市场详情页余额不足时增加「充值」CTA，引导到充值流程。

---

### 6. 发票/合同/B 端采购流程 — 完全缺失

**现状**
- 全仓 grep `invoice|发票|合同|contract|对公|采购|企业` 在 collab-api、collab-admin、desktop 三端业务代码 **零命中**。
- 无 `Invoice` schema、无开票接口、无企业认证流程。
- 用户/团队 schema 里没有 `companyName / taxId / invoiceTitle / billingAddress` 字段。

**缺口**
| 缺口 | 严重度 | 说明 |
|---|---|---|
| **发票开具完全缺失** | P0 | 中国 B 端采购硬需求，没有发票等于做不了 B 端生意 |
| **企业认证/资质缺失** | P0 | 无企业实名、无统一社会信用代码、无合同主体 |
| **合同/订单流程缺失** | P0 | 无采购订单、无合同签署、无对公转账路径 |
| **税务计算缺失** | P1 | 无税率配置、无税额拆分、无完税证明 |

**补齐建议**
- 新增 `Invoice` / `InvoiceTitle` schema（开票抬头、税号、订单关联、状态机）。
- 新增 `EnterpriseProfile`（企业认证、营业执照、统一社会信用代码）。
- 新增 B 端套餐（席位制 / 年付 / 对公转账 + 合同）。
- admin 后台增加发票管理 + 合同管理 view（目前 sidebar 只有 dashboard/users/teams/plugins/applications/audit/llmProviders，无 finance/invoice/contract）。

---

### 7. 商业化数据统计能力 — 严重缺失

**现状**（`admin.service.ts:15-28` `adminDashboard`）
```ts
const [users, teams, pendingApplications, plugins, disabledPlugins, pendingPluginReviews] = await Promise.all([
  this.prisma.user.count(),
  this.prisma.team.count(),
  this.prisma.teamAdminApplication.count({ where: { status: 'PENDING' } }),
  this.prisma.plugin.count({ where: { status: 'ENABLED' } }),
  this.prisma.plugin.count({ where: { status: 'DISABLED' } }),
  this.prisma.plugin.count({ where: { reviewStatus: 'PENDING' } }),
]);
```
- admin 仪表盘只有 4 个运营指标（用户/团队/待审批/插件数），**0 个商业化指标**。
- `dashboard.tsx:18-23` stats 数组里没有「收入、GMV、付费用户、转化率、留存」任何一项。
- 没有 Purchase 汇总接口、没有 Wallet 余额分布接口、没有卖家收入排行。
- 无留存/转化漏斗、无 cohort 分析、无 MRR/ARR 计算。

**缺口**
| 缺口 | 严重度 | 说明 |
|---|---|---|
| **无收入指标** | P0 | 没有 GMV / 平台抽成 / 卖家净收入 / 退款金额 汇总 |
| **无转化/漏斗** | P0 | 无 注册→首次购买 / 试用→付费 / DAU→付费 转化率 |
| **无留存分析** | P0 | 无 cohort 留存、无付费用户续约率 |
| **无卖家排行** | P1 | 无 Top 卖家 / 热销插件 / 收入分布 |
| **无充值/提现报表** | P1 | 无资金流水汇总、无对账报表 |
| **无审计关联到金额** | P2 | `audit_logs` 只记 `amountCents`（`types.ts:177`），但没有专门的财务审计视图 |

**补齐建议**
- admin 仪表盘新增「财务概览」区：GMV（本月/累计）、平台抽成、付费用户数、付费转化率、MRR、Top 5 热销插件。
- 新增 `GET /api/admin/finance/overview`、`/api/admin/finance/purchases`、`/api/admin/finance/sellers` 接口。
- admin 后台 sidebar 增加 `finance` view（收入/订单/退款/对账/发票）。

---

## 三、其他商业风险点

### 3.1 双账本割裂（架构债务）
- `Wallet`（用户级，`economy.service.ts`）和 `BalanceLedger`（团队级，`team.service.ts:consume()`）是两套独立的扣减系统。
- `docs/03-backend-and-llm.md:65` 文档自相矛盾：「市场购买改由团队共享余额 `POST /api/teams/current/consume` 结算」，但实际代码 `marketplace.service.ts:90` 走的是 **用户钱包** 路径（`plugin.priceCents > 0` 查 `Purchase.buyerUserId`）。文档与代码不一致。
- 商业化前必须先决策：付费主体是 **用户** 还是 **团队**？目前两套都有半成品。

### 3.2 卖家钱包无防刷
- `economy.service.ts:90-95` 卖家加款用 `wallet.upsert({ create: { userId: sellerId, balanceCents: price } })`，意味着 **任意 plugin.authorUserId** 都能成为收款方，无 KYC、无冻结期、无审核。
- 攻击者可注册多账号互买自己的插件洗注册赠送额度（A 给 B 的插件标价 ¥10，A 买 B，B 得 ¥10；循环）。

### 3.3 价格可被 admin 单方面修改
- `admin.service.ts:257-273` `adminUpdatePlugin` 可改任意插件 `priceCents`，但没有审计联动到已购买用户的退款/差价。
- 已购买用户的价格无快照，admin 改价后历史 Purchase 仍是旧价，但新购买是新价，财务对账困难。

### 3.4 桌面端钱包页缺关键入口
- `Wallet.tsx:48-95` 只有「余额卡 + 流水卡」，**没有充值/提现/发票申请/套餐升级** 任何商业化入口。
- REASON_LABEL 只有 3 种（signup_bonus/purchase/sale），未来加退款/抽成/活动/订阅时需要扩展。

### 3.5 admin 后台缺商业化模块
- `apps/collab-admin/src/components/` 只有 dashboard/users/teams/plugins/applications/audit/llm-providers/admins 8 个 view。
- **缺**：finance（财务）/ orders（订单）/ refunds（退款）/ invoices（发票）/ withdrawals（提现）/ settlements（结算）/ plans（套餐）等商业化必备 view。

---

## 四、商业化补齐优先级清单

### P0（上线商业化前必须完成，否则无法形成商业闭环）
1. **接入第三方支付通道**（微信/支付宝/Stripe）+ `PaymentOrder` schema + 充值流程。
2. **平台抽成机制**（默认 15-30%）+ `Purchase.platformFeeCents/sellerNetCents` + `PlatformFeePolicy` 表。
3. **订阅/套餐层**（`Plan` / `Subscription` schema + 试用/到期/续费生命周期）。
4. **退款机制**（`Refund` 表 + 卖家扣回 + admin 审核流）。
5. **提现机制**（`WithdrawRequest` + KYC + admin 审核 + T+N 结算）。
6. **B 端发票/企业认证**（`Invoice` / `EnterpriseProfile` schema + 开票流程）。
7. **admin 财务仪表盘**（GMV / 平台收入 / 付费转化 / Top 卖家）。

### P1（商业化上线 3 个月内补齐）
8. 卖家收入冻结期 + 月结对账报表。
9. 活动券/优惠券/推荐返利（`Coupon` / `Referral`）。
10. 单一账本统一（合并 Wallet/BalanceLedger，决策付费主体）。
11. 反洗钱/风控（异常互买检测、大额监控、KYC 强制）。
12. admin 后台 finance/orders/refunds/invoices/withdrawals view。

### P2（长期完善）
13. 插件订阅式定价（按月/按调用计费）。
14. 创作者激励/分成梯度（销量越大抽成越低）。
15. 留存/cohort 分析、MRR/ARR 报表。
16. 跨账本转账（团队↔个人钱包）。

---

## 五、关键文件索引

**核心经济代码**
- `O:\lingfang-platform\apps\collab-api\src\modules\economy.service.ts`（钱包/购买/赠送，117 行）
- `O:\lingfang-platform\apps\collab-api\src\modules\marketplace.service.ts`（市场搜索/详情/安装/评分）
- `O:\lingfang-platform\apps\collab-api\src\modules\wallet.controller.ts`（仅 2 接口）
- `O:\lingfang-platform\apps\collab-api\src\modules\marketplace.controller.ts`（4 接口）
- `O:\lingfang-platform\apps\collab-api\src\modules\team.service.ts`（团队 consume 扣减，独立账本）
- `O:\lingfang-platform\apps\collab-api\src\modules\plugin.service.ts`（插件上传/提交市场/付费墙）

**Schema**
- `O:\lingfang-platform\apps\collab-api\prisma\schema.prisma`（Wallet/WalletTransaction/Purchase/BalanceLedger 模型，300-352 行）

**Admin**
- `O:\lingfang-platform\apps\collab-api\src\modules\admin.service.ts`（adminAdjustBalance/adminUpdatePlugin）
- `O:\lingfang-platform\apps\collab-admin\src\components\dashboard.tsx`（仪表盘无财务指标）
- `O:\lingfang-platform\apps\collab-admin\src\components\teams-view.tsx`（团队余额调整）
- `O:\lingfang-platform\apps\collab-admin\src\lib\types.ts`（View 枚举无 finance）

**桌面端**
- `O:\lingfang-platform\apps\desktop\src\pages\Wallet.tsx`（无充值/提现入口）
- `O:\lingfang-platform\apps\desktop\src\pages\Market.tsx`（购买/余额不足引导）

**设计决策**
- `O:\lingfang-platform\docs\adr\0002-llm-third-party-gateway.md`（明确放弃平台抽成/token 计费）
- `O:\lingfang-platform\docs\01-vision-and-architecture.md`（公开市场列 M4 后置）
- `O:\lingfang-platform\docs\collab-api.md`（API 文档无 finance/billing/subscription 端点）

**最终判断**：当前平台的「商业模型」只是技术原型级别的 P2P 转账 demo，距离支撑真实商业运营还差 7 个 P0 模块。建议优先级最高的三件事是：(1) 接入支付通道做充值；(2) 落地平台抽成与 Purchase 字段改造；(3) 设计订阅/套餐层把 LLM 用量挂上计费。

---
# 审计维度 4

我已经收集了足够的证据，可以生成一份全面的运维/发布审计报告。以下是我的发现。

---

# lingfang-platform 部署/运维/发布 完整性审计

## 现状速览（能跑，但不能稳定运营）

平台目前处在 **"单机/开发环境可一键起，生产运营基础设施几乎全缺"** 的阶段。下面按 7 个维度逐一列出缺口和补齐建议，按「能否稳定运营」的优先级排序。

---

## P0（阻断稳定运营，必须先补）

### 1. 没有 CI/CD（完全手工发布）

- **现状**：仓库无 `.github/workflows/` 目录（确认不存在），根目录无任何 CI 配置；发布动作是开发者本地手动跑 `tools/create-distribution.ps1` 打 zip，再手动登记到 Admin 后台。`.github/` 目录根本不存在。
- **风险**：没有自动化 `typecheck/test/build`，退化代码可以混入主干；没有可追溯的发布流水线；没有不可变产物（artifact）留存。
- **补齐建议**（优先级最高）：
  1. 加 `.github/workflows/ci.yml`：每个 PR 跑 `pnpm -r typecheck`、`pnpm -r test`、`apps/collab-api` + `apps/collab-admin` build；PostgreSQL service container 跑 `prisma migrate deploy` + 种子 + 集成 smoke。
  2. 加 `.github/workflows/release.yml`：tag 触发，构建 docker 镜像 + 桌面端多平台产物，自动签名（`TAURI_SIGNING_PRIVATE_KEY` 放 GitHub Actions secret），推到 registry。
  3. 产物（docker image + `.exe`/`.dmg`/`.AppImage` + `.sig`）存到 GitHub Releases 或对象存储，URL 作为 `ReleaseAsset.url` 登记。

### 2. 没有日志/监控/告警（生产黑盒）

- **现状**：
  - collab-api 用的是 NestJS 默认 `Logger`（即 console），无结构化日志、无日志聚合；只有 seed 脚本里有 `console.log`。
  - 仓库全局 grep `sentry|prometheus|grafana|datadog|opentelemetry|winston|pino` → **零命中**。
  - collab-admin / desktop 也都没有任何错误上报（Sentry / captureException 等）。
  - 健康检查只有 `/api/health` 返回 `{status:'ok', version}`，**没有 `/ready`、没有 DB 探活、没有依赖检查**。
- **风险**：生产故障时完全看不到错误堆栈、慢 SQL、内存涨势；无法主动告警。
- **补齐建议**：
  1. collab-api 接 NestJS 的 `Logger` 切到 pino 或 winston（JSON 结构化），容器 stdout 由 docker logging driver 收走。
  2. 加 `/api/health/live`（进程活着）和 `/api/health/ready`（DB 连通 + migration 版本一致）。
  3. 接 Sentry（`@sentry/nestjs`）捕获未处理异常；desktop 用 `@sentry/tauri`。
  4. Prometheus exporter（`prometheus` npm 或 `/metrics` endpoint）+ Grafana 仪表盘；或者最轻量用 Sentry Performance + Uptime 监控。
  5. 告警通道：Sentry → Slack / 邮件。

### 3. 数据库没有备份/灾备

- **现状**：
  - `docker-compose.collab.yml` 的 `collab_pgdata` 卷只是普通 docker volume，没有 backup policy、没有 `pg_dump` 定时任务、没有 WAL 归档、没有 PITR 配置。
  - 全局 grep `backup|pg_dump|snapshot|restore|disaster` → **零命中**（`apps/` 内）。
  - 文档 `docs/collab-deployment.md` 完全没提备份。
- **风险**：单点数据库故障 = 全平台数据丢失（用户、插件、钱包余额、交易流水全没）。
- **补齐建议**：
  1. 生产用托管 PG（RDS / Cloud SQL / Azure Database），开自动每日快照 + 7/30 天保留 + PITR。
  2. 自建场景：cron + `pg_dump` 到对象存储 + 异地副本；定期做 restore 演练（不演练等于没有）。
  3. 文档里加「备份策略 + 恢复 RPO/RTO」一节。

### 4. 密钥/配置生产化不完整

- **现状**（`apps/collab-api/.env.example` + `main.ts`）：
  - fail-fast 做得不错：`JWT_SECRET` < 16 字符或 `LLM_KEY_ENCRYPTION_KEY` 非法时生产 throw（`main.ts:25-41`），开发 warn。
  - **但** `.env.collab.example`（用于 docker compose）里 `JWT_SECRET=change-me-in-production`、`PLATFORM_ADMIN_PASSWORD=ChangeMe123!` 是占位值；没有显式校验「生产禁止使用这些默认值」，docker compose 起来如果用户不覆盖就裸奔。
  - 没有密钥轮换流程（JWT_SECRET 轮换需要 token 失效方案；LLM_KEY_ENCRYPTION_KEY 轮换需要数据重加密脚本）。
  - `LLM_KEY_ENCRYPTION_KEY` 一旦丢失 = 所有已加密 apiKey 永久无法解密，没有 escrow / KMS 集成。
- **补齐建议**：
  1. 生产启动校验：`JWT_SECRET` 不能等于 `.env.example` 里的字面量（黑名单）。
  2. 密钥用 KMS / Vault / AWS Secrets Manager 管理，而不是裸 `.env`。
  3. 加轮换 runbook：JWT 用 `kid` 多密钥共存；加密密钥提供 re-encrypt 脚本。
  4. docker compose 加 `env_file: .env.collab` 且 `required: true`（目前已加）+ README 强调「生产必须覆盖」。

---

## P1（影响可靠性，应尽快补）

### 5. 后端无进程管理 / 无优雅关闭 / 无水平扩展能力

- **现状**：
  - `CMD ["pnpm", ..., "start"]` 单进程，没有 PM2 / cluster / nodemon。
  - `main.ts` 没有 `app.enableShutdownHooks()`，没有 `SIGTERM` 处理；容器被 kill 时正在跑的 SSE 流 / DB 事务会被硬切断。
  - docker-compose.collab.yml **没有 `restart: unless-stopped` / `restart: always`**，进程崩了容器不会自动重启；**没有 `replicas`**，无法多实例；**没有 healthcheck 给 collab-api 容器**（只有 postgres 有）。
  - `app.listen(port, '0.0.0.0')` 监听没问题，但 Prisma schema 没设 `connection_limit` / `pool_timeout`，多实例时连接数会失控。
- **补齐建议**：
  1. `docker-compose.collab.yml` 加 `restart: unless-stopped`、给 collab-api 加 healthcheck（`curl /api/health`）、加 `logging.driver: json-file` + 大小限制。
  2. `main.ts` 加 `app.enableShutdownHooks()`；监听 `SIGTERM` → `app.close()` → 退出（k8s/docker graceful shutdown 必备）。
  3. 生产用 k8s + Deployment（replicas≥2）+ HPA；或 PM2 cluster mode。
  4. `DATABASE_URL` 加 `?connection_limit=10&pool_timeout=30` 或前面挂 PgBouncer。

### 6. 没有反向代理 / TLS 终止的现成方案

- **现状**：`docs/04-engineering.md:97` 只说「HTTPS 通常由 Caddy/Nginx 终止」，但仓库里没有 nginx.conf / Caddyfile / traefik 配置。
- **风险**：用户自己拼 TLS，容易出错；updater 默认强制 HTTPS（见下条）。
- **补齐建议**：仓库提供 `deploy/Caddyfile.example`（自动 Let's Encrypt）或 `deploy/nginx.conf`，docker-compose 加 caddy/nginx 服务。

### 7. 桌面端自动更新有重大安全开关没关

- **现状**（`apps/desktop/src-tauri/tauri.conf.json:33`）：
  ```
  "updater": {
    "pubkey": "...",
    "endpoints": [],
    "dangerousInsecureTransportProtocol": true
  }
  ```
  - `dangerousInsecureTransportProtocol: true` 是为了支持「用户在内网/HTTP 后端」而开的逃生口，但**生产环境如果默认开着 = 中间人可以替换更新包**（虽然 minisign 签名会挡，但用户感知差且增加攻击面）。
  - `endpoints: []` 空数组（运行时由 `updater.rs` 注入），逻辑正确，但意味着 conf.json 里没法看出真实 endpoint，**排查困难**。
  - 只有 Windows NSIS 打包目标（`bundle.targets: ["nsis"]`），**没有 macOS（.dmg/.app）和 Linux（.AppImage/.deb）产物配置**；当前平台只支持 Windows 用户。
  - **没有代码签名**（Authenticode / Apple Developer ID / notarization）——grep `authenticode|codesign|notariz|signtool` 零命中。Windows SmartScreen 会拦截未签名安装包，用户首次安装会被吓退。
  - 私钥 `.tauri/lingfang.key` 已生成且 gitignore（正确），但没有轮换 / 备份策略；私钥丢失 = 无法再发更新（所有老客户端永远拿不到新版）。
- **补齐建议**：
  1. 生产构建关闭 `dangerousInsecureTransportProtocol`，强制 HTTPS；内网部署文档单独说明如何用自签证书或内网 CA。
  2. 加 macOS（`dmg` + `app`）和 Linux（`AppImage`、`deb`）bundle target；CI 里跨平台 build matrix。
  3. 申请代码签名证书：Windows EV 证书（Authenticode）、Apple Developer ID + notarization（`tauri-apps/tauri-action` 自带）。
  4. updater 私钥离线备份（如硬件 key / 1Password vault），写进 runbook。

### 8. 发布模块是「登记表」，不是「流水线」

- **现状**（`release.service.ts` + `release.controller.ts`）：
  - 后端 `/api/admin/releases/*` 提供 create/update/publish/archive/addAsset；`ReleaseAsset.url` 是**外链**（schema 注释明说「GitHub Release 直链或 CDN」），后端不托管二进制。
  - 发布动作 = Admin 手动 create DRAFT → 手动 upload 产物到外部存储 → 手动 addAsset 填 url + signature → publish。
  - **没有 release pipeline**：不校验 url 可达、不验证 signature 与产物匹配、不阻止「publish 一个没有任何 asset 的版本」（会被当作 latest 但 updater 查不到 asset 返 204，用户卡在老版本）。
  - `publish` 维护 `isLatest` 唯一性用了事务（好），但 `archive` 不自动晋升次新版本（注释明说）——归档当前 latest 后，整个 channel 就没有 latest 了，updater 永远 204。
- **补齐建议**：
  1. publish 前校验：至少有一个 PUBLISHED-ready asset；url HEAD 探活；signature 非空。
  2. archive 时如果当前是 latest，自动把次新的 PUBLISHED 提为 latest（或拒绝 archive，要求先 publish 别的）。
  3. 后端集成对象存储（S3 / MinIO）直接托管产物，避免外链漂移；或 CI 自动同步 Release GitHub assets 到 `ReleaseAsset` 表。

---

## P2（影响规模化，中期补）

### 9. 没有 rate limiting / DDoS 防护

- grep `throttle|ThrottlerModule|@nestjs/throttler|rate.?limit` → **零命中**。
- 公开端点 `/api/releases/*`、`/api/health`、登录、注册全无防护。
- 建议：接 `@nestjs/throttler`；nginx 层加 `limit_req`；敏感操作（登录、钱包）加验证码。

### 10. 没有定时任务框架

- grep `@nestjs/schedule|crontab` → **零命中**。
- 商业平台通常需要：定时对账（钱包余额 vs 流水）、过期 token 清理、release 自动归档、备份触发、统计数据聚合。
- 建议：接 `@nestjs/schedule`，把上述任务做成 cron。

### 11. 没有配置中心 / 灰度发布能力

- grep `canary|blue.green|feature.?flag|灰度` → **零命中**。
- 后端发布只能整体替换（docker pull + restart），没有流量切分、没有 feature flag、没有 canary。
- 建议：接入 Unleash / GrowthBook / ConfigCat 做 feature flag；k8s 做 canary deployment；`ReleaseAsset` 加 `rolloutPercent` 字段做桌面端灰度（部分用户先收到新版本）。

### 12. 测试覆盖不足

- collab-api 只有 6 个 spec 文件（`collab.service / plugin.service / plugin-package / credential-cipher / llm.service / release.service`）；**没有 auth、wallet、marketplace、team、admin 模块的测试**；没有 e2e/集成测试。
- desktop 有 4 个 spec（都是 lib 层），UI 层零测试。
- 建议：补关键路径单测（鉴权、钱包扣款幂等、marketplace 购买）；加 supertest e2e 跑完整 HTTP 流程。

### 13. 部署文档不完整

- `docs/collab-deployment.md` 只覆盖「本地 / docker compose 起服务」，**没有**：
  - 生产 checklist（HTTPS、密钥、备份、监控）
  - 升级/回滚流程（prisma migrate 怎么回退、schema 不兼容怎么办）
  - 灾备演练步骤
  - 容量规划（PG 连接数、API 并发上限、磁盘）
- 建议：补 `docs/ops-runbook.md`，覆盖上述所有项。

---

## 关键缺口速查表

| 维度 | 现状 | 缺口 | 优先级 |
|---|---|---|---|
| CI/CD | 无 `.github/workflows`，纯手工 | 完整 CI + release pipeline | **P0** |
| 日志/监控/告警 | console.log + 无 sentry/prometheus | 全套可观测性 | **P0** |
| 备份/灾备 | docker volume，无 pg_dump | 备份策略 + 恢复演练 | **P0** |
| 密钥管理 | fail-fast 不错，但无轮换/KMS | KMS + 轮换 runbook | **P0** |
| 进程管理/优雅关闭 | 单进程，无 restart/hooks | enableShutdownHooks + restart policy | **P1** |
| 反向代理/TLS | 文档一句话带过 | 提供 Caddyfile/nginx 模板 | **P1** |
| 桌面端签名/多平台 | 仅 Windows NSIS，dangerousInsecureTransportProtocol=true | macOS/Linux + 代码签名 + 关 HTTP 逃生口 | **P1** |
| 发布流水线 | 手动登记外链 | publish 前校验 + 自动归档 latest 晋升 | **P1** |
| Rate limiting | 无 | @nestjs/throttler | **P2** |
| 定时任务 | 无 @nestjs/schedule | 对账/清理/聚合 cron | **P2** |
| 灰度/回滚 | 整体替换 | feature flag + canary | **P2** |
| 测试覆盖 | 6 spec，缺关键模块 | 补 auth/wallet/marketplace 测试 | **P2** |
| 运维文档 | 只有部署起步 | ops runbook（升级/回滚/灾备/容量） | **P2** |

---

## 一句话结论

**代码本身的安全性做得相当扎实**（fail-fast、CORS fail-close、ValidationPipe 全局、Swagger 生产关闭、AES-256-GCM 加密 apiKey、minisign 验签），但 **"代码能跑" ≠ "能稳定运营"**：缺 CI/CD、缺监控告警、缺备份、缺代码签名、缺灰度回滚——这五项是商业产品上线的硬门槛，建议按 P0 → P1 → P2 顺序补齐。当前状态适合 **内部/小范围灰度试用**，**不适合直接面向公网用户商业运营**。

---
# 审计维度 5

我现在已经有了全面的了解。让我来整理安全审计报告。

---

# 安全与合规审计报告 — lingfang-platform

本报告基于对 `apps/collab-api/src`（security.ts、common.ts、crypto/、auth/llm/admin/economy/release service+controller）、`apps/desktop/src-tauri/src`（cli_config.rs、llm_credentials.rs、plugin_script.rs、llm_fetch.rs、updater.rs、capability.rs、code_assistant.rs）、`prisma/schema.prisma`、tauri.conf.json 等核心文件的审计。客观列风险 + 缓解建议，按风险等级分类。

---

## 1. 认证/鉴权（JWT、tokenVersion、session 管理）

**已做好的部分（成熟）：**
- JWT 算法白名单 `algorithms: ['HS256']`（`security.ts:44`），防御算法混淆攻击。
- `tokenVersion` 吊销机制完整：`JwtAuthGuard` 每次请求回查 DB 比对 `status` + `tokenVersion`（`security.ts:51-58`），admin 禁用/降级用户时自增 `tokenVersion`（`admin.service.ts:65,81`），sessionFor 也校验 status（`auth.service.ts:76`），堵住了「旧 token 7 天窗口续命」漏洞。
- 启动期 fail-fast：生产缺 `JWT_SECRET` 或长度 <16 直接 throw（`main.ts:25-30`），杜绝回退公开默认值。
- 密码用 bcrypt cost=12（`auth.service.ts:25`），防彩虹表。
- 最后一位 admin 保护 + 禁止自降级（`admin.service.ts:48-58,74-79`）。
- Logout 是无状态客户端清理（`auth.controller.ts:42-46`），配合 tokenVersion 可实现服务端吊销。

**风险：**

| 等级 | 风险 | 位置 | 说明 |
|------|------|------|------|
| 中 | **无登录限流/锁定** | `auth.controller.ts:22-25`（login） | `/api/auth/login` 无 rate-limit/throttle（全项目 grep 无 ThrottlerModule）。攻击者可对任意邮箱暴力破解密码。密码仅要求 8 位无复杂度（`auth.dto.ts:12`），降低爆破门槛。**缓解：** 接入 `@nestjs/throttler` 对 login/register 加 IP+邮箱维度限流（如 10 次/分钟），失败 N 次临时锁定。 |
| 中 | **JWT 7 天有效期偏长** | `auth.service.ts:110`（`JWT_EXPIRES_IN='7d'`） | access token 7 天 + 无 refresh token 轮换机制。token 一旦泄漏（XSS/设备失窃），7 天内无法主动失效（只能靠 admin 改 tokenVersion）。**缓解：** 缩短 access token 至 15-30 分钟，引入 refresh token（短 access + 长 refresh 分离），或加 token 黑名单。 |
| 低 | **JwtAuthGuard 每请求查库** | `security.ts:51-54` | 注释自认「并发量低，正确性优先于性能」。生产若并发上来会成为热点查询 + DB 故障即全员不可用（无缓存降级）。**缓解：** 可接受，但建议加短 TTL 缓存（如 Redis 缓存 user status 30s）。 |

---

## 2. 敏感数据保护（LLM key 加密、CLI 注入、日志泄漏）

**已做好的部分（成熟）：**
- AES-256-GCM 加密存储 apiKey，每次新 IV（语义安全），GCM tag 校验防篡改（`credential-cipher.ts:47-88`）。
- 密钥从 env 读取（64 位 hex），启动期 fail-fast，密钥不入库不入 git（`main.ts:36-41`，`.env` 已被 .gitignore 忽略，git 未追踪）。
- 脱敏串 `apiKeyHint` + 指纹 `keyFingerprint` 明文存库，GET 列表零解密（`llm.service.ts:152-159`）。
- 审计日志 metadata **永不记 key 明文/密文/hint/fingerprint**（`llm.service.ts:233-241` 显式注释）。
- CLI 配置注入隔离设计良好：CODEX_HOME/OPENCODE_CONFIG 指向临时目录，不写用户默认配置；明文 key 只在 Rust 进程内传递，不经 webview（`llm_credentials.rs:8-9`，`cli_config.rs:24-28`）；command_preview 用 `redact_arg` 脱敏（`code_assistant.rs:1754-1758`，含 token/key/secret 的参数替换为 `[redacted]`）。
- decrypt 端点强审计（`llm.service.ts:277-301`，每次解密写 `llm_binding.key_decrypted` 审计）。

**风险：**

| 等级 | 风险 | 位置 | 说明 |
|------|------|------|------|
| 高 | **明文 apiKey 经 HTTP 返回 decrypt 端点 + 桌面端 HTTP 后端** | `llm.service.ts:300`（返回明文），`tauri.conf.json:33`（`dangerousInsecureTransportProtocol: true`） | `POST /api/llm/binding/decrypt` 返回 `{ apiKey: plaintext }`。若用户配置 HTTP 后端（非 HTTPS），明文 key 经网络明文传输，中间人可截获。updater 的 `dangerousInsecureTransportProtocol: true` 允许 HTTP 检查更新（更新包虽 minisign 验签，但 tauri-update 端点的 `signature` 字段本身在 HTTP 下可被替换为伪造值——不过 minisign 验签会拦）。**缓解：** 生产强制后端 HTTPS；decrypt 端点可考虑短期一次性 token 替代直接返明文，或桌面端本地解密（key 下发到本地受 Tauri keyring 保护）。 |
| 中 | **codex/opencode 临时配置文件含明文 key 落盘** | `cli_config.rs:137-151`（codex config.toml），`cli_config.rs:174-192`（opencode json） | 临时配置文件在 `app_data/cli-configs/<sessionId>/` 下以明文写入 `api_key`/`apiKey`。虽然会话结束清理（`cli_config.rs:205-208`），但：① 文件权限默认未显式设为 0600；② 异常退出（崩溃/强杀）时残留文件含明文 key；③ 同机其他用户/进程可读。**缓解：** 显式设置文件权限 0600（Windows 用 ACL）；崩溃恢复时启动期扫描清理残留；或用 OS keyring（keytar/keyring crate）替代明文配置文件。 |
| 中 | **fetch_models 明文 key 从前端传入 Rust** | `llm_fetch.rs:33-40`（`api_key: String` 来自前端 invoke），`lib/llm-fetch.ts` | 设置页用户填 key 时，key 从 webview JS 传给 Rust `fetch_models` 命令。虽注释称「不存入前端 state/localStorage」，但 invoke 参数经 IPC 序列化时短暂存在于 webview 内存。若 webview 有 XSS（见下），可拦截 invoke 调用窃取 key。**缓解：** 可接受（设计权衡），但依赖 webview 无 XSS 前提。 |
| 低 | **codex TOML 手写转义** | `cli_config.rs:133-151` | 手写 TOML 用 `escape_toml_string`（仅转义 `"` 和 `\`）。OpenAI key 通常安全，但若 provider 返回的 apiUrl 含 TOML 控制字符（换行等），可能破坏配置文件。有单测覆盖双引号/反斜杠，但未覆盖换行符。**缓解：** 补充换行/控制字符转义或用 toml crate。 |

---

## 3. 注入攻击面（SQL 注入、XSS、路径穿越、命令注入）

**已做好的部分（成熟）：**
- **SQL 注入：零风险。** 全项目无 `$queryRaw`/`$executeRaw`（grep 无结果），全部用 Prisma 参数化查询。
- **字段越权透传：已防。** 全局 ValidationPipe `whitelist + forbidNonWhitelisted`（`main.ts:57-61`），service 层显式字段白名单提取（如 `admin.service.ts:60-65`，`llm.service.ts:98-105`），不依赖拦截器。
- **路径穿越（插件脚本）：强防。** `plugin_script.rs` 三层防御：`sanitize_plugin_id`（段级白名单 [A-Za-z0-9_-]，`plugin_script.rs:313-327`）+ `sanitize_rel_path`（禁绝对路径/`..`/隐藏段，`plugin_script.rs:234-253`）+ canonicalize 前缀断言（`plugin_script.rs:303-308`）。有单测验证穿越拒绝。
- **路径穿越（capability fs.read）：已防。** `canonical_scoped_path` canonicalize + starts_with 前缀校验（`capability.rs:162-184`），且 OutOfScope 错误不回显真实路径（关闭信息泄漏 oracle，`capability.rs:63-65`）。
- **Prisma 错误脱敏：已防。** `AppExceptionFilter` 把 Prisma 错误映射为通用消息，不回显表名/字段名/约束名（`common.ts:91-99,110-121`）。
- **命令注入：低风险。** CLI spawn 的 binary 来自 `find_binary`（PATH 查找固定名称如 "claude"/"codex"，不接受用户输入路径），args 经 redact 但未额外转义（依赖 OS 进程参数隔离，不走 shell）。

**风险：**

| 等级 | 风险 | 位置 | 说明 |
|------|------|------|------|
| 中 | **更新日志 markdown 未走通用 sanitize** | `ChangelogPage.tsx:7-75`（renderNotes） | 自写 markdown 渲染器，虽用 React JSX（`{inline(...)}` 自动转义），不直接 `dangerouslySetInnerHTML`，XSS 面较小。但 `LandingFeatures.tsx:67` 用 `dangerouslySetInnerHTML` 渲染 ICONS 字典——若 ICONS 来源含用户/admin 输入则有 XSS。当前 ICONS 是硬编码常量，风险低。**缓解：** 保持 ICONS 仅硬编码；若未来 notes 走 HTML 渲染需加 DOMPurify。 |
| 低 | **npm shim 解析读文件内容** | `code_assistant.rs:1707-1729`（resolve_npm_shim） | `resolve_npm_shim` 读取 `.cmd` 文件内容并正则提取路径。若 `.cmd` 被篡改为恶意脚本（如指向恶意 exe），会直接 spawn。但前提是攻击者已能改用户 PATH 下的 npm 全局包目录（需本地写权限），属本地权限范围。**缓解：** 可接受（与本地运行 CLI 等价风险）。 |

---

## 4. 跨端数据流（桌面→后端→CLI 的 key 传递）

**已做好的部分：**
- 数据流清晰：后端存加密 key → 桌面 Rust 用 JWT 调 decrypt 端点拿明文 → 写临时配置 → spawn CLI → 清理。明文 key 不经 webview（`llm_credentials.rs:8-9,44-45`）。
- webview 预览 iframe 用 opaque origin（`PreviewDrawer.tsx:71` 去掉 allow-same-origin），隔离 parent 的 `__TAURI__`/localStorage（`Plugins.tsx:129-131`）。

**风险：**

| 等级 | 风险 | 位置 | 说明 |
|------|------|------|------|
| 中 | **JWT token 存 localStorage** | `desktop/lib/api.ts:2`（`AUTH_TOKEN_STORAGE_KEY='lf:authToken'`），`collab-admin/lib/api.ts:17` | 桌面端和管理端 JWT 都存 localStorage。webview 的 localStorage 可被 XSS 脚本读取（Tauri webview 虽有 CSP，但 `script-src 'self' 'unsafe-inline'` 允许内联脚本，若有注入点可读 token）。**缓解：** Tauri 场景可接受（非浏览器，无第三方页面），但建议 `unsafe-inline` 收紧为 nonce-based CSP。管理端（纯浏览器）建议改 httpOnly cookie 或内存持有。 |
| 低 | **backendUrl 可被用户任意配置** | `desktop/lib/api.ts:27-39`（configureApiBase 接受 http/https） | 用户可在设置页填任意后端地址（含 http）。恶意后端可窃取 JWT（Authorization header 发给它）。设计如此（支持自部署），但需用户知晓信任边界。**缓解：** 文档明确告知；可选「已验证后端」白名单。 |

---

## 5. 第三方依赖安全

| 等级 | 风险 | 说明 |
|------|------|------|
| 中 | **无依赖漏洞扫描** | 未发现 `pnpm audit`/`npm audit`/ Dependabot/Renovate 配置。helmet、bcryptjs、jsonwebtoken、prisma、reqwest、tauri 等均为高频维护库，但仍需定期审计。**缓解：** CI 加 `pnpm audit --prod`，接入 Dependabot。 |
| 低 | **bcryptjs 纯 JS 实现** | `auth.service.ts:2` 用 `bcryptjs`（纯 JS）而非原生 `bcrypt`。纯 JS 版本性能差（cost=12 每次约 200ms+），高并发注册/登录时可能成 DoS 放大点（CPU 密集）。**缓解：** 当前并发低可接受；量大时换原生 bcrypt 或 argon2。 |

---

## 6. 合规（GDPR/数据隐私/用户协议）

| 等级 | 风险 | 说明 |
|------|------|------|
| 高 | **无隐私政策/用户协议/数据处理说明** | 全项目 grep 无 privacy policy / terms of service / 数据收集声明。作为商业平台处理：用户邮箱/密码、团队数据、apiKey（第三方凭据）、钱包余额（金融属性）、审计日志（含 PII 如 email）。**缓解：** 上线前必须：① 隐私政策（收集什么/用途/留存/第三方共享）；② 用户协议；③ 注册流程加同意勾选；④ apiKey 处理特别说明（存储加密/传输方式）。 |
| 中 | **审计日志含 PII 无留存策略** | `schema.prisma:286-298`（AuditLog），审计 metadata 含 email（`auth.service.ts:44`）、userId 等。`admin.service.ts:301` 返回全量审计日志含 actor 关联。无数据留存期限/自动清理。**缓解：** 定义留存策略（如 90 天），加定期清理 job；GDPR 删除请求需级联清理审计日志。 |
| 中 | **用户无数据导出/删除入口** | 无 GDPR Article 15（数据可携带权）/ Article 17（被遗忘权）实现。用户无法自助导出或删除自己的数据。**缓解：** 提供数据导出端点 + 账号删除入口（级联清理 wallet/purchase/membership/auditLog）。 |
| 低 | **密码仅在 DTO 校验长度** | `auth.dto.ts:12`（MinLength(8)），无复杂度要求，无常见密码字典校验（如 top-1000 弱密码）。**缓解：** 可接受，但建议加弱密码检测。 |

---

## 7. 桌面应用代码签名/完整性校验

**已做好的部分（成熟）：**
- **Tauri updater minisign 强制验签**：pubkey 内嵌 `tauri.conf.json:30`，私钥不入仓。`download_and_install` 下载后强制 `verify_signature`，失败即拒绝安装（`updater.rs:21-25,214-238`）。
- endpoint 运行时动态注入（不写死 conf.json），支持用户自配置后端地址（`updater.rs:153-159`）。

**风险：**

| 等级 | 风险 | 位置 | 说明 |
|------|------|------|------|
| 高 | **`dangerousInsecureTransportProtocol: true`** | `tauri.conf.json:33` | updater 允许 HTTP endpoint 检查更新。虽然安装包有 minisign 验签（防包篡改），但 HTTP 下：① `tauri-update` 返回的 `signature` 字段可被中间人替换——不过 minisign 验签用 conf.json 内嵌 pubkey，伪造 signature 会验签失败，实际安全。真正风险是：HTTP 下中间人可观察到用户检查更新的行为（流量分析）+ 返回 204 阻断更新（DoS 更新）。**缓解：** 生产关闭此 flag，强制 HTTPS endpoint。 |
| 中 | **Windows 无 Authenticode 代码签名** | `tauri.conf.json:12-18`（bundle targets: ["nsis"]） | tauri.conf.json 未配置 Windows 代码签名证书（`signtool`/certificateThumbprint）。未签名的 NSIS 安装包会触发 Windows SmartScreen 警告，用户可能被社工诱导「不安装」，且部分企业环境直接拦截。**缓解：** 购买 EV 代码签名证书，Tauri 构建配置 `windows.certificateThumbprint`。 |
| 中 | **release asset signature 由 admin 手填** | `release.service.ts:186-196`（`signature: dto.signature ?? ''`），`release.dto.ts:70-73` | admin 通过 API 手动粘贴 signature 字符串入库。流程未强制校验 signature 非空/格式合法，空 signature 会导致 updater 验签失败（运行时报错，非构建期拦截）。且依赖 admin 正确执行「构建→签名→复制 .sig 内容→填入」人工流程，易出错。**缓解：** 构建+签名+发布自动化（CI 直传 .sig）；publish 前校验 signature 非空且为合法 base64 minisign 格式。 |
| 低 | **updater pubkey 硬编码在 conf.json（入库）** | `tauri.conf.json:30` | pubkey 公开是安全的（minisign 设计如此），但意味着换签名密钥需重新发版。私钥 `.tauri/lingfang.key` 需确保不入仓且备份（丢失则无法发布任何更新）。**缓解：** 私钥纳入密钥管理（如 1Password/Vault），多人可访问。 |

---

## 总结：按优先级排序的补齐建议

**P0（上线前必须）：**
1. 登录限流（`@nestjs/throttler`，IP+邮箱维度）— 防暴力破解，当前密码仅 8 位无复杂度。
2. 隐私政策 + 用户协议 + 注册同意流程 — 商业平台法律合规底线。
3. 生产关闭 `dangerousInsecureTransportProtocol`，强制 HTTPS 后端 — 防 apiKey 明文传输泄漏。

**P1（上线后尽快）：**
4. Windows Authenticode 代码签名 — 否则 SmartScreen 拦截影响分发。
5. 临时配置文件权限设 0600 + 崩溃残留清理 — 防明文 key 落盘泄漏。
6. CI 加 `pnpm audit` + 依赖自动更新。
7. JWT 缩短有效期 + 引入 refresh token 机制。
8. release signature 非空校验 + 构建-签名-发布自动化。

**P2（持续改进）：**
9. 用户数据导出/删除入口（GDPR 合规）。
10. 审计日志留存策略 + 自动清理。
11. CSP 收紧 `unsafe-inline`（改 nonce-based）。
12. bcryptjs → 原生 bcrypt/argon2（性能）。

**整体评价：** 安全基础扎实——SQL 注入零风险、字段越权已防、路径穿越多层防御、apiKey 加密存储设计成熟、JWT 吊销机制完整。主要缺口集中在**运维安全（限流/HTTPS/代码签名）**和**合规（隐私政策/GDPR）**，而非代码级漏洞。代码注释中可见大量已修复的历史安全缺陷（XSEC/XERR/AUTH/SCRIPT/CAP 系列），说明经过系统性安全审查。

---

# 综合报告

# lingfang-platform 平台完整性调研报告

## 一、平台现状总结

**一句话定位**：lingfang-platform 是一个基于 Tauri + NestJS 构建的「AI 插件生成 + 团队协作 + 插件市场」商业平台，核心能力是用 AI 对话（claude/codex/opencode CLI）生成可预览、可分享的插件，并支持团队内共享和市场分发。

**已具备的核心能力**：

| 维度 | 能力 |
|------|------|
| AI 插件生成 | 对话式 CLI 驱动（claude/codex/opencode），多会话管理，sandbox 围栏块解析，预览大窗，Node/Python 脚本预览 |
| CLI 配置注入 | CODEX_HOME/OPENCODE_CONFIG/ANTHROPIC env 隔离，不污染默认配置，明文 key 不经 webview |
| 模型网关 v3 | 单 provider 云分发，Admin 管理启用，用户填 API 密钥，AES-256-GCM 加密存储 |
| 团队协作 | 邀请码加入、成员管理、团队共享插件、审核闭环 |
| 插件市场 | 上传→提交审核→审批→搜索→安装→评分，付费插件 P2P 转账 |
| 桌面更新 | Tauri updater 集成（检查→下载→minisign 验签→安装→重启） |
| 安全基线 | SQL 注入零风险，路径穿越三层防御，JWT tokenVersion 吊销机制，ValidationPipe 全局白名单 |
| 工程质量 | Rust 115 个单测，错误分类 11 种 kind，进程组/进程树跨平台清理 |

**结论**：技术骨架完整、核心交互链路已打通，但商业闭环、运营基础设施、合规体系三大块存在系统性缺口。

---

## 二、缺口清单（按维度归类）

### 维度 A：产品流程与用户旅程

| # | 缺口 | 影响 | 严重度 |
|---|------|------|--------|
| A1 | **注册即孤儿**：普通用户注册后无邀请码来源，PENDING_APPROVAL 无 SLA，新用户大概率流失 | 冷启动鸡生蛋，用户根本进不来 | **Blocker** |
| A2 | **新手引导缺失**：首屏无分步教程，用户不知道需先装 CLI、填 API Key、加入团队才能用 | 首日留存极低，进来了也用不起来 | **Blocker** |
| A3 | **找回密码/邮箱验证完全缺失**：grep 全仓 0 命中 | 密码丢失=账号作废；垃圾注册无法拦截 | **Blocker** |
| A4 | **AI 生成失败兜底不友好**：错误偏技术、无联系支持按钮、无成功率指标 | 核心价值无法量化迭代，用户流失无法定位原因 | High |
| A5 | **市场详情页信息稀薄**：无截图/演示/作者/更新日志/文档链接 | 付费转化率极低，用户凭什么付钱 | High |
| A6 | **钱包只能看不能充值**：Wallet.tsx 纯展示，economy.service 无 topup/withdraw | 整个付费闭环不成立 | High |
| A7 | **审核流程过于简陋**：审核员看不到源码、无法试运行、无法预览 UI | 审核员无法判断安全/合规 | Medium |
| A8 | **无帮助中心/反馈渠道/通知系统** | 支持成本高，关键事件用户感知不到 | Medium |
| A9 | **后端地址需手动配置**：普通用户不知道地址是什么 | 使用门槛高 | Medium |
| A10 | **仅 Windows + 无数据导出/注销**：macOS/Linux CLI 安装 Unsupported；无 GDPR 合规入口 | 排除非 Windows 用户；合规风险 | Medium |
| A11 | **团队管理员体验单薄**：无角色管理/配额/公告 | 团队治理能力弱 | Low |

### 维度 B：技术架构与健壮性

| # | 缺口 | 影响 | 严重度 |
|---|------|------|--------|
| B1 | **完全缺失请求限流**：无 @nestjs/throttler，login/register/purchase/upload 全裸奔 | 暴力破解、注册轰炸、DB 负载放大 | **High** |
| B2 | **无结构化日志**：仅 console，500 错误无 stack trace 记录 | 生产故障不可追溯 | **High** |
| B3 | **后端无 e2e 集成测试**：仅 6 个 service 单测，鉴权链/事务/DTO 未端到端验证 | 回归无保护，并发安全未验证 | **High** |
| B4 | **前端无组件测试**：仅 4 个 lib 工具函数测试，页面级零覆盖 | PluginCreator 状态机等无回归保护 | **High** |
| B5 | **破坏式 DDL 迁移无回滚**：llm_single_provider 迁移 DELETE+DROP 无 down | 生产数据被清且不可逆 | Medium |
| B6 | **高频查询缺复合索引**：Purchase(sellerUserId)、PluginRating(pluginId,createdAt)、AuditLog(action,createdAt) | 数据量增长后查询变慢 | Medium |
| B7 | **cancel_install 实际无效**：CURRENT_INSTALL 从未赋值，取消安装靠 300s 超时 | 用户取消安装无响应 | Medium |
| B8 | **contract 包大量 dead schema**：前端未 safeParse 后端响应，契约漂移无编译期保护 | 后端改字段前端不报错 | Medium |
| B9 | **marketplace 出参 snake_case 与 plugin camelCase 不一致** | 前端需处理两套命名 | Medium |
| B10 | **health 无 DB 探活**：DB 宕机仍返回 ok | 负载均衡不摘除节点 | Medium |
| B11 | **adminTeams 无分页**：全量拉取成员+include user（N+1） | 数据增长后 OOM/超时 | Medium |
| B12 | **marketplace rating 排序取 200 条应用层排序** | 插件超 200 时排序不准 | Medium |
| B13 | **transcript 无限增长全量读取**：长会话每次全量解析历史 | 长会话性能劣化 | Medium |
| B14 | **collab-admin 无 ErrorBoundary** | 组件抛错白屏无法自救 | Medium |
| B15 | **AssistantStore 全局 Mutex 长持锁**：高频 output 可能阻塞 UI | 多会话并行时性能瓶颈 | Low |
| B16 | **Plugin files/manifest 大对象存 DB Json 列** | 大量插件时全表扫描拖入内存 | Low |

### 维度 C：商业模型与变现

| # | 缺口 | 影响 | 严重度 |
|---|------|------|--------|
| C1 | **无第三方支付通道**：无 Stripe/支付宝/微信支付集成，无 PaymentOrder schema | 用户无法充值，钱包永远只有 ¥10 | **Blocker** |
| C2 | **平台抽成模式不存在**：购买 100% 进卖家，0 收入 | 平台无现金流，商业模式级硬伤 | **Blocker** |
| C3 | **无 SaaS 订阅/套餐层**：无 Plan/Subscription/Tier 概念 | 无月/年套餐、无功能分级、无续费到期 | **Blocker** |
| C4 | **退款机制完全缺失**：无 Refund 表、无卖家扣回、admin 无退款路径 | 用户买了无法退，纠纷无解 | **Blocker** |
| C5 | **提现机制完全缺失**：卖家收入锁死平台内，无 WithdrawRequest/KYC/T+N | 创作者经济不成立 | **Blocker** |
| C6 | **无发票/企业认证/B 端采购流程**：grep 零命中 | 中国 B 端硬需求，做不了企业生意 | **Blocker** |
| C7 | **无商业化数据统计**：Dashboard 0 个财务指标，无 GMV/转化率/留存 | 无法判断商业化健康度 | **High** |
| C8 | **免费额度不闭环**：¥10 一次性赠送花完即死路 | 无配额限制、无升级引导 CTA | **High** |
| C9 | **双账本割裂**：Wallet(个人) 与 BalanceLedger(团队) 互不打通，文档与代码不一致 | 付费主体未明确，账务混乱 | Medium |
| C10 | **卖家钱包无防刷**：无 KYC/冻结期/审核，任意 authorUserId 可收款 | 攻击者注册多账号互买洗额度 | Medium |
| C11 | **无优惠券/推荐返利/活动券机制** | 无增长拉新手段 | Low |
| C12 | **作者定价权受限**：仅一次性 priceCents，无折扣/促销/阶梯/订阅式定价 | 创作者定价灵活性低 | Low |

### 维度 D：部署/运维/发布

| # | 缺口 | 影响 | 严重度 |
|---|------|------|--------|
| D1 | **无 CI/CD**：仓库无 .github/workflows，纯手工发布 zip+手动登记 | 退化代码混入主干无拦截，无可追溯产物 | **Blocker** |
| D2 | **无监控/告警**：无 sentry/prometheus/grafana/opentelemetry，console.log | 生产黑盒，故障不可观测不可告警 | **Blocker** |
| D3 | **无数据库备份/灾备**：docker volume 无 pg_dump/快照/PITR | 单点故障=全平台数据丢失 | **Blocker** |
| D4 | **密钥管理不完整**：.env 占位值无生产黑名单校验，无轮换/KMS/escrow | 密钥泄露或丢失=系统不可用 | **Blocker** |
| D5 | **无优雅关闭/进程管理**：无 enableShutdownHooks，无 restart policy，无 healthcheck | 容器 kill 时 SSE/DB 事务硬切断，崩溃不重启 | **High** |
| D6 | **无反向代理/TLS 模板**：文档一句话带过，无 Caddyfile/nginx.conf | 用户自行拼 TLS 易出错 | **High** |
| D7 | **桌面端仅 Windows NSIS + 无代码签名**：macOS/Linux 无 bundle target，无 Authenticode | SmartScreen 拦截，非 Windows 用户被排除 | **High** |
| D8 | **dangerousInsecureTransportProtocol: true**：updater 允许 HTTP 检查更新 | 中间人可观测更新行为/阻断更新 | **High** |
| D9 | **发布模块是登记表非流水线**：不校验 asset 可达/signature 非空，archive 不自动晋升 latest | 发布空版本导致 updater 204 卡死 | **High** |
| D10 | **无定时任务框架**：无 @nestjs/schedule，无对账/清理/聚合 cron | 运维自动化缺失 | Medium |
| D11 | **无灰度/回滚能力**：无 feature flag/canary/rollback | 发布只能整体替换，无法回退 | Medium |
| D12 | **部署文档不完整**：无生产 checklist/升级回滚/灾备演练/容量规划 | 运维无标准操作 | Medium |

### 维度 E：安全与合规

| # | 缺口 | 影响 | 严重度 |
|---|------|------|--------|
| E1 | **HTTP 后端下 apiKey 明文传输**：decrypt 端点返回明文 + dangerousInsecureTransportProtocol=true | 中间人可截获第三方 LLM API 密钥 | **High** |
| E2 | **无隐私政策/用户协议/数据处理说明**：grep 零命中 | 法律合规底线缺失，无法商业运营 | **High** |
| E3 | **无登录限流/锁定**：login 无 throttle，密码仅 8 位无复杂度 | 暴力破解无阻碍 | **High** |
| E4 | **JWT 7 天有效期 + 无 refresh token**：token 泄漏后 7 天无法主动失效 | token 安全窗口过大 | Medium |
| E5 | **无 Windows Authenticode 代码签名** | SmartScreen 拦截影响分发，企业环境直接拦截 | Medium |
| E6 | **codex/opencode 临时配置文件明文 key 落盘**：未设 0600 权限，崩溃残留含明文 | 同机其他用户/进程可读 | Medium |
| E7 | **无依赖漏洞扫描**：无 pnpm audit/Dependabot | 依赖漏洞不可发现 | Medium |
| E8 | **审计日志含 PII 无留存策略**：无自动清理，无 GDPR 删除级联 | 合规风险 + 数据膨胀 | Medium |
| E9 | **release signature 由 admin 手填**：不强制校验非空/格式 | 空 signature 导致 updater 验签失败 | Medium |
| E10 | **JWT 存 localStorage + CSP unsafe-inline**：webview XSS 可读 token | token 窃取风险 | Low |
| E11 | **bcryptjs 纯 JS 实现**：cost=12 每次约 200ms+ | 高并发时 CPU 密集 DoS 放大 | Low |

---

## 三、优先级排序（Top 10 最该补）

按「阻塞商业上线」权重 70% +「见效快（工作量倒数）」权重 30% 综合排序：

| 排名 | 缺口编号 | 缺口名称 | 理由 |
|------|----------|----------|------|
| 1 | A1 | **公开团队发现 / 注册即孤儿** | 不解决用户根本进不来，商业无从谈起 |
| 2 | D1+D2+D3 | **CI/CD + 监控告警 + 数据库备份** | 三位一体构成「生产安全底线」，无此三项不可上线 |
| 3 | C1+C5 | **支付通道接入 + 钱包充值/提现** | 商业闭环的物理前提，无支付=无收入 |
| 4 | C2 | **平台抽成机制（Purchase 字段改造）** | 决定平台是否有现金流，需先做产品决策再编码 |
| 5 | A3 | **找回密码 + 邮箱验证** | 账号安全基线，法律+用户双重需求 |
| 6 | E1+E8+D8 | **强制 HTTPS + 关闭 insecure flag + 隐私政策** | 安全合规底线，防 apiKey 明文泄漏 |
| 7 | A2 | **新手引导 + 环境就绪检测横幅** | 首日留存的决定性因素，见效快 |
| 8 | C3+C6 | **订阅/套餐层 + B 端发票/企业认证** | 决定能否做 B 端生意和持续收入 |
| 9 | B1+E3 | **登录限流 + 密码策略加固** | 防暴力破解，工作量小见效快 |
| 10 | A4+C7 | **AI 生成成功率看板 + 错误反馈通道 + 财务指标** | 量化核心价值 + 商业化健康度，无数据无法迭代 |

---

## 四、补齐建议（每个 Top 缺口的方案概要 + 工作量）

### Top 1：公开团队发现 / 注册即孤儿 [A1]

**方案概要**：
- 新增「公开团队发现页」：列出 ACTIVE 且 `allowPublicJoin=true` 的团队（schema 加字段），用户一键申请加入，无需邀请码。
- `TeamAdminApplication` 流程已有，增加「团队级申请」（team admin 审批）+ SLA（48h 未审批自动提醒）。
- Onboarding 页增加「预计审批时间」「联系平台」入口。
- admin 创建用户时直接分配团队（已有 adminCreateUser，集成 teamId 参数）。

**工作量**：M（3-5 天）。schema 加 1 字段 + 1 个发现页 + 1 个申请 API + 审批 UI。

### Top 2：CI/CD + 监控告警 + 数据库备份 [D1+D2+D3]

**方案概要**：
- **CI/CD**：`.github/workflows/ci.yml`（typecheck+test+build，PG service container 跑 migrate+smoke）+ `release.yml`（tag 触发，docker build+push，桌面端多平台 matrix build+sign）。
- **监控**：collab-api 接 `nestjs-pino`（JSON 结构化日志）+ `@sentry/nestjs`（异常上报）+ `/api/health/ready`（DB 探活 `prisma.$queryRaw('SELECT 1')`）+ `/metrics` endpoint（prom-client）。
- **备份**：生产用托管 PG（RDS/Cloud SQL）开自动快照+PITR；自建场景 cron+pg_dump 到对象存储+定期 restore 演习。
- **告警**：Sentry → Slack/邮件。

**工作量**：L（7-10 天）。CI/CD 2-3 天 + 监控 2-3 天 + 备份+演练 2-3 天。

### Top 3：支付通道接入 + 钱包充值/提现 [C1+C5]

**方案概要**：
- 新增 schema：`PaymentOrder`（orderId/channel/amount/status/callback）、`WithdrawRequest`（userId/amount/bankInfo/status/approvedBy）、`EnterpriseProfile`（KYC）。
- 充值流程：用户发起 → 生成 PaymentOrder → 调微信/支付宝/Stripe 统一下单 → 支付回调验签 → 更新 Wallet balanceCents + 记 WalletTransaction。
- 提现流程：卖家申请 WithdrawRequest → admin 审核流（requested→reviewing→paid/rejected）→ 手动/自动打款。
- Wallet.tsx 增加「充值」「提现」两个 Tab + 表单。

**工作量**：L（10-15 天）。支付通道接入+回调验签 3-5 天 + 提现审核流 3 天 + UI 2-3 天 + 测试 2 天。

### Top 4：平台抽成机制 [C2]

**方案概要**：
- 决策抽成比例（建议默认 15-30%，admin 可配置）。
- Purchase 表加字段：`platformFeeCents`、`sellerNetCents`、`commissionRateBps`、`settleStatus`、`refundedAt`。
- 新增 `PlatformFeePolicy` 表（全局默认 + 单插件/作者覆盖 + 时段）。
- `economy.service.ts:purchasePlugin` 改为：`sellerNet = price - platformFee`，seller 加 sellerNet，platformFee 归系统收入账户。
- seller 收入改为「待结算」，T+7 或月结后才进可提现余额。
- admin Dashboard 新增「平台累计抽成」「月收入」指标。

**工作量**：M（5-7 天）。schema 改造 1 天 + 逻辑改造 2 天 + 结算 cron 1 天 + admin UI 1-2 天。

### Top 5：找回密码 + 邮箱验证 [A3]

**方案概要**：
- 接入 SMTP（nodemailer / AWS SES / 阿里云邮件推送）。
- 新增 `POST /api/auth/forgot-password`（生成 reset token，发重置链接邮件）+ `POST /api/auth/reset-password`（token 验证 + 改密 + tokenVersion++）。
- 注册后发验证邮件，`User.emailVerified` 字段，未验证 7 天后清理。
- admin 创建用户默认密码 `ChangeMe123!` → 首登强制改密（User.mustChangePassword 字段）。

**工作量**：M（3-5 天）。SMTP 接入 1 天 + 3 个 API 1-2 天 + UI 1 天 + 测试 1 天。

### Top 6：强制 HTTPS + 关闭 insecure flag + 隐私政策 [E1+E8+D8]

**方案概要**：
- `tauri.conf.json` 生产构建关闭 `dangerousInsecureTransportProtocol`，强制 HTTPS endpoint。
- 提供 `deploy/Caddyfile.example`（自动 Let's Encrypt）或 `deploy/nginx.conf`。
- 仓库提供隐私政策模板 + 用户协议 + 注册同意勾选。
- apiKey decrypt 端点考虑短期一次性 token（或桌面端本地解密 + OS keyring 保护）。

**工作量**：S-M（2-4 天）。HTTPS 配置 0.5 天 + 隐私政策撰写 1-2 天 + 注册流程改造 0.5 天。

### Top 7：新手引导 + 环境就绪检测 [A2]

**方案概要**：
- 首次登录后弹「新手任务清单」（5 步：装 CLI / 配模型 / 发起首条对话 / 预览 / 上传），完成打勾，引导跳转。
- Composer 上方挂「环境未就绪」横幅（检测 CLI 是否安装 + apiKey 是否配置），一键跳转设置。
- 预置内置 demo 插件，首屏「一键运行」让用户立即看到产品价值。
- 客户端打包时注入默认生产后端地址（隐藏「高级设置」）。

**工作量**：M（3-5 天）。任务清单组件 2 天 + 环境检测横幅 1 天 + demo 集成 1 天。

### Top 8：订阅/套餐层 + B 端发票 [C3+C6]

**方案概要**：
- 新增 schema：`Plan`（planCode/interval/priceCents/features/trialDays/status）、`Subscription`（userId/teamId/planId/status/currentPeriodEnd/cancelAt）、`Invoice`/`InvoiceTitle`（开票抬头/税号/订单关联）。
- SIGNUP_BONUS 改为 `Plan.trialDays`（N 天试用），试用到期触发付费墙 + 升级 CTA。
- admin 后台新增 finance/orders/refunds/invoices/withdrawals/plans 等 view。
- consume() 接到 LLM 用量计量（即使平台不自计费，套餐限额需要计量）。

**工作量**：L（10-15 天）。schema+订阅生命周期 3-4 天 + 发票流程 3 天 + admin UI 3-4 天。

### Top 9：登录限流 + 密码策略 [B1+E3]

**方案概要**：
- 引入 `@nestjs/throttler`，login/register 设 10 次/分钟/IP，purchase/upload 设中等限流。
- 密码策略：MinLength(8) → 加复杂度要求（大写+小写+数字）+ top-1000 弱密码字典校验。
- 失败 N 次临时锁定（Redis 计数器，15 分钟解锁）。

**工作量**：S（1-2 天）。throttler 接入 0.5 天 + 密码策略 0.5 天 + 锁定逻辑 0.5 天。

### Top 10：AI 生成成功率看板 + 错误反馈 + 财务指标 [A4+C7]

**方案概要**：
- 后端记录每次 CLI session：exit_code/duration/是否产出 manifest/失败 kind（新建 `CliSessionLog` 表或扩展 AuditLog）。
- admin Dashboard 新增「生成质量」区块：成功率、平均轮数、失败 top 原因、热门 prompt。
- admin Dashboard 新增「财务概览」区块：GMV（月/累计）、平台抽成、付费用户数、付费转化率、Top 5 热销插件。
- 新增 `GET /api/admin/finance/overview`、`/api/admin/finance/purchases`、`/api/admin/finance/sellers`。
- 错误卡片增加「一键复制错误信息」「联系支持」按钮。

**工作量**：M（5-7 天）。数据采集 2 天 + 看板接口 2 天 + admin UI 2 天。

---

## 五、结论

### 平台距离「可商业上线」还差多远？

**判断：当前状态适合内部/小范围灰度试用，不适合直接面向公网用户商业运营。距离可商业上线还差约 6-8 周的集中补齐工作（假设 2-3 人团队全职投入）。**

平台已具备的技术骨架质量较高——核心安全（SQL 注入零风险、AES-256-GCM 加密、JWT 吊销机制、路径穿越防御、进程组清理）、核心交互（AI 对话生成→预览→上传→审核→市场分发）、工程代码注释中大量已修复历史缺陷标记（XSEC/AUTH/SPAWN/SCRIPT/CAP 系列），说明经过了一轮系统性审查。**代码层面没有致命漏洞。**

### 关键阻塞是什么？

**三大阻塞（不解决则无法商业运营）：**

1. **用户进不来**（A1+A2+A3）：注册即孤儿、无引导、无找回密码——新用户留存链路断裂。这是最高优先级，因为所有后续商业价值的前提是「有用户」。

2. **钱流不通**（C1+C2+C5）：无支付通道、无平台抽成、无充值提现——商业闭环的物理前提不成立。目前是「P2P 转账 demo」级别，不是「商业平台」级别。需要先做产品决策（付费主体是用户还是团队？抽成比例？），再编码。

3. **生产不可控**（D1+D2+D3）：无 CI/CD、无监控告警、无数据库备份——上线即裸奔，第一次故障就是灾难。这三项是「从能用到能稳定运营」的硬门槛。

**建议执行顺序**：
- 第 1-2 周：Top 1（团队发现）+ Top 5（找回密码）+ Top 7（新手引导）+ Top 9（限流）——解锁用户进出和基础安全。
- 第 3-4 周：Top 2（CI/CD+监控+备份）+ Top 6（HTTPS+隐私政策）——解锁生产安全底线。
- 第 5-6 周：Top 3（支付+充值提现）+ Top 4（平台抽成）——解锁商业闭环。
- 第 7-8 周：Top 8（订阅+发票）+ Top 10（看板+指标）——解锁持续运营能力。

**一句话总结**：lingfang-platform 的技术骨架扎实、核心链路已通，但商业闭环（支付/抽成/订阅）、运营基础设施（CI/CD/监控/备份）、用户旅程完整性（注册/引导/找回密码）三大块存在系统性缺口。补齐这三大块后，平台具备商业运营条件。