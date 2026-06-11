-- LingFang 初始 schema（SQLite 方言）。
-- 所有业务表带 tenant_id，服务端强制按租户隔离。
-- 类型约定：UUID 列用 BLOB（匹配 sqlx Uuid 默认编码）；JSON 用 TEXT；时间用 TEXT（CURRENT_TIMESTAMP）；布尔用 INTEGER(0/1)。

CREATE TABLE users (
  id            BLOB PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tenants (
  id            BLOB PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  owner_user_id BLOB NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE memberships (
  tenant_id BLOB NOT NULL REFERENCES tenants(id),
  user_id   BLOB NOT NULL REFERENCES users(id),
  role      TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'active',
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE plugin_drafts (
  id            BLOB PRIMARY KEY,
  tenant_id     BLOB NOT NULL REFERENCES tenants(id),
  created_by    BLOB NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL DEFAULT '',
  source_prompt TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'generating',
  files         TEXT NOT NULL DEFAULT '[]',
  turns         TEXT NOT NULL DEFAULT '[]',
  diagnostics   TEXT NOT NULL DEFAULT '[]',
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE plugins (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  version          TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  author_tenant_id BLOB NOT NULL REFERENCES tenants(id),
  runtime_type     TEXT NOT NULL,
  entry            TEXT NOT NULL,
  capabilities     TEXT NOT NULL DEFAULT '[]',
  visibility       TEXT NOT NULL DEFAULT 'tenant',
  status           TEXT NOT NULL DEFAULT 'listed',
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE plugin_installations (
  tenant_id    BLOB NOT NULL REFERENCES tenants(id),
  plugin_id    TEXT NOT NULL REFERENCES plugins(id),
  version      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'installed',
  installed_by BLOB NOT NULL REFERENCES users(id),
  installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, plugin_id)
);

CREATE TABLE plugin_grants (
  id           BLOB PRIMARY KEY,
  tenant_id    BLOB NOT NULL REFERENCES tenants(id),
  plugin_id    TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  effect       TEXT NOT NULL
);

CREATE TABLE llm_gateway_bindings (
  id                 BLOB PRIMARY KEY,
  tenant_id          BLOB NOT NULL REFERENCES tenants(id),
  name               TEXT NOT NULL,
  protocol           TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url           TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  models             TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'active',
  created_by         BLOB NOT NULL REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE invocation_audits (
  id          BLOB PRIMARY KEY,
  tenant_id   BLOB NOT NULL REFERENCES tenants(id),
  kind        TEXT NOT NULL,
  plugin_id   TEXT,
  draft_id    BLOB,
  user_id     BLOB NOT NULL,
  capability  TEXT,
  model       TEXT,
  status      TEXT NOT NULL,
  error_code  TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
