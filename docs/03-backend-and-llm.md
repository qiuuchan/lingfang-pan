# 多租户后台与第三方 LLM 网关

> 蓝图 · 2026-06-09（v2：含插件生成服务）· 上游 [愿景与架构](01-vision-and-architecture.md)、[领域模型](02-domain-and-plugins.md)
> 决策：服务端 [ADR-0003](adr/0003-multi-tenant-persistence.md)、LLM [ADR-0002](adr/0002-llm-third-party-gateway.md)

---

# A 部分 · 多租户后台（Rust + axum + PostgreSQL）

## 1. 职责

- **插件生成服务**（产品核心）：prompt 工程 + 调 LLM 生成插件 + 校验 + 草稿管理。
- 身份/租户/成员/权限 · 插件发布/安装/授权 · LLM 网关绑定 · 调用审计。
- **不做**：业务逻辑（在插件）、token 计费（在第三方网关）。

## 2. API 面

```
# 身份与租户
POST /auth/register | /auth/login | /auth/switch-tenant
POST /tenants ; GET /tenants/me
POST /members | GET /members          # 当前租户（来自 JWT），下同各租户内资源

# ★插件生成（产品核心）
POST /drafts                  新建草稿（用户首次描述）
POST /drafts/:id/generate     按描述生成/迭代插件（调 LLM，当前非流式 JSON）
GET  /drafts/:id              取草稿（文件 + 对话 + 诊断）
POST /drafts/:id/publish      校验通过后发布为 Plugin

# 插件发布物 / 安装 / 授权
GET /plugins ; POST /installations ; POST/GET /grants

# LLM 网关绑定（GET 绝不返回明文 key）
POST/GET /llm-bindings
POST /llm/proxy               插件运行时的 LLM 调用入口（当前非流式）

# 审计
GET /audit                    含 generate / runtime 两类调用
```

## 3. 鉴权与租户上下文

JWT `{user_id, tenant_id, role}` → axum 中间件注入 `RequestContext` → 所有 repo 查询强制带 `tenant_id`。切换租户走 `/auth/switch-tenant` 换发 token。

## 4. 租户隔离（硬实现）

`TenantScopedRepo` 自动注入 `tenant_id`，禁裸 SQL 绕过；路径 `:id` 必须等于 JWT 的 `tenant_id` 否则 403；`api_key` 仅服务端可解密。

## 5. 数据库与运行

表对应 [领域模型](02-domain-and-plugins.md)（含 `plugin_drafts`）；迁移纳入版本控制。**无 demo 默认**：未配 `DATABASE_URL` 直接退出（`apps/server/src/main.rs` 已落实）。本地：`pnpm db:up` → 迁移 → `cargo run -p server`。

---

# B 部分 · 第三方 LLM 网关对接

## 6. 核心原则

> 平台**不做** token 计量/扣费/分成。租户在第三方网关（newapi 等）创建 key、设配额；平台只**存绑定、路由、审计**。**生成插件**和**插件运行时**两类 LLM 调用都经它。

## 7. 绑定管理

```ts
// POST /tenants/:id/llm-bindings
{ name:"团队 newapi", protocol:"openai-compatible",
  base_url:"https://newapi.example.com/v1", api_key:"sk-xxx",  // 服务端立即加密落库
  models:["gpt-4o-mini","claude-3-5-sonnet","deepseek-chat"] }
```

key 加密存储，GET 脱敏为 `sk-****`，前端/插件永不见明文。

## 8. 两类转发流程

**① 生成插件 `/drafts/:id/generate`（核心）**
```
用户描述 → 后台构造 prompt（插件契约 + 描述 + 草稿快照，要求 structured output）
 → 取租户绑定、解密 key → OpenAI 兼容转发到第三方网关
 → 拿到插件代码 → schema + 安全校验 → 不过则错误回喂重生成
 → 存 PluginDraft → SSE 进度回壳 → 写 InvocationAudit(kind=generate)
```

**② 插件运行时 `/llm/proxy`**
```
插件 sdk.llm.chat → 壳网关(校验 manifest+授权) → /llm/proxy → 第三方网关
 → SSE 透传 → 写 InvocationAudit(kind=runtime)
```

## 9. 协议与降级

- 首发只支持 `openai-compatible`，一举对接 newapi/one-api/LiteLLM/各中转站。
- 限流/配额交第三方网关，429/额度不足时**透传**错误。
- 租户未配绑定 → 返回 `llm_binding_missing`，提示去配置——**显式失败，不伪造结果**。
- 生成结果不合法（非合法插件代码）→ 返回 `generation_invalid` 并记诊断，不产出假插件。
