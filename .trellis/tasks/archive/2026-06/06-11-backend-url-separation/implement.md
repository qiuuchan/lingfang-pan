# Implementation Plan: 完善前后端分离与后端地址配置

## Ordered Checklist

1. Trellis 准备
   - 修正任务元数据。
   - 写入 `prd.md`、`design.md`、`implement.md`。
   - 启动任务进入 `in_progress`。

2. 前端配置层
   - 增加后端 URL 标准化、读取、保存、清空和变更通知能力。
   - 调整 `api()` 连接失败提示。
   - 保证 `streamGenerate()` 继续复用同一 `apiBase()`。

3. 首次启动配置入口
   - `main.tsx` 初始化打包默认配置。
   - `App.tsx` 在无后端 URL 时显示配置入口。
   - 配置入口支持保存和测试 `/health`。

4. 设置页
   - 增加“后端服务地址”卡片。
   - 支持输入、保存、测试。
   - 后端地址变化后重置当前会话并提示用户重新登录。

5. 后端 CORS
   - `Config` 增加 `cors_allowed_origins`。
   - `main.rs` 按配置构建 CORS 层。
   - `.env.example` 增加变量说明。

6. Tauri 配置
   - 调整 CSP `connect-src`，允许用户配置的 HTTP/HTTPS 后端。
   - 确认 `bundle.resources` 仍打包内置插件。

7. 文档
   - 更新 README。
   - 更新 `docs/03-backend-and-llm.md`。
   - 更新 `docs/04-engineering.md`。
   - 更新 `tools/README.md`。

8. 验证
   - `pnpm -C apps/desktop typecheck`
   - `pnpm -C apps/desktop vite:build`
   - `cargo test -p server`
   - 读取最近编辑文件 lint。

9. Trellis 收尾
   - 运行 finish 相关检查。
   - 如发现应沉淀的规范，更新 `.trellis/spec/`。
   - 完成或归档任务。

## Risky Files

- `apps/desktop/src/App.tsx`：App 壳层状态，需避免破坏登录/租户流程。
- `apps/desktop/src/lib/api.ts`：所有业务请求边界。
- `apps/server/src/main.rs`：CORS 层顺序和服务启动。
- `apps/desktop/src-tauri/tauri.conf.json`：CSP 语法错误会影响构建或运行。
- README 与 docs：需要同步当前 SQLite 事实，避免继续传播 PostgreSQL 旧描述。

## Validation Notes

- 无后端 URL状态主要靠本机 localStorage，可通过代码审查与类型构建验证；必要时浏览器/Tauri 手动验证。
- CORS 白名单需要至少覆盖 `Origin` 预检逻辑；单元测试价值有限，主要依赖构建与运行时配置检查。
- 既有工作区有大量无关脏变更，提交和 diff 说明时必须只关注本任务触碰文件。
