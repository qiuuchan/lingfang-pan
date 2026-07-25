# 示例与排错

可参考：

- `apps/desktop/builtin-plugins/ai-example`：client + AI 能力。
- `apps/desktop/builtin-plugins/ai-python-example`：Python + 桥调用。
- `apps/desktop/builtin-plugins/calculator`：Python 本地插件。
- `apps/desktop/builtin-plugins/game-2048`：Node.js 插件。
- `apps/desktop/builtin-plugins/notes`：client + 本地存储。
- `plugins/summarizer`：SDK LLM 示例。

常见错误：

| 错误 | 处理 |
|---|---|
| `manifest_validation_failed` | 按错误 path 修复 schema 或业务规则 |
| `entry_not_found` | 修正 `manifest.entry` 或补入口文件 |
| `plugin_artifact_unavailable` | 制品已被清理，请作者重新发布，并用 requestId 定位日志 |
| HTTP 401 | 重新登录获取 JWT |
| HTTP 403 | 检查团队上传/编辑权限 |
| HTTP 409 | 提升版本号或确认包未归档 |
| HTTP 413 | 移除运行缓存和大依赖，降低制品体积 |
