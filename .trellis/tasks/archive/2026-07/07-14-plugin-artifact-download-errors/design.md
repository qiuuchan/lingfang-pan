# 设计：插件制品下载错误处理增强

## 边界与范围

**改动的文件**

服务端 `apps/collab-api/src`：

- `common.ts` — 新增 `ensureRequestId(req)` helper；`AppExceptionFilter` 改用它，保证响应体里的 `requestId` 与 service 日志一致；并在 500 兜底分支加 `logger.error`（含 requestId/method/path/error），让所有未处理异常落日志、可凭 requestId 定位（用 `request.path` 避免 query 泄漏）。
- `modules/artifact-store.ts` — 新增 `ArtifactUnavailableError`；`FilesystemArtifactStore.download` 在 `ENOENT` 时抛该错误，其他 IO 错误（EACCES 等）包装为带上下文的普通 Error；`S3ArtifactStore.download` 包装构造期错误。
- `modules/plugin-registry.service.ts` — 注入 NestJS `Logger`；`artifactDownload` / `adminArtifactDownload` 增加 `requestId` 形参，用 try/catch 包住 `artifacts.download`，对 `ArtifactUnavailableError` 映射 `AppError(410, 'plugin_artifact_unavailable', ...)`，其余原生 Error 先打结构化 error 日志再透传。
- `modules/plugin-registry.controller.ts` — 两个 `artifact` 端点用 `ensureRequestId(req)` 取 id 传入 service。

客户端 `apps/desktop/src-tauri/src/plugin_package_manager/network.rs`：

- 新增 `render_download_error(status, body) -> String`：尝试把 body 解析为 `{code, message, requestId}` JSON，按 `code`/状态码映射中文提示并附 `requestId`；解析失败回退原文。
- `download_plugin_release` 非 2xx 分支改调该 helper。

**不改的东西**

- 成功下载路径（流式 pipe、`x-plugin-sha256`、`content-disposition`、SHA-256 校验、ZIP 解压）。
- assertArtifactKey 对越界 key 仍抛错（属数据完整性，500 + 日志，不映射 410）。
- 其他 API 的错误处理（upload/update 暂不在本任务范围，`render_download_error` 后续可复用）。

## 错误契约（下载端点）

| 场景                         | HTTP    | code                              | 客户端提示                                   |
| ---------------------------- | ------- | --------------------------------- | -------------------------------------------- |
| release 不存在/已撤回        | 404     | `not_found`                       | 插件发行版不存在或已撤回                     |
| 无团队/市场授权              | 403     | `forbidden`                       | 没有该插件的使用授权                         |
| 未购且非免费                 | 402     | `payment_required`                | 当前团队尚未购买该插件                       |
| AI 政策未过                  | 409     | `plugin_ai_policy_required`       | 该插件未通过当前 AI 使用政策检查             |
| **制品文件缺失/不可读**      | **410** | **`plugin_artifact_unavailable`** | 制品文件已被清理或不可用，请联系作者重新发布 |
| artifactKey 非法（数据异常） | 500     | `internal_error`                  | 服务暂时不可用，请稍后重试                   |
| 其他未知错误                 | 500     | `internal_error`                  | 服务暂时不可用，请稍后重试                   |

404/403/402/409 沿用现有 AppError，本任务只新增 410 这一行。

## 数据流（失败链路）

```
controller.artifact(req, id)
  requestId = ensureRequestId(req)          // 取 x-request-id 或生成并回写 req.headers
  registry.artifactDownload(userId, id, requestId)
    release = prisma.findUnique(...)         // release 不存在 → notFound(404) [透传]
    assertCurrentAiPolicy(release)           // 政策未过 → AppError(409) [透传]
    resolvePackageAccess(...)                // 无权 → forbidden(403)/402 [透传]
    try artifacts.download(release.artifactKey)
      FilesystemArtifactStore.download
        stat(path) → ENOENT  ⇒ throw ArtifactUnavailableError
        stat(path) → 其他    ⇒ throw Error(包装)
    catch (err):
      err instanceof AppError ⇒ throw err   // 上面那些语义错误不拦截
      logger.error({requestId, releaseId, packageId, artifactKey, err})  // 结构化
      err instanceof ArtifactUnavailableError ⇒ throw AppError(410, 'plugin_artifact_unavailable', ...)
      throw err                              // 其余 → filter 兜底 500
  ↓ filter（已是 AppError，按 code/status 响应，带同一 requestId）

桌面 client 收到 410/5xx body
  render_download_error(status, body)
    serde_json::from_str → 取 code/requestId
    code == plugin_artifact_unavailable ⇒ "制品文件已被清理…"
    …按表映射…
    追加 "（编号 #{requestId}，报修时提供）"
```

## 关键设计决策

### 1. requestId 全链路一致：`ensureRequestId(req)`

现状：`AppExceptionFilter` 用 `request.header('x-request-id') || randomUUID()`，但**不回写** req。若客户端没传 header，filter 生成的新 UUID 与 service 自己生成的会是两个值——运维拿客户端报回的 requestId 在日志里搜不到。

方案：在 `common.ts` 加

```ts
export function ensureRequestId(req: Request): string {
  const existing = req.header('x-request-id');
  if (existing) return existing;
  const generated = randomUUID();
  req.headers['x-request-id'] = generated; // 回写，让 filter 复用同一个值
  return generated;
}
```

filter 改为 `const requestId = ensureRequestId(request)`；controller 也调它传入 service。这样响应体、service 日志、pino HTTP 日志（pino 读 `req.id`/header）三处同值。

### 2. 错误分层：store 抛标记错误，service 做映射

- store 层只负责"告诉调用方发生了什么"：文件没了 → `ArtifactUnavailableError`；其他 IO → 普通 Error（带 `cause`）。
- service 层负责"翻译成 HTTP 语义"：`ArtifactUnavailableError` → 410；其他 → 日志后透传 500。
- 不在 store 层抛 AppError——store 是纯基础设施，不该依赖 HTTP 语义（也便于单测）。

### 3. 状态码用 410 Gone

release 在 DB 存在但物理制品丢失 = "曾经可下载、现已不可得"，410 比 404 更准。且把 404 留给"release 记录本身不存在"，语义不混淆。

### 4. 日志策略

- `ArtifactUnavailableError` → `logger.warn`（业务可恢复，需关注但非崩溃）：含 requestId/releaseId/packageId/artifactKey。
- 其他未知 Error → `logger.error`：同上下文 + `err` 完整对象（pino 会序列化 stack）。
- 不在响应体回显 artifactKey/堆栈（沿用 AppError 既有结构，安全）。

## 兼容性

- 新增 code `plugin_artifact_unavailable`（410）。collab-admin 前端按 `code` 分支展示，未识别 code 走默认 message，不受影响。
- 桌面端**旧版本**收到 410 时仍走"HTTP 410：{json}"拼接——比 500 友好（至少 code 可读），完整映射需新版本。可接受。
- `AppExceptionFilter` 行为对其他路由不变（`ensureRequestId` 是等价重构 + 回写）。

## 回滚

改动集中于错误处理路径，不动数据模型/成功路径。回滚 = revert 该任务 commits。无 schema 迁移、无不可逆副作用。
