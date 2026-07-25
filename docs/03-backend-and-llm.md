# 后端与模型 Relay

当前服务端是 `apps/collab-api`，使用 NestJS、Prisma 和 Express。`main.ts` 设置全局 `/api` 前缀、JWT/权限守卫、统一异常过滤、CORS、限流和开发环境 Swagger。

## 模块边界

- 身份与团队：auth、me、teams、roles、permissions。
- 插件平台：plugin registry、artifact、governance、grants、actions、shared state。
- 市场：discovery、commerce、quality、web marketplace。
- AI 与计费：relay、billing、credits、pricing、call logs。
- 工作流与自动化：workflow runs、desktop executor、cloud actions、automation schedules。
- 平台治理：admin、settings、audit、tickets、releases、notifications。

## Relay

Relay 接受平台模型档位，不接受用户自定义供应商密钥。主要端点：

- `POST /api/relay/v1/chat/completions`
- `POST /api/relay/v1/messages`
- `POST /api/relay/v1/images/generations`
- `POST /api/relay/v1/images/edits`
- `POST /api/relay/v1/videos/generations`
- `POST /api/relay/v1/videos/refund`

请求经过认证、团队渠道选择、定价查找、余额预留、上游调用、实际用量对账和 `LlmCallLog` 记录。视频使用 `PER_SECOND`；上游失败时按 call log 幂等退款。

## 错误契约

统一错误响应包含稳定 `code`、可读 `message`、`requestId` 和可选 `details`。客户端按 code 分支；服务端日志用 requestId 关联 release、package、artifact key 或上游错误。

完整路由见 [API 参考](./api-reference/README.md)。
