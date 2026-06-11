# 多租户后台与第三方 LLM 网关

> 当前实现 · 2026-06-11 · 上游 [愿景与架构](01-vision-and-architecture.md)、[领域模型](02-domain-and-plugins.md)
> 决策：服务端 [ADR-0003](adr/0003-multi-tenant-persistence.md)、LLM [ADR-0002](adr/0002-llm-third-party-gateway.md)

---

# A 部分 · 多租户后台（Rust + axum + SQLite）

## 1. 职责

- **插件生成服务**：prompt 工程、调用 LLM、校验生成物、保存草稿、发布插件。
- 身份、租户、成员、权限、插件发布/安装/授权、LLM 网关绑定、市场、钱包和审计。
- **不做**：插件业务逻辑、第三方 LLM token 计费、桌面壳本地能力。

## 2. API 面

```text
# 健康检查
GET /health

# 身份与租户
POST /auth/register
POST /auth/login
POST /auth/switch-tenant
POST /tenants
GET  /tenants/me
POST /members
GET  /members

# 插件草稿与生成
POST /drafts
GET  /drafts/:id
POST /drafts/:id/generate
POST /drafts/:id/generate/stream
POST /drafts/:id/publish
POST /plugins/:id/edit

# 插件目录 / 安装 / 授权
GET  /plugins
GET  /plugins/:id/files/*file
POST /installations
POST /grants
GET  /grants

# 市场与审核
GET  /marketplace/search
GET  /marketplace/plugins/:id
POST /marketplace/publish
POST /marketplace/rate
POST /marketplace/install
GET  /admin/review/pending
POST /admin/review/approve
POST /admin/review/reject

# 钱包
GET  /wallet
POST /wallet/purchase

# LLM 网关绑定与运行时代理
POST /llm-bindings
GET  /llm-bindings
POST /llm/models
POST /llm/test
POST /llm/proxy
GET  /audit
```

## 3. 前后端分离访问路径

桌面端只保存一个后端 URL：

```text
桌面端本机配置 → apiBase() → axum 后端 → SQLite / 第三方 LLM 网关
```

- 首次没有后端 URL 时，桌面端先显示后端地址配置入口，不发登录或业务请求。
- 设置页可修改后端 URL；切换到另一套后端后需要重新登录。
- 连接测试使用无鉴权 `GET /health`。
- 打包默认地址可放在 `apps/desktop/public/app.config.json`，但最终可由用户在应用内修复。

## 4. 鉴权与租户上下文

- 注册/登录后获取用户 token。
- 租户选择通过 `/auth/switch-tenant` 换发包含当前租户的 token。
- 租户内资源使用服务端 `TenantCtx`，以数据库中的 active membership 为权限来源。
- 前端/插件永不持有第三方 LLM key 明文。

## 5. 数据库与运行

当前实现使用内嵌 SQLite：

- 默认连接串：`sqlite:lingfang.db?mode=rwc`
- 首次启动自动创建数据库文件。
- 迁移文件位于 `apps/server/migrations/`，启动时自动应用。
- 无需 Docker 或 PostgreSQL。

关键环境变量：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | SQLite 连接串，可改为自定义路径 |
| `BIND_ADDR` | 服务端监听地址；跨机器访问时通常设为 `0.0.0.0:8787` |
| `CORS_ALLOWED_ORIGINS` | 逗号分隔的前端来源白名单；留空时使用开发期 permissive CORS |
| `JWT_SECRET` | JWT 签名密钥，生产必须使用强随机值 |
| `KEY_ENCRYPTION_SECRET` | 租户 LLM key 加密密钥，生产必须使用强随机值 |
| `PLATFORM_ADMIN_EMAIL` | 可选平台审核员邮箱 |

## 6. 跨域策略

服务端启动时根据 `CORS_ALLOWED_ORIGINS` 决定跨域行为：

- 留空：开发期 permissive CORS，方便本地 Tauri/Vite 调试。
- 非空：按逗号分隔 origin 白名单放行。
- 白名单模式允许 `GET`、`POST`、`OPTIONS`，以及 `Authorization`、`Content-Type`。

示例：

```env
BIND_ADDR=0.0.0.0:8787
CORS_ALLOWED_ORIGINS=http://localhost:1420,https://desktop.example.com
```

## 7. 第三方 LLM 网关对接

平台不做 token 计量、扣费或分成。租户在第三方 OpenAI 兼容网关中创建 key、设配额；平台只存绑定、路由请求并审计。

绑定流程：

```text
设置页填入 API Key → 后端加密落库 → 生成插件与插件运行时调用统一经后端代理 → 写审计
```

关键要求：

- `GET /llm-bindings` 只返回脱敏 key。
- 租户未配置绑定时返回 `llm_binding_missing`。
- 上游 LLM 错误以显式错误返回，不伪造生成结果。
- 生成结果不合法时返回 `generation_invalid` 并保留诊断。