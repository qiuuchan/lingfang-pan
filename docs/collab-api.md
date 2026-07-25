# Collab API

`apps/collab-api` 是桌面端、管理端和 Web 市场共享的统一服务。开发环境 Swagger 位于：

- UI：`http://localhost:<PORT>/api/docs`
- JSON：`http://localhost:<PORT>/api/docs-json`

## 快速调用

```powershell
$base = 'http://localhost:19006'
$login = Invoke-RestMethod -Method Post -Uri "$base/api/auth/login" -ContentType 'application/json' -Body '{"email":"admin@example.com","password":"ChangeMe123!"}'
$headers = @{ Authorization = "Bearer $($login.token)" }
Invoke-RestMethod -Headers $headers -Uri "$base/api/auth/me"
```

## 约定

- 全局前缀：`/api`。
- 认证：Bearer JWT；Web 市场会话使用 Cookie + CSRF。
- 错误：`{ code, message, requestId, details? }`。
- 上传 v4 制品：`application/octet-stream`，不是 multipart。
- 时间：ISO 8601；分页参数以 DTO 为准。

逐控制器端点清单见 [HTTP API 参考](./api-reference/README.md)。
