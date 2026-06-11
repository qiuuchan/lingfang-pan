# 多租户协作平台实施计划

## Implementation Order

1. 规划与规范
   - 完成 `prd.md`、`design.md`、`implement.md`。
   - 读取桌面前端、契约、跨层思考规范。
   - 启动 Trellis 任务进入 implementation 阶段。

2. Monorepo 骨架
   - 更新 `pnpm-workspace.yaml`，纳入 `apps/collab-api`、`apps/collab-admin`。
   - 新建 `apps/collab-api` NestJS 项目骨架。
   - 新建 `apps/collab-admin` React/Vite/shadcn 风格项目骨架。
   - 约定端口：API `3000`，管理端 `4174`。

3. 后端基础
   - 增加 Prisma schema。
   - 增加 PostgreSQL 连接配置。
   - 增加 seed/admin bootstrap。
   - 增加统一错误格式、requestId、认证 Guard、角色 Guard。
   - 增加 Swagger/OpenAPI 初始化。

4. 后端业务 API
   - Auth / onboarding。
   - Teams / memberships。
   - Invitations。
   - Team admin applications。
   - Plugins。
   - Balance ledger。
   - Admin dashboard / users / teams / approvals / audit logs。

5. 本地客户端改造
   - 扩展 `apps/desktop/src/lib/types.ts`。
   - 改造 `apps/desktop/src/lib/api.ts` 对接 `collab-api`。
   - 改造 `Auth.tsx` 注册流程。
   - 新增 onboarding、团队空间、团队管理页面。
   - 更新 `App.tsx` 页面状态机和 `Sidebar.tsx` 导航。

6. 管理端实现
   - 登录和权限拒绝页。
   - Dashboard。
   - 用户管理。
   - 团队管理。
   - 插件管理。
   - 审批管理。
   - 审计日志。

7. 部署与文档
   - Dockerfile：`apps/collab-api/Dockerfile`、`apps/collab-admin/Dockerfile`。
   - `docker-compose.collab.yml`。
   - `.env.collab.example`。
   - docs：平台、API、部署、本地客户端、管理端。
   - 根 README 增加入口链接。

8. 验证
   - API typecheck / tests。
   - 管理端 typecheck / build。
   - 桌面端 typecheck / build。
   - Docker compose build。
   - Swagger/OpenAPI 覆盖检查。
   - 手测核心链路。

## Validation Commands

```bash
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test
pnpm -C apps/collab-admin typecheck
pnpm -C apps/collab-admin build
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
docker compose -f docker-compose.collab.yml build
```

## Manual Verification

- seed 创建平台管理员 → 管理端登录。
- 管理端创建团队 → 设置余额 → 创建/启用插件。
- 本地客户端普通用户注册 → 输入邀请码 → 进入团队空间。
- 本地客户端团队管理员申请 → 管理端审批 → 团队管理员看到团队管理入口。
- 团队管理员生成邀请码 → 普通用户加入 → 团队管理员移除成员。
- 团队余额扣减 → 管理端和本地客户端均可查看流水。
- 平台管理员登录本地客户端被阻断。
- 普通用户登录管理端被拒绝。

## Risky Files

- `pnpm-workspace.yaml`：影响 workspace 包发现。
- `apps/desktop/src/App.tsx`：全局状态机。
- `apps/desktop/src/lib/api.ts`：所有业务 API 边界。
- `apps/desktop/src/lib/types.ts`：前端会话与 payload 类型。
- `apps/desktop/src/components/Sidebar.tsx`：导航与角色入口。
- `docker-compose.yml`：不直接改旧文件，使用 `docker-compose.collab.yml`。
- `README.md`：只增加协作平台入口链接，不覆盖旧主线说明。

## Rollback Points

- 新应用骨架可单独回滚。
- 后端 schema/API 可在 `apps/collab-api` 内回滚。
- 管理端可在 `apps/collab-admin` 内回滚。
- 桌面端改造需按 `App.tsx`、`api.ts`、`types.ts`、新增页面分组回滚。