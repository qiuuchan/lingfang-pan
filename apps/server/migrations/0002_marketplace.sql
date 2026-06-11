-- M4 市场：插件评分（SQLite 方言）。
-- 一个用户对一个插件只能评分一次（PRIMARY KEY 约束）。

CREATE TABLE plugin_ratings (
  plugin_id  TEXT NOT NULL REFERENCES plugins(id),
  user_id    BLOB NOT NULL REFERENCES users(id),
  tenant_id  BLOB NOT NULL REFERENCES tenants(id),
  score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (plugin_id, user_id)
);

-- 市场可见性：插件可声明为对所有租户可见（marketplace）。布尔用 INTEGER(0/1)。
ALTER TABLE plugins ADD COLUMN marketplace INTEGER NOT NULL DEFAULT 0;

-- 安装计数（用于市场排序）。
ALTER TABLE plugins ADD COLUMN install_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_plugins_marketplace ON plugins(marketplace) WHERE marketplace = 1;
