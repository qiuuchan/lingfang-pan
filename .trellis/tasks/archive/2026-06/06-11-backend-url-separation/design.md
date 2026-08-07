# Design: 完善前后端分离与后端地址配置

## Architecture Boundaries

```mermaid
flowchart TD
  Config[本机后端地址配置] --> ApiBase[api.ts 模块状态]
  Config --> Setup[首次启动配置入口]
  Config --> Settings[设置页后端服务地址]
  ApiBase --> Api[api(path)]
  ApiBase --> Stream[SSE streamGenerate]
  Api --> Server[axum 后端]
  Stream --> Server
  Server --> Cors[CORS 层]
  Server --> Health[/health]
```

## Configuration Contract

后端 URL 的来源优先级：

1. 用户本机保存值：`localStorage` key `lf:backendUrl`。
2. 打包默认配置：`app.config.json` 中的 `api_base`。
3. 空配置：进入首次启动配置入口。

标准化规则：

- trim 空白。
- 去尾部 `/`。
- 只接受 `http://` 和 `https://`。
- 空字符串代表未配置，不应回退到隐藏默认后端。

## Frontend Flow

### 首次启动

- `main.tsx` 加载打包默认配置并初始化后端配置状态。
- `App.tsx` 持有当前 backend URL 状态。
- 若无有效 URL，显示配置入口。
- 配置入口保存成功后调用统一设置入口并进入正常 App。

### Settings 页面

- Settings 新增后端服务地址卡片。
- 保存后更新本机存储与 `apiBase()`。
- 测试连接使用当前输入 URL 访问 `/health`。
- 保存不同后端地址后调用现有 `resetSession()`，避免旧后端 token 被误用于新后端。

### API / SSE

- `api()` 继续统一处理 JSON、Bearer token 和错误映射。
- `streamGenerate()` 继续通过 `apiBase()` 拼接 SSE 地址。
- 连接失败文案从“确认 pnpm start”调整为面向分离部署的通用提示。

## Backend Flow

### Health

`/health` 已存在，返回 `{ "status": "ok" }`，作为无鉴权连接测试入口。

### CORS

`Config` 新增 `cors_allowed_origins: Vec<String>`。

- 未配置：保留 `CorsLayer::permissive()`，方便本地开发。
- 已配置：按逗号分隔 origin 生成白名单，允许 `GET`、`POST`、`OPTIONS`，允许 `Authorization`、`Content-Type`。
- 无效 origin 忽略或在启动时报错；优先选择启动时报错，避免部署时“看似启动但跨域不可用”。

## Tauri And Resources

- `connect-src` 需要允许 `http://*:*` 与 `https://*:*`，否则用户填写远端后端会被 WebView CSP 拦截。
- 保留本地开发地址 `http://localhost:1420`、`ws://localhost:1420`。
- `bundle.resources` 继续包含 `builtin-plugins`。
- `public` 下 JSON 会由 Vite 进入 `dist`，Tauri 会打包 `frontendDist`；文档需要说明后端变更优先通过应用内设置修复。

## Compatibility

- 已有用户如果 localStorage 里没有新 key，会读取 `app.config.json` 默认值；若默认值为空则进入配置入口。
- 已登录状态只存在内存中，修改后端地址时重置会话不会影响持久数据。
- 后端默认 CORS 行为保持开发兼容。

## Rollback Points

- 前端配置层集中在 `api.ts` / `backend-config.ts` / `App.tsx`，可局部回退。
- CORS 改造集中在 `config.rs` 与 `main.rs`。
- CSP 改造集中在 `tauri.conf.json`。
- 文档变更独立，不影响运行时。
