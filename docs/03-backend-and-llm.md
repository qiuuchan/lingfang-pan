# 多租户后台与第三方 LLM 网关

> 当前实现 · 2026-06-11 · 上游 [愿景与架构](01-vision-and-architecture.md)、[领域模型](02-domain-and-plugins.md)
> 决策：服务端 [ADR-0003](adr/0003-multi-tenant-persistence.md)、LLM [ADR-0002](adr/0002-llm-third-party-gateway.md)

---

# A 部分 · 多租户后台（Rust + axum + SQLite）

## 1. 职责

- ~~**插件生成服务**：prompt 工程、调用 LLM、校验生成物、保存草稿、发布插件。~~（生成能力已下线，改由 desktop 本地 code_assistant 完成；插件草稿 CRUD 仍在本服务。）
- 身份、租户、成员、权限、插件草稿 CRUD 与目录安装/授权的旧契约骨架。
- ~~LLM 网关绑定、市场、钱包和审计~~ → 已迁移至 collab-api（NestJS，`/api/*` 前缀），见 docs/collab-api.md。
- **不做**：插件业务逻辑、第三方 LLM token 计费、桌面壳本地能力。

## 2. API 面

> ⚠️ **本节为历史/迁移脉络**。LLM 生成、钱包、市场、审核、`/llm/*`、`/marketplace/*`、`/wallet`、`/admin/review/*` 已在 commit `7ef4bf0` 全部迁移到 **collab-api（NestJS，`/api/*` 前缀）**。
> 下面先给出本 Rust 服务**当前仍在**的完整路由（与 `apps/server/src/routes/mod.rs` 一致），再列出已迁移路由的归宿。

### 2.1 当前 Rust 服务仍在的路由（权威，见 `routes/mod.rs`）

```text
# 健康检查
GET /health

# 身份与租户
POST /auth/register
POST /auth/login
POST /auth/switch-tenant
POST /tenants
GET  /tenants/me
POST /members        # 邀请成员
GET  /members        # 成员列表

# 插件草稿 CRUD（生成能力已下线，改由 desktop 本地 code_assistant 完成）
POST /drafts
GET  /drafts/:id
POST /drafts/:id/publish
POST /plugins/:id/edit      # 由已发布插件回退为草稿

# 插件目录 / 安装 / 授权
GET  /plugins
GET  /plugins/:id/files/*file
POST /installations
POST /grants
GET  /grants
```

说明：生成相关的 `POST /drafts/:id/generate`、`/drafts/:id/generate/stream` 已从 Rust 路由中移除；插件生成改由桌面端本地 code_assistant 直接对接第三方 LLM 完成。

### 2.2 已迁移至 collab-api 的路由（仅作历史脉络保留）

下列路由**已不在本 Rust 服务中**，相关契约以 [collab-api.md](collab-api.md) 为权威，下表给出迁移映射：

| 旧 Rust 路由 | 现归属（collab-api） |
|---|---|
| `POST /drafts/:id/generate`、`/drafts/:id/generate/stream` | 不再由后端生成；改由 desktop 本地 code_assistant 调第三方 LLM |
| `POST /llm-bindings`、`GET /llm-bindings` | 已迁移至 collab-api，见 docs/collab-api.md |
| `POST /llm/models`、`POST /llm/test`、`POST /llm/proxy` | 已迁移至 collab-api，见 docs/collab-api.md（原 `/llm/proxy` 由 collab-api 的运行时代理承担） |
| `GET /audit` | 已迁移至 collab-api（`GET /api/admin/audit-logs`） |
| `GET /marketplace/search`、`/marketplace/plugins/:id`、`POST /marketplace/publish`、`/marketplace/rate`、`/marketplace/install` | 已迁移至 collab-api 的插件/市场接口，见 docs/collab-api.md |
| `GET /admin/review/pending`、`POST /admin/review/approve`、`/admin/review/reject` | 已迁移至 collab-api（`GET /api/admin/plugins/review-pending`、`POST /api/plugins/:id/approve`、`/reject` 等） |
| `GET /wallet`、`POST /wallet/purchase` | 已迁移至 collab-api（`GET /api/wallet`、`POST /api/wallet/purchase`，且市场购买改由团队共享余额 `POST /api/teams/current/consume` 结算） |

> 收敛背景见 [docs/collab-platform.md](collab-platform.md) 与 [docs/collab-api.md](collab-api.md)。

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

> ⚠️ **收敛说明**：上述 `/auth/switch-tenant` 多团队切换属于本 Rust 服务的旧骨架遗留。桌面端正在收敛到 collab-api，**TenantSelect 多团队切换功能已移除**——collab-api 采用「单当前团队 + 邀请码」模型（见 `POST /api/invitations/redeem` 与 `POST /api/team-admin-applications`）。当前实际鉴权/租户契约以 [docs/collab-api.md](collab-api.md) 为权威，且两后端 JWT claims/secret 当前不互通（收敛背景见 [docs/collab-platform.md](collab-platform.md)）。

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

## 7. 第三方 LLM 网关对接（已迁移至 collab-api）

> ⚠️ 本节描述的 `/llm-bindings`、`/llm/*` 路由与 LLM key 绑定/代理逻辑已**全部迁移至 collab-api（NestJS，`/api/*` 前缀）**，本 Rust 服务不再承载。以下为历史脉络保留；当前实际契约以 [docs/collab-api.md](collab-api.md) 为权威。

> 🔁 **架构翻转（2026-06-22，v0.0.6 彻底完成）**：原 BYOK（用户自带 key、桌面直连上游、平台不计费）
> 已被 **平台托管渠道 + 统一中转 + 灵石按量计费**完全取代，旧 BYOK 代码与表已**全部删除**：
>  - `/api/relay/v1/*` 中转层（fetch 直连上游，OpenAI/Anthropic 双协议，SSE 流式透传），见
>    [docs/billing-and-relay-design.md](billing-and-relay-design.md)。
>  - 灵石（Credit）按团队账户计费，单价/版本/渠道全后台可配；调用日志多维度可查。
>  - 前台仅「快速版/高级版」两固定版本（协议层强制 `model: fast|premium`）。
>  - **已删除**：`LlmGateway` / `TenantLlmBinding` 表、`LlmService` / `LlmController`、
>    `/api/llm/*` 与 `/api/admin/llm-providers` 路由、`seed-llm-gateways`、桌面 `ModelGatewayTab`、
>    管理端 `providers-view`。下方历史脉络仅作存档。

平台不做 token 计量、扣费或分成。租户在第三方 OpenAI 兼容网关中创建 key、设配额；平台只存绑定、路由请求并审计。

历史绑定流程：

```text
设置页填入 API Key → 后端加密落库 → 生成插件与插件运行时调用统一经后端代理 → 写审计
```

历史关键要求（现均由 collab-api 承担）：

- `GET /llm-bindings` 只返回脱敏 key。
- 租户未配置绑定时返回 `llm_binding_missing`。
- 上游 LLM 错误以显式错误返回，不伪造生成结果。
- 生成结果不合法时返回 `generation_invalid` 并保留诊断。