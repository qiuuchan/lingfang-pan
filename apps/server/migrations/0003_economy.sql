-- M5 插件经济：审核 + 定价 + 钱包 + 购买（SQLite 方言，内部账本，不接真实支付）。
-- 金额一律以「分」(cents) 计；每个用户初始 1000 分（¥10）测试余额。

-- ---------- plugins：作者归属 + 审核 + 定价 ----------
ALTER TABLE plugins ADD COLUMN author_user_id BLOB REFERENCES users(id);
ALTER TABLE plugins ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE plugins ADD COLUMN review_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE plugins ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0);

-- 回填作者：取作者租户的 owner 作为插件作者（存量插件无 author_user_id）。
UPDATE plugins
SET author_user_id = (SELECT t.owner_user_id FROM tenants t WHERE t.id = plugins.author_tenant_id)
WHERE author_user_id IS NULL;

-- 存量市场插件视为已审核通过，避免上线后被审核过滤而下架。
UPDATE plugins SET review_status = 'approved' WHERE marketplace = 1;

-- 市场列表查询（marketplace + 审核态）与待审列表的支撑索引。
CREATE INDEX idx_plugins_market_review ON plugins(marketplace, review_status);
CREATE INDEX idx_plugins_review_pending ON plugins(review_status) WHERE review_status = 'pending';

-- ---------- users：平台审核员标记 ----------
ALTER TABLE users ADD COLUMN is_platform_admin INTEGER NOT NULL DEFAULT 0;

-- ---------- wallets：每用户一个钱包（余额非负）----------
CREATE TABLE wallets (
  user_id       BLOB PRIMARY KEY REFERENCES users(id),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- wallet_transactions：钱包流水（审计来源，与 invocation_audits 分离）----------
-- 主键由应用层（Uuid::new_v4）提供，不依赖数据库默认。
CREATE TABLE wallet_transactions (
  id                   BLOB PRIMARY KEY,
  user_id              BLOB NOT NULL REFERENCES users(id),
  amount_cents         INTEGER NOT NULL,
  direction            TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  reason               TEXT NOT NULL,
  plugin_id            TEXT REFERENCES plugins(id),
  counterparty_user_id BLOB REFERENCES users(id),
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_wallet_tx_user ON wallet_transactions(user_id, created_at DESC);

-- ---------- purchases：购买记录（一个用户对一个插件至多一条）----------
CREATE TABLE purchases (
  id              BLOB PRIMARY KEY,
  plugin_id       TEXT NOT NULL REFERENCES plugins(id),
  buyer_user_id   BLOB NOT NULL REFERENCES users(id),
  buyer_tenant_id BLOB NOT NULL REFERENCES tenants(id),
  seller_user_id  BLOB NOT NULL REFERENCES users(id),
  price_cents     INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (plugin_id, buyer_user_id)
);

-- 回填：为所有现有用户建钱包并发放 1000 分初始测试余额 + 一条注册赠送流水。
INSERT OR IGNORE INTO wallets (user_id, balance_cents)
SELECT id, 1000 FROM users;

INSERT INTO wallet_transactions (id, user_id, amount_cents, direction, reason)
SELECT randomblob(16), id, 1000, 'credit', 'signup_bonus' FROM users;
