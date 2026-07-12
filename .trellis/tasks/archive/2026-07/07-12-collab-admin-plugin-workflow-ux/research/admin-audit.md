# 后台管理端审计记录

## Scope

本次审计覆盖：

- `apps/collab-admin` 的 Shell、导航、共享 UI、业务 view 和请求触发时机。
- `apps/collab-api` 的管理端列表、详情、审核与统计接口。
- `packages/contract` 的插件 registry 契约与跨层类型边界。
- 已归档任务 `07-11-plugin-package-registry-rebuild` 和本地会话历史中的既有产品决策。

## Existing Decisions Recovered

- 市场审核绑定具体 `PluginRelease`，每个新版本都需要重新审核。
- 审核通过后市场 listing 指向审核通过的发行版；历史发行版、制品和已购权益不可因驳回或下架被物理删除。
- 管理端只查看 manifest、能力、文件元数据、版本、大小和 SHA，不加载插件文件正文。
- 设备安装状态属于桌面端，不进入 collab-admin 的远端治理模型。

Sources:

- `.trellis/tasks/archive/2026-07/07-11-plugin-package-registry-rebuild/{prd,design,implement}.md`
- `.trellis/spec/collab-api/backend/plugin-package-registry.md`
- `trellis mem context 019f53b5-040 --grep "每个市场版本都重新审核"`

## Confirmed Problems

### Plugin Governance

- `plugin-registry.service.ts::adminReleases()` 固定最多取 500 条发行版，且 `releaseJson()` 为每条带完整 `manifest`。
- 前端在浏览器内搜索、筛选并一次渲染全部命中行，超过 500 条的数据不可达且没有 `total`。
- 同一 ACTIVE 包的所有历史发行版都会收到 package 级 `listingStatus=ACTIVE`，前端因此错误标记为“市场当前版”。
- 详情请求按点击加载，但没有取消或请求序号，慢响应可能覆盖当前对象并造成误审。
- `approveRelease()` / `rejectRelease()` 和团队管理员申请处理均先读后写，并发管理员可能都通过状态检查。
- 详情 API 已返回审核历史，当前 UI 未展示。
- 仪表盘待审核数字仍统计旧 `Plugin.reviewStatus`，不是新的 `PluginRelease.marketReviewStatus`。

### Shared UI And Navigation

- 移动 Sidebar 与桌面折叠 Sidebar 共用 `collapsed` 状态，移动 Sheet 会只显示图标。
- 自制 `DetailSheet` 缺少 Radix 提供的焦点锁定、焦点恢复和背景滚动管理。
- App 页头 Card、Section Card、Table 边框形成多层容器，管理工具信息密度偏低。
- 全局隐藏滚动条，使窄屏表格的横向滚动不可感知。
- 多数 view 把初始空数组同时当作 loading、error 和 empty，失败后会显示“暂无”。
- 现有 `Pagination` 的 hook 只做客户端切片，移动端页码按钮也可能溢出。

### Dynamic Loading

必须迁移到服务端分页和轻量摘要的无界集合：

- 用户、平台管理员、团队、插件包、插件发行版、团队管理员申请。
- 审计日志、应用版本、角色。
- 资源池、渠道、模型价格、灵石账户团队列表和流水、调用日志、API Key。

必须按需加载的昂贵详情：

- 用户登录历史、团队关系、钱包流水。
- 团队成员、角色、插件、购买、账本。
- 插件 manifest、文件清单、审核历史和发行版详情。
- 申请完整理由、审计 metadata、版本 notes/assets、调用日志 request/error/IP 详情。

可整批加载的有界数据：

- `/api/auth/me`、`/api/setup/status`、`/api/platform-info` 单例。
- SMTP、Geetest、Gitee、Search 单例配置，但只在对应设置 Tab 打开后请求。
- 权限注册表、权限模块覆盖、状态枚举和平台枚举。
- 用户主动触发的单次连通性测试结果。

### High-Cost Current Paths

- Dashboard 挂载时并发请求基础指标、生成质量和财务统计；Footer 还请求更新日志。
- Settings 挂载时并发请求平台、SMTP、Geetest、Gitee 和 Search 五个配置域。
- Teams 首屏同时请求全部团队和全部用户；打开详情后再并发五类关联数据。
- Credits 先取全部团队，再逐团队请求余额，形成 N+1；只读余额路径可能触发账户初始化写入。
- Channels 同时请求 CHAT、IMAGE 和全部 pools，未打开的类型也会加载。

## Existing Patterns To Reuse

- 服务端分页参考：`ticket.service.ts::listAdmin()` 和 `dto/ticket.dto.ts`。
- 视图代码分包：`App.tsx` 的 `React.lazy` 与 `view-preload.ts`，hover 仅预载 chunk，不触发业务 API。
- 可访问浮层：`components/ui/sheet.tsx` 基于 Radix Dialog，已有焦点管理。
- 通用分页 UI：`components/ui/pagination.tsx`，保留受控展示，停用客户端 `usePagination`。
- 插件 SemVer 比较：`plugin-semver.ts::compareStrictSemVer()`。
- API 错误边界：`src/lib/api.ts` 和 `ApiError.status/code`。

## Task Split

1. `07-12-admin-ui-foundation`: 请求取消、资源状态、分页 UI、Radix DetailSheet、Shell 与 Sidebar。
2. `07-12-admin-governance-center`: 插件包级治理、申请审批、并发状态保护。
3. `07-12-admin-core-data-loading`: 用户、管理员、团队、审计、版本、角色的服务端分页和详情按需加载。
4. `07-12-admin-billing-data-loading`: 计费与模型管理列表分页、Credits N+1 和详情拆分。
5. `07-12-admin-dashboard-settings-lazy`: Dashboard 首屏收敛、分析按需加载、Settings 分 Tab 加载。

