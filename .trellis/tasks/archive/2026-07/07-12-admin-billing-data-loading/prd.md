# 计费与模型管理列表动态加载

## Goal

将资源池、模型渠道、模型价格、灵石账户、调用日志和 API Key 改为服务端分页与按需详情，消除 N+1、未打开类型预取和列表 GET 写库。

## Requirements

- Pools、Channels、Pricing、API Keys 使用服务端分页、搜索和领域筛选。
- Channels 只加载当前 CHAT/IMAGE Tab；详情、pool options 和 pricing 只在编辑器打开后请求。
- Credits 提供分页团队余额摘要，单页固定查询数；只读列表不得创建账户、赠送奖励或写数据库。
- Credits ledger 服务端分页，打开团队后才请求。
- Call Logs 列表只返回摘要，不含 requestSummary、IP 和完整错误；点击后加载详情。
- 输入搜索使用提交或 debounce，并取消/忽略旧请求。
- Pools/options 等选择器使用硬上限 options endpoint，不拉全表。
- API Key 列表继续保证不返回 plaintextKey/keyHash。
- 独立模型价格页并入“模型接入”的按需 Tab，移除不可达的孤立 Billing View。
- API Key 查询使用白名单 select，服务内部也不读取不需要的 keyHash。

## Acceptance Criteria

- [x] 所有无界计费列表返回 `items/total/page/pageSize`。
- [x] 未打开 IMAGE Tab、渠道编辑器、团队 ledger 或调用详情时不请求其数据。
- [x] Credits 一页加载无逐团队余额请求，GET 列表零数据库写入。
- [x] Call Logs list 不含重详情字段，点击行才请求详情。
- [x] API Key 任何列表/详情均不返回明文或 hash。
- [x] 模型价格入口可达且未打开时零请求；API Key list 查询不读取 keyHash。
- [x] 选择器 options 有明确 limit。
- [x] 相关 backend tests/typecheck/build 和 admin typecheck/build 通过。

## Out Of Scope

- 改变计费公式、余额语义、渠道执行或 relay 协议。
- 新增支付订单或平台抽成模型。
