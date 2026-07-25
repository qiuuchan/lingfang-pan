# 执行计划：插件制品下载错误处理增强

## 前置

- 当前分支 `betav2`，任务目录 `.trellis/tasks/07-14-plugin-artifact-download-errors/`。
- 实现遵循「服务端先、客户端后；每步可单独编译/测试」。

## 实现步骤

### 1. common.ts — requestId 一致性 + 500 兜底日志
- [ ] 新增 `ensureRequestId(req: Request): string`（取 `x-request-id`，否则 `randomUUID()` 并回写 `req.headers['x-request-id']`）。
- [ ] `AppExceptionFilter.catch` 改用 `ensureRequestId(request)`（替换原 `request.header('x-request-id') || randomUUID()`）。
- [ ] `AppExceptionFilter` 500 兜底分支加 `logger.error`：import `Logger`、类字段 `new Logger('AppExceptionFilter')`、结构化日志 `{ requestId, method, url: request.path, errorMessage, errorStack }`（用 `request.path` 避免 query 泄漏）。
- 验证：`pnpm --filter @lingfang/collab-api build`（typecheck 过）。

### 2. artifact-store.ts — 制品不可用标记错误
- [ ] 新增 `export class ArtifactUnavailableError extends Error {}`。
- [ ] `FilesystemArtifactStore.download`：`stat(path)` 失败时，`error.code === 'ENOENT'` → `throw new ArtifactUnavailableError(...)`（message 含 key）；其他 IO 错误 → `throw new Error(\`读取制品失败：${key}\`, { cause: error })`。
- [ ] `assertArtifactKey` 越界**保持**抛普通 Error（数据异常，不映射 410）——确认现有 spec `rejects artifact keys that escape the root` 仍通过。
- [ ] `S3ArtifactStore.download`：用 try/catch 包 `presignedGet`，包装构造期错误（实际为纯计算，主要是防御性）。
- 验证：`pnpm --filter collab-api test artifact-store`。

### 3. plugin-registry.service.ts — 映射 + 日志
- [ ] import `Logger` from `@nestjs/common`，加 `private readonly logger = new Logger(PluginRegistryService.name)`。
- [ ] import `ArtifactUnavailableError`。
- [ ] `artifactDownload(userId, releaseId, requestId?: string)`：把 `await this.artifacts.download(...)` 包进 try/catch；catch 里 `if (error instanceof AppError) throw error;` → `this.logger.warn({ requestId, releaseId, packageId: release.packageId, artifactKey: release.artifactKey, err: error }, '插件制品下载失败：制品不可用')` → `throw new AppError(410, 'plugin_artifact_unavailable', '制品文件不可用，可能已被清理，请联系作者重新发布')`；其余 Error 打 `logger.error` 后 `throw error`。
- [ ] `adminArtifactDownload(actorId, releaseId, requestId?: string)` 同样处理（日志 event 语义保持 admin 语境）。
- 验证：`pnpm --filter collab-api test plugin-registry.service`。

### 4. plugin-registry.controller.ts — 注入 requestId
- [ ] 两个 `artifact` 方法调 `ensureRequestId(req)`（import 自 `../common`），传入 service。
- 验证：`pnpm --filter collab-api build`。

### 5. 桌面端 network.rs — 可读错误映射
- [ ] 新增 `fn render_download_error(status: reqwest::StatusCode, body: &str) -> String`：
  - `serde_json::from_str::<serde_json::Value>(body)`；解析成功取 `code`、`requestId`。
  - 按 code 映射中文提示（见 design 错误契约表）；未命中 code 但 4xx/5xx 给通用提示。
  - 有 `requestId` 则追加 `（编号 #{requestId}，报修时提供）`。
  - 解析失败回退 `format!("下载插件制品失败（HTTP {status}）：{body}")`。
- [ ] `download_plugin_release` 非 2xx 分支改 `return Err(render_download_error(status, &body));`。
- 验证：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml plugin_package_manager`；新增 `render_download_error_maps_known_codes` 单测（解析各 code → 期望文案片段；含/不含 requestId；非法 body 回退）。

### 6. 全量验证
- [ ] `pnpm --filter collab-api lint && pnpm --filter collab-api build && pnpm --filter collab-api test`。
- [ ] `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` + 相关 `cargo test`。
- [ ] 人工核对：模拟制品文件删除 → 下载返回 410 `{code:"plugin_artifact_unavailable",...}`；日志含 requestId+artifactKey；桌面端提示「制品文件已被清理…（编号 #…）」。

## Review Gates

- 步骤 2 后：store 单测全绿（含原 `escape root` 用例）。
- 步骤 3 后：service 单测全绿，新增 410 映射用例。
- 步骤 6：两端 lint/typecheck/test 全绿后再 commit。

## 回滚点

每步独立可 revert；无 schema 迁移。若步骤 1 的 `ensureRequestId` 回写引发问题，单独 revert 步骤 1 即恢复原 filter 行为。
