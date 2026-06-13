# Design — collab-api wallet + marketplace

## 数据模型（schema.prisma 新增）

用户级模型（与已有的团队级 BalanceLedger 区分）：

```prisma
model Wallet {
  id           String   @id @default(uuid())
  userId       String   @unique
  balanceCents Int      @default(0)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model WalletTransaction {
  id                 String          @id @default(uuid())
  userId             String
  amountCents        Int
  direction          LedgerDirection // 复用已有 enum CREDIT/DEBIT
  reason             String
  pluginId           String?
  counterpartyUserId String?
  createdAt          DateTime        @default(now())
  user               User            @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
}

model Purchase {
  id           String   @id @default(uuid())
  pluginId     String
  buyerUserId  String
  buyerTeamId  String
  sellerUserId String
  priceCents   Int
  createdAt    DateTime @default(now())
  plugin       Plugin   @relation(fields: [pluginId], references: [id], onDelete: Cascade)
  buyer        User     @relation("PurchaseBuyer", fields: [buyerUserId], references: [id])
  seller       User     @relation("PurchaseSeller", fields: [sellerUserId], references: [id])

  @@unique([pluginId, buyerUserId])
  @@index([buyerUserId])
}

model PluginRating {
  id        String   @id @default(uuid())
  pluginId  String
  userId    String
  teamId    String
  score     Int
  comment   String   @default("")
  createdAt DateTime @default(now())
  plugin    Plugin   @relation(fields: [pluginId], references: [id], onDelete: Cascade)
  user      User     @relation("PluginRater", fields: [userId], references: [id])

  @@unique([pluginId, userId])
  @@index([pluginId])
}
```

User 模型需补反向关系字段：`wallets Wallet[]`、`walletTransactions WalletTransaction[]`、`purchasesBuyer Purchase[] @relation("PurchaseBuyer")`、`purchasesSeller Purchase[] @relation("PurchaseSeller")`、`pluginRatings PluginRating[] @relation("PluginRater")`。

Plugin 模型需补：`purchases Purchase[]`、`ratings PluginRating[]`。

## 业务逻辑（翻译自 server，但用 Prisma）

### Wallet（EconomyService）
- `getWallet(userId)`：`ensureWallet`（upsert，首次 balance=1000 赠送）→ 查最近 100 条 WalletTransaction
- `purchase(userId, pluginId)`：
  1. 查 plugin（marketplace + APPROVED + priceCents>0）
  2. 校验 seller 存在、非自己
  3. 幂等：已 Purchase → 返回 already_purchased
  4. `$transaction`：条件扣款（wallet.balanceCents>=price 的 updateMany，受影响行数=0 则 throw insufficientBalance）→ 卖家钱包 upsert 加款 → 建 Purchase → 双向 WalletTransaction（debit purchase / credit sale）

Prisma 条件扣款用 `prisma.wallet.updateMany({ where: { userId, balanceCents: { gte: price } }, data: { balanceCents: { decrement: price } } })`，`count===0` 即余额不足。

### Marketplace（MarketplaceService）
- `search(q, sort)`：查 Plugin（marketplace+APPROVED+ENABLED），关键词 LIKE name/description，左连 ratings 算 avg。Prisma 需 `findMany + include ratings + 内存聚合`（或 `groupBy`）。排序 installs/rating/recent
- `detail(userId, pluginId)`：查 plugin + ratings + 用户是否 Purchase + 本团队是否 PluginInstallation + can_rate 判定
- `install(userId, pluginId)`：付费校验 Purchase；`$transaction` upsert PluginInstallation + plugin.installCount++
- `rate(userId, pluginId, score, comment)`：校验消费（付费看 Purchase、免费看 Installation）→ upsert PluginRating（UNIQUE(pluginId,userId)）

## 响应 shape（snake_case，与 server 一致）

```
GET /wallet → { balance_cents, transactions: [{ id, amount_cents, direction, reason, plugin_id?, at }] }
POST /wallet/purchase → { status: "purchased"|"already_purchased", plugin_id, price_cents, balance_cents }
GET /marketplace/search → { plugins: [{ id, name, version, description, install_count, price_cents, is_free, avg_score, rating_count }] }
GET /marketplace/plugins/:id → { id, name, ..., purchased, installed, can_rate, avg_score, reviews: [{ score, comment, at }] }
POST /marketplace/install → { plugin_id, version, status: "installed" }
POST /marketplace/rate → { ok: true }
```

## 模块组织

- `economy.service.ts`（Wallet + Purchase，~150 行）
- `marketplace.service.ts`（search/detail/install/rate，~180 行）
- `wallet.controller.ts`（~40 行）
- `marketplace.controller.ts`（~50 行）
- 注册到 CollabModule（providers 加 EconomyService/MarketplaceService，controllers 加 Wallet/MarketplaceController）
- 都注入 PrismaService + AuthService（ensureCurrentTeam）

## 关键决策

- **懒创建钱包**：不改 auth.service 的 register，getWallet/purchase 时 `ensureWallet` upsert（首次 1000 分赠送）
- **用户级 vs 团队级**：Wallet/WalletTransaction/Purchase 是用户级；PluginInstallation 是团队级（与 server 一致）
- **PluginRating vs PluginReview**：PluginRating 是用户评分（1-5），PluginReview 是平台审核记录（已有，不动）
- **事务**：Prisma `$transaction`，条件扣款用 updateMany + count 判定

## 风险

- Prisma 的条件扣款需用 updateMany（不能 update + where gte，因 update 唯一性约束）。已确认
- rating 聚合：Prisma findMany + include ratings 后内存算 avg/count（数据量小，50 条内可接受）
- migration 命名：`0003_wallet_marketplace`