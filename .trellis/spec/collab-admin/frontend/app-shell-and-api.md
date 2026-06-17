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
