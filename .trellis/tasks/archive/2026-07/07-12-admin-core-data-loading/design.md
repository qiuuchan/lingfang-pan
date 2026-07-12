# Design: 核心管理动态加载

## Shared Query

复用父任务分页 envelope 和 backend pagination DTO/helper。每个 route 白名单定义 filter/sort。

## Endpoint Matrix

### Users And Admins

```text
GET /api/admin/users?page=&pageSize=&q=&status=&platformRole=&sort=&order=
GET /api/admin/users/:id/detail
GET /api/admin/users/:id/logins?page=&pageSize=
GET /api/admin/users/:id/teams?page=&pageSize=
GET /api/admin/users/:id/wallet?page=&pageSize=
GET /api/admin/admins/:id/activity?page=&pageSize=
GET /api/admin/users/options?q=&limit=
```

现有 detail 可以保留 overview 字段，但不再捆绑所有时间线。options 硬上限并只在选择器打开后调用。

### Teams

```text
GET /api/admin/teams?page=&pageSize=&q=&status=
GET /api/admin/teams/:id/detail
GET /api/admin/teams/:id/members?page=&pageSize=&q=
GET /api/admin/teams/:id/roles?page=&pageSize=
GET /api/admin/teams/:id/plugins?page=&pageSize=
GET /api/admin/teams/:id/purchases?page=&pageSize=
GET /api/admin/teams/:id/ledger?page=&pageSize=
```

列表只 select team summary + aggregate counts，不 include member rows。详情 Sheet 各 Tab 独立资源。

### Audit

```text
GET /api/admin/audit-logs?page=&pageSize=&category=&q=&actorId=&targetType=
GET /api/admin/audit-logs/:id
```

复用现有 category/q AND 语义。list 只返回 action、actor 摘要、target、createdAt；metadata 在 detail。

### Releases

```text
GET /api/admin/releases?page=&pageSize=&channel=&status=&q=
GET /api/admin/releases/:id
```

summary 不含 notes/assets；详情返回完整 release 和 assets。

### Roles

```text
GET /api/admin/roles?page=&pageSize=&q=&scope=
GET /api/admin/roles/:id
```

列表返回 permissionCount。`roles/permissions` 和 `permission-groups` 仍是有界参考数据，只在编辑器打开时加载。

## Frontend Migration

- 每个 view 保存 page/pageSize/applied filters，不再使用 `usePagination(items)`。
- 搜索使用显式提交或 250-350ms debounce，变化时回到第 1 页。
- 抽屉由 row summary 立即打开，detail AsyncResource 随 ID 启用。
- 子 Tab 用 `enabled=activeTab===...`，访问后可缓存。
- mutations 只刷新当前页和当前 detail。

## Compatibility

优先让现有 route 接受新 query 并返回新 envelope；如旧调用方存在，短期可同时返回旧命名 key，但新 admin 统一消费 `items`。

