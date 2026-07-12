# collab-admin Shell 与 API 规范

## App Shell

`src/App.tsx` 当前没有 React Router。页面由 `View` 联合类型和 `setView` 控制。新增后台 view 时同步：

- `src/lib/types.ts` 的 `View`
- `src/lib/navigation.ts` 的 `NAV_GROUPS`、`VIEW_LABEL`、`VIEW_GROUP`
- `src/App.tsx` 的 lazy import 和 render 分支

未登录态 landing/login/download/changelog 是独立状态机，不应和后台 `View` 混在一起。

## API Boundary

`src/lib/api.ts` 是唯一通用请求入口：

- `apiBase()` 读取 `VITE_API_BASE_URL` 或 `VITE_COLLAB_API_BASE`，默认 `http://localhost:19006`。
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
