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
