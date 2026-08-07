# collab-api 新增 wallet 与 marketplace 模块

## Goal

在 collab-api(NestJS) 新增用户级钱包与公共市场模块，迁移 server(Rust) 的 wallet.rs + marketplace.rs 业务逻辑，使 desktop 改连 /api/* 后能正常使用钱包与市场。

## Parent

06-12-backend-collab-unification

## Requirements

- R1 新增 Prisma 模型（用户级，区别于已有的团队级 BalanceLedger）：`Wallet`、`WalletTransaction`、`Purchase`、`PluginRating`（用户评分，区别于已有的 PluginReview 审核记录）
- R2 `WalletController`：`GET /wallet`（余额+流水）、`POST /wallet/purchase`（购买结算）
- R3 `MarketplaceController`：`GET /marketplace/search`、`GET /marketplace/plugins/:id`、`POST /marketplace/install`、`POST /marketplace/rate`
- R4 购买单事务结算：买家条件扣款（余额不足→402）→卖家加款→购买记录+双向流水；幂等（已购买不重复扣费）
- R5 评分前置条件：付费看购买、免费看安装；UNIQUE(pluginId,userId) 重复评分更新
- R6 响应 JSON shape 与 server 一致（snake_case：balance_cents/amount_cents/install_count/price_cents/avg_score 等），desktop 仅改路径前缀即可
- R7 注册赠送 ¥10（1000 分）：懒创建（首次访问钱包时 upsert）
- R8 注册到 CollabModule；新增 prisma migration

## Acceptance Criteria

- [ ] AC1 `prisma migrate dev` 生成 migration 无报错
- [ ] AC2 `curl /api/wallet`（带 token）返回 `{ balance_cents, transactions: [...] }`
- [ ] AC3 `curl /api/marketplace/search` 返回 `{ plugins: [...] }`
- [ ] AC4 购买：余额不足返回 402 `insufficient_balance`；成功扣款+卖家加款+流水
- [ ] AC5 重复购买幂等；重复评分更新
- [ ] AC6 `pnpm -C apps/collab-api build` 通过
- [ ] AC7 Swagger `/api/docs` 出现 wallet/marketplace 路由

## Out of Scope

- desktop 调用适配（子任务 C）
- server 端清理（子任务 D）
- 真实支付接入（仍是内部账本）
- 平台审核流复用（已有 PluginReview + AdminController）

## Notes

- 不改 auth.service（注册时建钱包改用懒创建）
- 用户钱包与团队 BalanceLedger 是两套，不混用
