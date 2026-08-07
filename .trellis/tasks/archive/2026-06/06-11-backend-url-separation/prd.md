# 完善前后端分离与后端地址配置

## Goal

让桌面端与服务端形成明确分离部署关系：桌面端只需要知道后端服务地址；首次没有后端地址时先引导用户配置；设置页可修改后端地址；服务端支持可配置跨域；应用文档准确描述部署、启动和分发方式。

## User Value

- 终端用户更换后端时，不需要重新构建前端应用。
- 分发者可预置默认后端地址，也可以让用户在应用内修复连接问题。
- 服务端部署到本机、局域网或公网时，跨域策略可按环境调整。
- README 与工程文档不再描述过期的 PostgreSQL / 固定本机后端流程。

## Confirmed Facts

- 前端入口 `apps/desktop/src/main.tsx` 当前读取 `app.config.json` 后调用 `setApiBase()`。
- API 封装在 `apps/desktop/src/lib/api.ts`，SSE 在 `apps/desktop/src/lib/stream.ts`，二者都依赖同一个 `apiBase()`。
- 设置页 `apps/desktop/src/pages/Settings.tsx` 当前只有 LLM 网关和成员管理，没有后端地址配置。
- 后端路由 `apps/server/src/routes/mod.rs` 已存在无鉴权 `/health`。
- 后端入口 `apps/server/src/main.rs` 当前使用 `CorsLayer::permissive()`。
- Tauri CSP 当前 `connect-src` 只允许本机后端和本地开发地址。
- README、`docs/03-backend-and-llm.md`、`docs/04-engineering.md`、`tools/README.md` 存在与当前实现不一致的旧描述。

## Requirements

1. 后端地址配置
   - 后端地址为全局本机偏好，不按租户隔离。
   - 用户保存值优先于打包默认配置。
   - URL 保存前必须标准化：去空格、去尾部 `/`，仅接受 `http://` 或 `https://`。
   - 不再把 `http://127.0.0.1:8787` 作为绕过配置入口的硬默认。

2. 首次启动体验
   - 如果没有有效后端 URL，应用必须先显示配置入口，不进入登录页。
   - 配置入口必须能保存后端 URL 并测试 `/health`。
   - 在 URL 配置完成前，不应触发登录、租户、业务或 SSE 请求。

3. 设置页
   - 设置页新增“后端服务地址”区域。
   - 可展示、修改、保存和测试当前后端地址。
   - 保存后立即影响后续 `api()` 和 SSE 请求。
   - 修改后端地址时，应提示当前登录态可能属于旧后端，必要时需要重新登录。

4. 后端跨域
   - 保留开发环境便利：未配置白名单时仍可放行。
   - 支持 `CORS_ALLOWED_ORIGINS` 作为逗号分隔白名单。
   - 白名单模式下允许实际需要的方法和请求头：`GET`、`POST`、`OPTIONS`、`Authorization`、`Content-Type`。
   - `.env.example` 需要记录该变量。

5. Tauri 与本地资源
   - CSP 允许用户填写的 HTTP/HTTPS 后端地址发起请求。
   - 继续打包内置插件与 `public` 下本地 JSON 资源。
   - 后端地址最终以应用内保存配置为修复入口，不依赖重新构建。

6. 文档
   - README 更新快速开始、配置表、前后端分离部署、分发说明和本地验证。
   - `docs/03-backend-and-llm.md` 更新后端事实、健康检查、跨域与当前 API 流程。
   - `docs/04-engineering.md` 更新 SQLite、一键启动、配置隔离、资源打包与验证说明。
   - `tools/README.md` 更新现有工具脚本用途。

## Acceptance Criteria

- [ ] Trellis 任务存在并包含 `prd.md`、`design.md`、`implement.md`。
- [ ] 全新本机状态下，无后端 URL 时不会进入登录页，也不会发业务 API 请求。
- [ ] 用户输入合法后端 URL 后，可测试 `/health` 并进入应用。
- [ ] 登录、租户选择、普通 API 和 SSE 生成统一走用户保存的后端地址。
- [ ] 设置页可以修改后端 URL，保存后后续请求立即使用新地址。
- [ ] 无效 URL、服务不可达、CORS 不通时，界面给出明确中文提示。
- [ ] 后端支持 `CORS_ALLOWED_ORIGINS` 白名单；未配置时本地开发仍可用。
- [ ] Tauri 打包后的 WebView 可以访问用户填写的 HTTP/HTTPS 后端。
- [ ] README、`.env.example`、`docs/03-backend-and-llm.md`、`docs/04-engineering.md`、`tools/README.md` 与实际行为一致。
- [ ] `pnpm -C apps/desktop typecheck`、`pnpm -C apps/desktop vite:build`、`cargo test -p server` 通过，或记录明确阻塞。

## Out of Scope

- 不实现服务端 HTTPS/TLS 终止；生产 HTTPS 可由反向代理承担。
- 不引入新的全局状态管理库。
- 不改造 LLM 网关绑定模型。
- 不回退或改写当前工作区中已有的图标、锁文件、Trellis 模板等无关脏变更。
