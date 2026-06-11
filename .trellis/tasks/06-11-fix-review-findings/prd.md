# 修复全量源码 review 发现的问题

## Goal

修复全量源码 review 中确认的安全、授权、运行时契约和错误传播缺陷，使插件发布/安装、租户鉴权、本地 capability、流式生成和 SDK 运行时行为可验证且显式失败。

## Confirmed Facts

- `apps/server/src/routes/drafts.rs` 发布插件时对相同 manifest `id` 执行无作者约束的 upsert，跨租户可覆盖已有插件内容。
- `apps/server/src/routes/catalog.rs` 的 `/installations` 可绕过市场审核/购买/作者可见性，直接写安装记录。
- `TenantCtx` 只信 JWT claim，不回查 active membership；默认密钥会降低伪造 token 的门槛。
- LLM key 当前使用 XOR + hex 编码，不满足密钥保护要求。
- Tauri `fs.read` 作用域校验使用字符串前缀匹配，缺少 canonicalize 与路径边界判断。
- 前端 iframe runtime 信任消息中的 `pluginId`，未绑定当前运行插件。
- 流式生成持久化失败会被吞掉并可能返回 `done`。
- SDK、宿主 shim、示例插件和 contract 错误码存在漂移。

## Requirements

- 发布插件时，跨租户 manifest `id` 冲突必须显式失败；同作者租户更新仍可保留重新发布能力。
- 数据库插件安装必须统一经过可见性、审核和付费校验；未授权安装不得写入 `plugin_installations`。
- 租户内 API 必须用数据库中的 active membership 和真实 role 建立 `TenantCtx`。
- 服务启动不得在弱 JWT/LLM key 加密密钥下继续运行。
- LLM API key 落库加密必须使用带认证的加密方案，解密失败显式报错。
- Tauri `fs.read` 必须只允许 canonicalized 子路径访问，`..`、同名前缀目录和越权路径必须失败。
- 插件 iframe 调 capability 时，宿主必须使用当前 Runner 的插件 ID，忽略插件脚本上报的 ID。
- 流式生成中，持久化或载回草稿失败必须作为 SSE `error` 暴露，不得发送成功 `done`。
- SDK runtime 契约必须统一为宿主注入 `globalThis.__lingfangInvoke(capability,args)`；示例插件不能依赖浏览器无法解析的 bare import。
- `packages/contract` 必须覆盖后端稳定错误码和授权默认规则，避免类型消费者误判。

## Acceptance Criteria

- [ ] `cargo test -p server` 覆盖并通过：跨租户发布冲突、未授权安装拒绝、已审核付费安装要求购买、TenantCtx 回查 membership、弱密钥拒绝、认证加密 roundtrip/篡改失败、流式持久化失败路径。
- [ ] `cargo test -p lingfang-desktop` 覆盖并通过：`fs.read` canonical scope 检查拒绝 `..` 和同名前缀目录，允许授权目录内文件。
- [ ] `pnpm -C apps/desktop typecheck` 通过，并且 runtime shim 使用当前插件 ID 和 `__lingfangInvoke` 契约。
- [ ] `pnpm -C packages/plugin-sdk typecheck` 通过，SDK 与宿主 shim 的 `llm.chat` 输入形态一致。
- [ ] `pnpm -C packages/contract typecheck` 通过，错误码和 grant 默认规则与后端一致。
- [ ] `pnpm -r typecheck`、`pnpm -r test`、`cargo test -p server`、`cargo test -p lingfang-desktop`、`pnpm -C apps/desktop vite:build` 最终通过或明确报告非代码性剩余风险。

## Out of Scope

- 不引入真实支付、订阅计费或新市场功能。
- 不新增未实现的本地 capability，如 `fs.write`、`net.fetch`、剪贴板或通知。
- 不把整个服务改成生产部署框架；本轮只修复已确认缺陷和必要契约漂移。

## Notes

- 本任务跨 `apps/server`、`apps/desktop/src`、`apps/desktop/src-tauri`、`packages/contract`、`packages/plugin-sdk` 和示例插件，属于复杂任务，必须配套 `design.md` 与 `implement.md`。
