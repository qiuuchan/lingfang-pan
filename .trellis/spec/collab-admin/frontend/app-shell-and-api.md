# collab-admin Shell 与 API 规范

## App Shell

`src/App.tsx` 当前没有 React Router。页面由 `View` 联合类型和 `setView` 控制。新增后台 view 时同步：

- `src/lib/types.ts` 的 `View`
- `src/lib/navigation.ts` 的 `NAV_GROUPS`、`VIEW_LABEL`、`VIEW_GROUP`
- `src/App.tsx` 的 lazy import 和 render 分支

未登录态 landing/login/download/changelog 是独立状态机，不应和后台 `View` 混在一起。

## API Boundary

`src/lib/api.ts` 是唯一通用请求入口：

- `apiBase()` 读取 `VITE_API_BASE_URL` 或 `VITE_COLLAB_API_BASE`；开发环境默认 `http://localhost:19006`，生产构建默认同源。
- 默认请求超时为 `30_000` ms。
- 401 时先尝试 `/api/auth/refresh`，成功后重放原请求一次。
- refresh 失败或仍 401 时清 token 并派发 `UNAUTHORIZED_EVENT`。
- `FormData` 请求必须使用 `formData` 参数，不能手写 multipart `Content-Type`。

## Error Handling

调用方应读取 `ApiError.status` / `ApiError.code`，不要靠中文 message 做分支。

Wrong:

```ts
if (String(error.message).includes('过期')) reset();
```

Correct:

```ts
if ((error as ApiError).status === 401) reset();
```

## Scenario: Collab Admin Docker Same-Origin Deployment

### 1. Scope / Trigger

- Trigger: changing `apps/collab-admin/Dockerfile`, workspace dependencies, `apiBase()`, Compose build args, or production env examples.

### 2. Signatures

- `apiBase() -> string`: explicit `VITE_API_BASE_URL` / `VITE_COLLAB_API_BASE`, otherwise `http://localhost:19006` in Vite dev and `''` in production.
- Admin container: Nginx listens on `19005`, serves `/usr/share/nginx/html`, proxies `/api/` to `http://collab-api:19006`.
- Required production API env: `JWT_SECRET` length >= 16 and `LLM_KEY_ENCRYPTION_KEY` exactly 64 hex characters.

### 3. Contracts

- A blank production API build arg means same-origin requests such as `/api/health`; it must not fall back to the browser host's `localhost:19006`.
- The admin runtime image owns the `/api/` reverse proxy. Compose must not depend on an undeclared host Nginx for its default path.
- Every `workspace:*` dependency used by the admin build must have its `package.json` copied before `pnpm install` and its source copied before `pnpm ... build`.
- `.env.collab.example` must list every production startup-required env key. Secret-shaped examples must be documented as replacement-only values.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Contract manifest/source absent in Docker build context | Admin TypeScript build fails; fix Docker `COPY`, never suppress resulting `any` errors |
| Blank API build args in production | Browser requests same-origin `/api/*` through container Nginx |
| Explicit external API build arg | Browser requests that origin directly |
| Missing/invalid `LLM_KEY_ENCRYPTION_KEY` | API exits at startup with the required 64-hex error |
| API container unavailable | Admin static page remains available; `/api/*` returns 502 until API recovers |

### 5. Good/Base/Bad Cases

- Good: fresh Compose volumes run migrations and seeds, all three containers stay up, and both `:19006/api/health` and `:19005/api/health` return 200.
- Base: standalone Vite development still uses `http://localhost:19006` without extra env configuration.
- Bad: using a static-only `serve` image while building with blank API args; the browser either calls its own localhost or receives the SPA HTML for `/api/*`.

### 6. Tests Required

- Run admin typecheck/build both on the host and through `docker compose ... build` to catch missing workspace source.
- Run `docker compose ... config`, then start with fresh volumes and assert PostgreSQL healthy, API stable (not restarting), and direct/proxied health endpoints return 200 JSON.
- Use an authenticated browser smoke test for every `NAV_GROUPS` view and inspect console/API logs for uncaught errors and 5xx responses.

### 7. Wrong vs Correct

Wrong:

```dockerfile
COPY apps/collab-admin apps/collab-admin
RUN pnpm -C apps/collab-admin build
# workspace:* package source was never copied
```

Correct:

```dockerfile
COPY packages/contract/package.json packages/contract/package.json
RUN pnpm install --filter @lingfang/collab-admin...
COPY packages/contract packages/contract
COPY apps/collab-admin apps/collab-admin
RUN pnpm -C apps/collab-admin build
```

## Scenario: 可取消请求与 token 感知的 401 重放

### 1. Scope / Trigger

- 列表筛选、分页、Tab 或详情对象切换时，调用方必须能取消旧请求。
- 所有带认证的请求都可能在用户重新登录后才返回 401；旧响应不得清除或覆盖新会话。

### 2. Signatures

```ts
interface ApiOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ApiError extends Error {
  status?: number;
  code?: string;
  kind?: 'http' | 'network' | 'timeout';
}
```

### 3. Contracts

- `api()` 在发送请求时冻结本次实际使用的 `requestToken`。
- 调用方取消保留 `AbortError`；内部超时返回 `kind='timeout'`、`code='request_timeout'`。
- 网络失败返回 `kind='network'`；HTTP 失败返回 `kind='http'` 和 `status`。
- 401 到达时若全局 token 已变化，直接用最新 token 重放一次，不 refresh、不清 session。
- refresh 按请求 token 去重；refresh 结果只有在全局 token 仍等于旧 token 时才能写入。
- 只有全局 token 仍等于 `requestToken` 时才允许清 token 并派发 `UNAUTHORIZED_EVENT`。

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| 调用方 `signal` 取消 | 抛 `AbortError`，业务 hook 静默忽略 |
| 内部 timeout | `ApiError(kind='timeout', code='request_timeout')` |
| fetch/network 失败 | `ApiError(kind='network', code='network_error')` |
| 旧 token 的 401，新 token 已存在 | 用新 token 重放，不清会话 |
| 当前 token 的 401，refresh 成功 | 用 refresh token 重放一次 |
| 当前 token 的 401，refresh 失败 | 清 token，派发一次 unauthorized |

### 5. Good/Base/Bad Cases

- Good: 用户快速切换筛选时旧请求被 abort，旧响应不能覆盖当前列表。
- Base: 普通 401 只 refresh 一次，失败后回登录页。
- Bad: 根据 401 返回时的全局 token 直接 refresh/clear，会让旧请求清除刚登录的新会话。

### 6. Tests Required

- 外部取消、timeout、network、HTTP 四种错误分类。
- 旧 401 到达前已设置新 token：0 次 refresh、0 次 unauthorized，并使用新 token 重放。
- 同一 token 两个并发 401：只发一次 refresh。
- refresh 返回前重新登录：旧 refresh 结果不能覆盖新 token。
- refresh 失败：并发请求只造成一次有效 session 清理事件。

### 7. Wrong vs Correct

```ts
// Wrong: 401 到达时不校验请求所属会话。
if (response.status === 401) setToken(null);

// Correct: 只允许当前会话的失败清理当前 token。
if (response.status === 401 && getToken() === requestToken) {
  setToken(null);
}
```
