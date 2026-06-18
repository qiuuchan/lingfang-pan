# collab-api 质量与契约规范

## Current Backend Boundary

`apps/collab-api` 是当前平台后端。新增后端能力时，不要往已删除的 `apps/server` 路径或旧 Rust server spec 增加实现规则。

## API Error Contract

所有受保护接口使用 Bearer token。错误响应由 `AppExceptionFilter` 统一输出：

```json
{
  "code": "forbidden",
  "message": "权限不足",
  "requestId": "req-id",
  "details": {}
}
```

业务错误使用 `AppError` 或 `badRequest` / `unauthorized` / `forbidden` / `notFound` / `conflict` / `insufficientBalance` helpers。不要直接把 Prisma 原始错误 message 返回给客户端。

## Database Contract

`resolveDatabaseConfig()` 的契约：

- `DATABASE_PROVIDER` 缺失或空串 -> `postgresql`
- `postgres` / `postgresql` -> `postgresql`
- `mysql` -> `mysql`
- 其他值 -> throw `DATABASE_PROVIDER must be postgresql or mysql`
- `DATABASE_URL` 缺失 -> throw `DATABASE_URL is required`
- provider 与 URL scheme 不匹配 -> throw 明确错误

不要为缺失数据库 URL 生成默认连接串；部署错误必须显式暴露。

## Scenario: Installed Marketplace Plugin Package Visibility

### 1. Scope / Trigger
- Trigger: changing `GET /api/plugins/available`, marketplace install, plugin package serialization, or desktop plugin loading.

### 2. Signatures
- `PluginService.availablePlugins(userId) -> { plugins }`
- `publicAvailablePlugin(plugin, currentTeamId) -> public plugin payload`
- `PluginInstallation(pluginId, teamId, status)` controls whether another team may receive package files.

### 3. Contracts
- Uploaded plugins are stored as JSON package data: `manifest + files[]`, not multipart uploads or zip archives.
- Own-team plugins return `files` and `manifest`.
- Public marketplace plugins from another team return no `files`/`manifest` until the current team has an ENABLED `PluginInstallation`.
- Installed marketplace plugins return `files`/`manifest` so desktop can run them; review internals such as `reviewReason` and `reviewedById` stay hidden.

### 4. Validation & Error Matrix
- Missing or disabled installation -> `files` and `manifest` are `undefined` in `available`.
- ENABLED installation for current team -> package fields are returned.
- Paid plugin without purchase -> install endpoint returns `payment_required`; `available` must not expose package files before installation.

### 5. Good/Base/Bad Cases
- Good: team B installs an approved public plugin from team A, then `/api/plugins/available` returns its `files` for team B.
- Base: team B sees the same public plugin in marketplace listings before install, but no package files through `available`.
- Bad: hiding `files` for already installed marketplace plugins; desktop will show a placeholder instead of running the plugin.

### 6. Tests Required
- `plugin-available.spec.ts`: uninstalled marketplace plugin hides package fields.
- `plugin-available.spec.ts`: installed marketplace plugin returns package fields but hides review internals.
- `plugin.service.spec.ts`: upload/edit paths still normalize package files and capabilities.

### 7. Wrong vs Correct
Wrong:

```ts
if (plugin.teamId !== currentTeamId) return { ...public_, files: undefined };
```

Correct:

```ts
return publicAvailablePlugin(plugin, currentTeamId);
```

## Test And Build Contract

- `tsconfig.json` 必须排除 `src/**/*.spec.ts`、`dist`、`node_modules`，避免 CommonJS build 产物污染 Vitest。
- `vitest.config.ts` 必须用 `include: ['src/**/*.spec.ts']` 锁定测试来源。
- 后端单元测试运行时加 60 秒硬超时。

## Wrong vs Correct

Wrong:

```ts
try {
  return await prisma.plugin.create(data);
} catch {
  return { ok: true };
}
```

Correct:

```ts
throw conflict('资源已存在或与现有记录冲突');
```

Wrong:

```ts
const url = process.env.DATABASE_URL || 'postgresql://localhost/dev';
```

Correct:

```ts
const config = resolveDatabaseConfig();
```
