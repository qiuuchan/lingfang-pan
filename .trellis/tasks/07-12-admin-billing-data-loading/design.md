# Design: 计费与模型管理动态加载

## Endpoint Matrix

### Pools

```text
GET /api/admin/billing/pools?page=&pageSize=&q=&scope=
GET /api/admin/billing/pools/options?q=&limit=
```

### Channels

```text
GET /api/admin/billing/channels?page=&pageSize=&kind=&q=&status=
GET /api/admin/billing/channels/:id
GET /api/admin/billing/channels/:id/pricing?page=&pageSize=
```

list 仅返回名称、kind、状态、pool 摘要和 model count；baseUrl、description、models、凭据状态在 detail。

### Pricing

```text
GET /api/admin/billing/pricing?page=&pageSize=&capability=&tier=&q=
```

### Credits

```text
GET /api/admin/billing/credits/teams?page=&pageSize=&q=&status=
GET /api/admin/billing/credits/teams/:teamId
GET /api/admin/billing/credits/teams/:teamId/ledger?page=&pageSize=
```

团队列表通过 relation/select 或 aggregate 一次返回余额与成员数。未存在账户时投影余额 0，不调用 `ensureAccount`，不写初始奖励。账户创建仅保留在明确 mutation/业务入口。

### Call Logs

```text
GET /api/admin/billing/call-logs?page=&pageSize=&teamId=&status=&kind=&tier=&q=
GET /api/admin/billing/call-logs/:id
```

summary 不含 requestSummary、ipAddress 和完整 error detail。

### API Keys

```text
GET /api/admin/billing/api-keys?page=&pageSize=&teamId=&status=&q=
```

只投影 masked key、scope、status、timestamps 和 team summary。

## Frontend

- Channels 使用受控 Tabs；只挂载当前 kind。
- 将原独立 Pricing/Billing View 合并为模型接入的第三个“模型价格”Tab，删除不可达 view 分支。
- 每个列表使用共享 AsyncResource/Pagination。
- 编辑器打开时才加载详情和 options；访问后保留未保存草稿。
- Credits 团队行打开 DetailSheet 后加载 overview/ledger。
- Call Log 行打开 DetailSheet 后加载重字段。

## Query Safety

- 所有 pageSize 最大 100，options limit 最大 50。
- sort/order 白名单。
- count 与 list 共享 where。
- GET handler 不调用会产生数据库写入的 ensure helper。
- API Key list/detail 使用白名单 select，查询层不读取 keyHash/plaintextKey。
