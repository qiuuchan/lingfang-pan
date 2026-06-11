# Database And Transactions

## SQLite Schema Rules

The active database is SQLite. Migrations use these conventions:

- UUID columns are `BLOB`.
- JSON columns are `TEXT` and are bound/read as `serde_json::Value`.
- timestamps are `TEXT` with `CURRENT_TIMESTAMP` or `chrono::DateTime<Utc>`.
- booleans are `INTEGER(0/1)`.
- money is stored in cents.

Reference files:
- `apps/server/migrations/0001_init.sql`
- `apps/server/migrations/0003_economy.sql`
- `apps/server/src/db.rs`

## Query Rules

Use `sqlx::query` / `query_as` / `query_scalar` with `.bind(...)`. Do not concatenate user input into SQL.

The marketplace search is the current exception that formats only a whitelisted `ORDER BY` fragment after matching `sort` against fixed values. Keep that shape if adding sortable fields.

Reference file:
- `apps/server/src/routes/marketplace.rs`

## Tenant Filtering

Every tenant-owned table query must bind `ctx.tenant_id` unless the route is intentionally platform-wide, such as approved marketplace search or platform review.

Examples:
- `fetch_draft()` filters `plugin_drafts` by `id` and `tenant_id`.
- `/llm/proxy` checks installation with `tenant_id` before forwarding.
- wallet purchase records both buyer user and buyer tenant.

## Transaction Boundaries

Use a transaction for multi-row financial or install operations:

- `wallet::purchase()` conditionally debits the buyer, credits the seller, writes purchase, and writes both transaction rows.
- `marketplace::install_from_market()` writes installation and increments install count together.

If any write in these flows fails, the operation should fail visibly and roll back.

