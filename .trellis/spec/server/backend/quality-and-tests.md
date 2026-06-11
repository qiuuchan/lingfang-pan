# Quality And Tests

## Module Boundaries

Keep shared infrastructure in top-level modules:

- `config.rs` for environment-derived config
- `db.rs` for pool and migrations
- `auth.rs` for JWT, password hashing, and extractors
- `error.rs` for HTTP error mapping
- `llm.rs` for gateway calls and generation parsing
- `routes/*` for HTTP handlers

Avoid moving business route logic into `main.rs`; `main.rs` should remain startup wiring.

## Tests

Current unit tests cover deterministic helpers in:

- `apps/server/src/llm.rs`
- `apps/server/src/crypto.rs`

Add tests near pure parsing, validation, crypto, accounting, and authorization helpers. Prefer unit tests for helper functions and integration-style tests only when a real DB flow needs coverage.

Backend unit tests should finish within 60 seconds:

```bash
cargo test -p server
```

## Failure Style

Startup failures for invalid DB URL, failed SQLite connection, failed migration, or bind failure are hard failures. Runtime request failures use `AppError`.

Do not add in-memory/demo data fallbacks, fake LLM responses, or broad `catch and continue` paths for server features.

