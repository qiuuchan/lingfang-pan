# 插件制品下载错误处理增强

## 背景

用户下载插件时遇到：

```
下载插件制品失败（HTTP 500 Internal Server Error）：
{"code":"internal_error","message":"服务内部错误","requestId":"831947aa-..."}
```

### 根因（已定位）

下载链路：

```
桌面 client → GET /api/plugin-releases/:id/artifact
            → PluginRegistryController.artifact                       plugin-registry.controller.ts:67
            → registry.artifactDownload(userId, releaseId)            plugin-registry.service.ts:466
            → this.artifacts.download(release.artifactKey)            artifact-store.ts:60
            → FilesystemArtifactStore.download → stat(path)           artifact-store.ts:62
```

全局异常过滤器 `AppExceptionFilter`（`common.ts:108`）只对**非 `AppError`** 的原生 Error 返回 `{"code":"internal_error","message":"服务内部错误"}`。

`assertCurrentAiPolicy` 抛的是 `AppError(409)`（会被正确映射），已排除。所以 500 只可能来自下面两处裸抛的原生 Error：

1. **制品文件在磁盘上缺失** —— `FilesystemArtifactStore.download` 里 `await stat(path)` 抛 `ENOENT`。
2. **`release.artifactKey` 为空/异常** —— `assertArtifactKey` 抛 `Error('Invalid artifact key')`。

两处都没有被 service 捕获并翻译，冒泡成 500。

客户端侧 `download_plugin_release`（`network.rs:181-184`）对非 2xx 一律把整个响应 body 拼进错误字符串，所以用户看到的是「HTTP 500 + 原始 JSON」，毫无可读性、也无法区分根因。

## Goal

让插件制品下载在各失败路径下输出**可区分、可排查、可读**的错误：

- 服务端按根因映射语义化状态码（制品缺失→410，已有语义错误保持不变），不再统一 500；
- 服务端对下载失败记录结构化日志（含 requestId、releaseId、packageId、artifactKey、错误类型），运维能凭 requestId 直接定位；
- 客户端按状态码/错误 code 给出可读中文提示，并单独标出 requestId 便于报修，而不是「HTTP 500 + 原始 JSON」。

## Requirements

### 服务端（collab-api）

- R1 `FilesystemArtifactStore.download`：文件不存在（ENOENT）时抛出**可映射到 410 的语义错误**（不裸抛 ENOENT）；其他原生 IO 错误（EACCES 等）也包装为可控错误。
- R2 `S3ArtifactStore.download`：presigned URL 构造失败等也包装为可控错误，不裸抛。
- R3 `artifactDownload` / `adminArtifactDownload` 捕获存储层"制品不可用"错误 → `AppError(410, 'plugin_artifact_unavailable', '制品文件不可用，可能已被清理，请联系作者重新发布')`；其余 AppError（403/404/409）原样透传；真未知错误记录日志后透传 500。
- R4 下载失败时输出结构化日志：`requestId`、`releaseId`、`packageId`、`artifactKey`、`error.name`、`error.message`、`stack` 摘要。日志可含 artifactKey 全量（仅服务端日志，不进响应体）。
- R5 响应体不泄漏内部路径/堆栈；只返回 `code` + 可读 `message` + `requestId`（沿用现有 AppError 响应结构）。
- R6 不改变成功下载路径的行为（流式 pipe、SHA-256 header、content-disposition 不变）。

### 客户端（desktop，Rust）

- R7 `download_plugin_release` 的非 2xx 分支：解析 body JSON，按 `code` / HTTP 状态码映射成可读中文提示（制品缺失→「制品文件已被清理，请联系作者重新发布」；权限→「没有该插件的使用授权」；政策→「该插件未通过当前 AI 使用政策检查」；其余 5xx→「服务暂时不可用，请稍后重试」）；body 非法时回退到原文本。
- R8 错误提示里单独带出 `requestId`（如「（编号 #xxx，报修时提供）」），便于用户反馈。

## Acceptance Criteria

- [ ] 制品文件被删除后下载，服务端返回 `410` + `{code:"plugin_artifact_unavailable", message, requestId}`；桌面端显示「制品文件已被清理，请联系作者重新发布（编号 #…）」类提示。
- [ ] 服务端日志含 requestId + releaseId + packageId + artifactKey + 错误类型，凭 requestId 可一跳定位。
- [ ] 已有语义错误（release 不存在→404、无权限→403、政策未过→409）行为不变。
- [ ] `artifact-store.spec.ts` / `plugin-registry.service.spec.ts` 现有用例全过；新增"制品缺失映射 410"与"客户端按 code 映射提示"的测试。
- [ ] 成功下载路径回归通过（制品正常落盘、SHA 校验、ZIP 解压不受影响）。

## Notes / 待确认

- **范围确认**：是否两端都改（服务端 R1–R6 + 客户端 R7–R8），还是先只做服务端？默认按两端都做规划。
- 状态码选择：制品"DB 存在但物理文件丢失"语义上属于 Gone，用 **410**；如团队偏好统一 404 可调整。
- 本任务不负责"为什么文件丢了"的根因排查（那属于运维/发布流程），只保证错误被正确表达和定位。
