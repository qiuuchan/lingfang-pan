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

## Vitest + tsc 配置约定（collab-api）

> 2026-06-14 踩坑固化：collab-api 的 `tsc build`（CommonJS）会把 `*.spec.ts` 编进 `dist/`，vitest 默认扫描到 dist 里的 CommonJS spec（`require('vitest')` 在 CJS 下失败），导致测试文件误报 fail（`5 failed | 5 passed`，但 Tests 数其实全绿）。

**必须双保险配置**（缺一会导致 build 后 test 假性失败）：

1. `apps/collab-api/tsconfig.json` 加 `exclude`，让 spec 不进编译产物：
   ```json
   "include": ["src/**/*.ts"],
   "exclude": ["src/**/*.spec.ts", "dist", "node_modules"]
   ```
2. `apps/collab-api/vitest.config.ts` 用 `include` 白名单锁定 src：
   ```ts
   import { defineConfig } from 'vitest/config';
   export default defineConfig({
     test: { environment: 'node', include: ['src/**/*.spec.ts'] },
   });
   ```

验证：`pnpm --filter @lingfang/collab-api build` 后 `find dist -name "*.spec.js"` 应为空；`pnpm test` 直接绿（不需手动 `rm -rf dist`）。

对齐桌面端 `apps/desktop/vitest.config.ts` 同款白名单模式。


