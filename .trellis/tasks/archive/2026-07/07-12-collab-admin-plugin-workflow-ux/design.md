# Design: 后台管理端动态加载与治理中心重构

## 1. Architecture And Boundaries

本任务是父任务，不直接承载业务实现。实现按五个子任务依次推进，父任务负责统一契约、依赖顺序和最终集成验收。

```text
collab-admin view
  -> cancellable api client
  -> paged summary endpoint
  -> Prisma select + skip/take/count

row click / tab activation
  -> entity detail endpoint
  -> related paged endpoint
  -> manifest/files/history endpoint
```

Boundaries:

- `packages/contract` 拥有共享分页、治理 summary/detail 和跨层枚举契约。
- `apps/collab-api` 拥有分页查询、字段投影、权限、状态转换和并发一致性。
- `apps/collab-admin/src/lib` 拥有请求取消、资源状态和 query 构建。
- `apps/collab-admin/src/components/ui` 拥有纯展示型异步状态、分页、表格和可访问抽屉。
- 业务 view 只组合筛选、当前页、选中对象和领域动作，不自行重定义 API payload。

## 2. Task Tree And Ordering

### 2.1 `07-12-admin-ui-foundation`

建立所有后续 view 依赖的基础：外部 AbortSignal、资源状态、受控服务端分页、Radix DetailSheet、响应式 Table、扁平 Section、Shell 和 Sidebar。

### 2.2 `07-12-admin-governance-center`

依赖 UI foundation。新增包级插件治理契约/API，合并插件管理和审批管理为“治理中心”，修正并发审核、市场当前版和下架语义。

### 2.3 `07-12-admin-core-data-loading`

依赖 UI foundation。迁移用户、管理员、团队、审计、版本和角色列表，拆分昂贵详情和关联 Tab。

### 2.4 `07-12-admin-billing-data-loading`

依赖 UI foundation。迁移资源池、渠道、价格、灵石账户、调用日志和 API Key，消除 Credits N+1 和只读 GET 写库。

### 2.5 `07-12-admin-dashboard-settings-lazy`

依赖 UI foundation，治理中心完成后接入其待办导航。Dashboard 首屏只请求核心指标；Settings 仅挂载当前配置 Tab。

子任务 2.2、2.3、2.4 可在 2.1 稳定后并行；2.5 最后做跨页面收敛和入口校验。

## 3. Dynamic Loading Contract

### 3.1 Page Envelope

无界列表统一响应：

```ts
type AdminPage<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};
```

Query baseline:

- `page`: integer, default 1, minimum 1.
- `pageSize`: integer, default 20, minimum 1, maximum 100.
- `q`: trimmed search term.
- 领域 filter 使用显式枚举字段。
- `sort` 和 `order` 只允许 route 白名单，不接受任意数据库字段。

后端使用同一 `where` 同时执行 `findMany` 和 `count`。列表查询使用 `select`，禁止通过宽 `include` 把大 JSON、完整关联、历史和敏感字段带到首屏。

### 3.2 List/Detail Separation

- 列表只返回表格可见摘要。
- 点击行后才请求实体 overview。
- 关联集合在对应详情 Tab 首次打开时分页请求。
- 大 JSON、manifest、文件元数据、审计 metadata、版本 notes/assets、调用详情单独请求。
- 文件正文和插件制品正文永不通过管理端详情接口返回。

### 3.3 Bounded Exceptions

允许整批加载的对象必须有代码或模型约束的明确上限：权限注册表、状态枚举、单例配置和用户主动触发的单次测试结果。业务表即使当前数据量小，也按无界集合处理。

### 3.4 Cancellation And Stale Responses

`api()` 增加外部 `signal`。领域 hook 在 page/filter/entity/tab 变化时 abort 旧请求，并用请求序号作为第二层保护。外部取消不显示错误 toast；真实超时和网络失败仍走 `ApiError`。

详情按实体 ID 做 view 会话级缓存。动作成功后只失效当前实体、当前列表页、相关审核历史和 Dashboard 待办，不做全量页面重载。

## 4. Shared UI Design

- `AsyncResource`: `idle/loading/ready/empty/error` 的纯展示组件，支持 skeleton、retry 和领域空状态。
- `DetailSheet`: 内部改用 Radix Sheet，固定 header/content/footer，手机全宽，桌面 `md/lg/xl` 宽度。
- `Pagination`: 完全受控；桌面显示页码，手机只显示上一页、当前页/总页数、下一页；逐步删除客户端 `usePagination`。
- `Table`: 可见细滚动条，业务页隐藏次要列或使用紧凑移动布局。
- `Section`: 无外层 Card 的页面区块，可带 actions；卡片仅用于重复实体或真正有边界的工具。
- `App` Header: 紧凑无浮卡；主内容单滚动区；移除每页重复说明和固定 Footer 的隐式网络请求。
- `Sidebar`: 桌面 collapsed 与 mobile open 分离；移动 Sheet 永远显示文字和分组。

## 5. Governance Center

Navigation changes:

- 移除独立 `plugins` / `applications` 导航，新增 `governance`。
- 治理中心包含“插件发行”和“团队管理员申请”两个 Tab。
- 只挂载当前 Tab；切换后首次加载其列表。

Plugin package list:

```text
GET /api/admin/plugin-packages?page=&pageSize=&q=&reviewStatus=&listingStatus=&sort=&order=
```

每个包一行，摘要包含包、owner team、listing 状态、当前市场发行版、最新 SemVer 发行版、发行版数和待审核数。当前市场版只按 ACTIVE listing 的 `currentReleaseId` 判断。

On open:

1. 使用行摘要立即打开 Sheet。
2. 请求包 overview 和第一页 release summaries。
3. 选择 release 后请求核心详情。
4. Manifest、文件清单和审核历史 Tab 首次打开才请求。
5. 文件清单服务端对现有 JSON 切片分页，不新增文件表。

Application list:

```text
GET /api/admin/team-admin-applications?page=&pageSize=&status=&q=
GET /api/admin/team-admin-applications/:id
```

列表不携带完整理由和处理详情；点击行才加载。只有 PENDING 显示动作。

## 6. State Consistency

审核动作使用事务内条件更新抢占：

```ts
updateMany({ where: { id, marketReviewStatus: 'PENDING' }, data: nextState });
```

影响行数不是 1 时返回 `409 conflict`，失败者不得写 review、audit、team、membership 或通知。

同一包多个版本并发通过时，listing 的 `currentReleaseId` 从所有 PUBLISHED + APPROVED 版本中按严格 SemVer 选最大值。通过旧版本不会把市场当前版本降级；显式市场回滚不属于本任务。

下架使用 package 级新接口，并要求 listing 当前为 ACTIVE。保留旧 release delist 路由一版作为兼容代理，但新 UI 不再调用。下架保留 `currentReleaseId`、发行版、制品和权益；API/UI 在 DELISTED 状态不显示“市场当前版”。

团队申请通过/驳回同样先在事务内抢占 PENDING。通过者在同一事务创建团队、系统角色、membership 和审计，通知在提交后发送。

## 7. Other Admin Views

Core entities:

- Users/Admins: 同一分页 endpoint，通过 `platformRole` 过滤；详情和 activity 分页。
- Teams: 列表不 include memberships；用户 options 只在创建/分配时加载；详情子 Tab 分页。
- Audit: list 不返回 metadata；点击后详情加载。
- Releases: list 不返回 notes/assets；点击后详情加载。
- Roles: list 返回 `permissionCount`；权限字典只在编辑器打开时加载。

Billing:

- Pools/Channels/Pricing/API Keys: 服务端分页；选择器使用硬上限 options endpoint。
- Channels 只加载当前 kind Tab，详情和 pricing 在编辑器打开后请求。
- Credits 增加团队余额分页摘要，单查询返回余额，不调用会创建账户的读取 helper；ledger 分页。
- Call logs 列表不返回 requestSummary/IP/error detail，点击后加载详情。

## 8. Dashboard And Settings

Dashboard 首屏只请求 `/api/admin/dashboard`，显示紧凑核心指标和两条治理待办。生成质量、财务分析只有用户打开对应区块时才请求。待审核插件数改读 `PluginRelease.marketReviewStatus=PENDING`。

Settings 拆为基础、邮件、安全、发布源、搜索五个 Tab。默认只挂载基础 Tab；`visitedTabs` 保留访问过的 Tab 和未保存草稿。每个 Tab 有独立 AsyncResource，加载失败时不渲染可保存的空表单。

## 9. Compatibility And Rollout

- API 采用 additive migration：新分页/详情接口先上线，旧宽列表保留一版但新 UI 不调用。
- 不修改 `.lfplugin`、桌面安装器、远端目录和市场权益契约。
- Contract 先于 API 和前端落地；现有 plugin registry camelCase 保持不变。
- 无需数据库破坏性迁移。若分页过滤缺少索引，只添加非破坏性索引并支持回滚代码时保留。
- Rollback 顺序：先回滚 collab-admin，再回滚新增 API；共享 contract 的新增 schema 可保留。

## 10. Validation Strategy

- Contract: typecheck + schema tests。
- Backend: pagination、projection、权限、并发状态、N+1 和 GET 无写库测试；60 秒硬超时。
- Frontend: typecheck/build；网络请求断言；详情竞态；移动响应式。
- Visual: 1440x900、1024x768、768x1024、390x844、360x800、1280x720。
- Accessibility: Sheet focus trap、ESC、焦点归还、背景滚动锁、按钮 aria-label 和键盘行入口。
