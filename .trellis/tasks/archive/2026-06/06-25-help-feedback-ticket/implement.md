# 帮助与反馈工单系统 — 执行计划

## 状态：已实现并通过验证（2026-06-25）

全部验证通过：
- 后端 `pnpm -C apps/collab-api typecheck && test(490 passed) && build` ✓
- 后台 `pnpm -C apps/collab-admin typecheck && build` ✓
- 前台 `pnpm -C apps/desktop typecheck && vite:build && test(119 passed)` ✓

### 落地文件清单
后端：
- `prisma/schema.prisma`：5 枚举 + Ticket/TicketMessage/TicketAttachment + User/Team 反向关系
- `prisma/migrations/20260625000000_ticket_system/migration.sql`（PostgreSQL；MySQL 走 db push）
- `src/modules/permissions/permission-codes.ts`：platform.ticket 模块（view/manage）
- `src/modules/dto/enums.ts`：TICKET_CATEGORY/STATUS/PRIORITY
- `src/modules/dto/ticket.dto.ts`、`ticket-package.ts`（+ spec）、`ticket.service.ts`（+ spec）、`ticket.controller.ts`
- `src/modules/collab.module.ts`：注册 controller + service

前台 desktop：
- `src/lib/api.ts`：api() 加 FormData 分支
- `src/lib/tickets.ts`、`src/pages/HelpFeedback.tsx`
- `src/App.tsx`：openHelpFeedback context + PanelDialog 悬浮窗
- `src/components/AvatarMenu.tsx`：入口从外链改为打开工单中心

后台 collab-admin：
- `src/lib/tickets.ts`、`src/components/tickets-view.tsx`
- `src/lib/types.ts`（View+tickets）、`src/App.tsx`（lazy+渲染）、`src/lib/navigation.ts`（菜单）、`src/lib/view-preload.ts`

### 运维待办（部署时）
- 生产/各环境执行迁移：`pnpm -C apps/collab-api prisma:deploy`（PostgreSQL 应用 migration；MySQL db push）。
- seed 权限：`pnpm -C apps/collab-api seed:rbac`（新 platform.ticket.* 码 upsert，平台管理员自动获授）。
- 确保后端进程对 `apps/collab-api/uploads/` 有写权限（已加入 .gitignore）。

---

## 原始执行计划（保留）

## 实现顺序(后端 → 前台 → 后台,每段可独立验证)

### 阶段 0:准备
- [ ] 确认 `seed-rbac.ts` 给系统平台管理员授「全量平台权限」(否则后续要显式补新码)。
- [ ] 确认 `apps/collab-admin/src/lib/api.ts` 的 `api()` 是否支持 `FormData` body;`apps/desktop/src/lib/api.ts` 同查。
- [ ] 检查根/各 app `.gitignore` 是否需加 `uploads/`(参照 `downloads/` 的处理)。

### 阶段 1:数据层
- [ ] `prisma/schema.prisma` 加 5 枚举 + Ticket/TicketMessage/TicketAttachment 三模型 + User/Team 反向关系。
- [ ] 生成迁移:`pnpm -C apps/collab-api prisma migrate dev --name ticket_system`(或按仓库脚本)。
- [ ] 核对 MySQL provider 渲染:`pnpm -C apps/collab-api typecheck`,查 `.generated/mysql/schema.prisma` 含新表。
- [ ] `pnpm -C apps/collab-api prisma generate` 后 `@prisma/client` 含新模型类型。

### 阶段 2:权限码
- [ ] `permission-codes.ts` 在 PLATFORM_MODULES 加 `platform.ticket` 模块(view/manage,sortOrder 75)。
- [ ] 运行/确认 seed:新码 upsert 进 PermissionEntry;PLATFORM_ADMIN 角色含新码。

### 阶段 3:后端 service + controller
- [ ] `ticket-package.ts`(纯函数):MIME 白名单校验、kind 推断、附件大小/数量校验、状态机转移合法性 —— 便于单测。
- [ ] `ticket.service.ts`:create / listForUser / getForUser / addUserMessage / listAdmin / getAdmin /
      addAdminMessage / updateStatus / streamAttachment。落盘逻辑参照 `release.service.uploadAsset`。
- [ ] `ticket.controller.ts`(前台,requireUser)+ `admin-ticket.controller.ts`(后台,@RequirePermission)。
- [ ] DTO:`dto/ticket.dto.ts`(create/list query/message/patch)。
- [ ] 模块装配:新 `ticket.module.ts` 或并入聚合 module;注入 Prisma/Auth/Notification。
- [ ] 通知联动:管理员回复/改状态触发 `NotificationService.create`(try/catch)。
- [ ] 审计:管理员写操作 `prisma.auditLog.create`(action 如 `admin.ticket.replied`/`admin.ticket.status_changed`)。

### 阶段 4:后端单测(ticket.service.spec.ts)
- [ ] 提交工单建 Ticket+首条 message+附件;teamId 取自 ensureCurrentTeam(无团队→null)。
- [ ] 越权:`getForUser` 他人工单 → notFound;`streamAttachment` 非 admin 下他人附件 → 拒。
- [ ] 状态机:用户回复使 RESOLVED→IN_PROGRESS;CLOSED 工单追加被拒;非法 status 转移被拒。
- [ ] 附件限制:超 10MB / 超 5 个 / 非白名单 MIME → badRequest。
- [ ] 单测带 60s 硬超时。

### 阶段 5:前台 desktop
- [ ] `lib/api.ts`:`api()` 加 `body instanceof FormData` 分支(不强设 JSON Content-Type),或新增 `apiUpload()`。
- [ ] `lib/tickets.ts`:list/get/submit(FormData)/reply(FormData)/下载(fetch+blob)helpers + 类型。
- [ ] `pages/HelpFeedback.tsx`:提交表单 + 本人列表 + 详情对话时间线 + 追加回复;CLOSED 只读。>300 行则拆子组件。
- [ ] 接入页面切换:在 App 页面路由/AppContext 注册新页面;`AvatarMenu.tsx:120` 改为切到该页面。

### 阶段 6:后台 collab-admin
- [ ] `lib/api.ts`:确认/补 FormData 支持。
- [ ] `lib/tickets.ts`:admin helpers(list 带筛选分页 / get / reply / patch / 下载)+ 类型。
- [ ] `components/tickets-view.tsx`:套 releases-view 模板(筛选栏+Table+分页+DetailSheet 对话+回复框+状态/优先级控件)。
- [ ] 注册三处:`lib/types.ts` View 加 `'tickets'`;`App.tsx` lazy + 渲染分支;`lib/navigation.ts` 加导航项(LifeBuoyIcon)。

### 阶段 7:全量验证
- [ ] `pnpm -C apps/collab-api typecheck && pnpm -C apps/collab-api test && pnpm -C apps/collab-api build`
- [ ] `pnpm -C apps/collab-admin typecheck && pnpm -C apps/collab-admin build`
- [ ] `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop vite:build && pnpm -C apps/desktop test`
- [ ] 手动冒烟(若可起服务):提交带附件工单 → 后台看到 → 回复 → 前台收到通知 + 看到回复 → 下载附件。

## 验证命令汇总
```bash
# 后端
pnpm -C apps/collab-api prisma generate
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test        # 60s 硬超时
pnpm -C apps/collab-api build
# 后台
pnpm -C apps/collab-admin typecheck && pnpm -C apps/collab-admin build
# 前台
pnpm -C apps/desktop typecheck && pnpm -C apps/desktop vite:build && pnpm -C apps/desktop test
```

## 风险文件 / 回滚点
- `prisma/schema.prisma` + migration:DB 结构,回滚需 down migration。改前不动现有模型,仅新增。
- `apps/*/src/lib/api.ts`:FormData 分支改动影响全局请求,务必只加分支不改既有 JSON 路径;改后跑全量 typecheck/test。
- `permission-codes.ts` + seed:权限码是授权单一来源,只新增不改既有码。
- `main.ts`:**不要**给 uploads/ 加 static 托管(安全要求)。本任务理论上不需改 main.ts。

## start 前检查
- [ ] 用户已审阅 prd.md / design.md / implement.md。
- [ ] 阶段 0 三项前置确认完成(seed 全量授权、FormData 支持现状、.gitignore)。
- [ ] 确认迁移生成方式(migrate dev vs 手写 migration.sql)与仓库一致。
