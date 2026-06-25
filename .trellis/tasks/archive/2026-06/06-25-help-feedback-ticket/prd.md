# 帮助与反馈工单系统

## Goal

把 desktop 前台「帮助与反馈」从一个外链(`https://lingfang.io/docs`)升级为完整的工单系统:
前台用户可提交工单(带日志/图片附件)、查询自己工单列表与处理进度、与管理员多轮对话;
collab-admin 后台管理员可列表筛选工单、查看详情与附件、变更状态、多轮回复用户。

## Confirmed Facts (codebase-verified)

- **无对象存储**:全仓无 OSS/S3/MinIO/COS/Qiniu 依赖。现有上传方案是后端本地磁盘:
  multer `FileFieldsInterceptor` 收文件 → 写 `downloads/` → Express `static('/downloads')` **公开**托管
  (`admin.controller.ts:347`、`release.service.ts:257`、`main.ts:64`)。插件文件内联存 DB JSON。
- **后端** `apps/collab-api`:NestJS + Prisma(PostgreSQL/MySQL),controller/service/dto 分层;
  前台鉴权 `requireUser(req).id`,团队 `auth.ensureCurrentTeam(userId)`;
  后台 `@RequirePermission('code')`(`permissions.guard.ts`);审计 `prisma.auditLog.create`;
  用户级 CRUD 参照 `notification.service.ts`/`notification.controller.ts`。
- **权限码**:`permissions/permission-codes.ts` 单一来源;新增需注册 → `seed-rbac.ts` upsert → controller 挂 `@RequirePermission`。
- **后台** `apps/collab-admin`:React+Vite;业务页 `*-view.tsx` + `App.tsx` lazy 注册 + `view===` 渲染;
  导航 `lib/navigation.ts`(NAV_GROUPS);View 联合类型在 `lib/types.ts`;
  「列表+Dialog+DetailSheet+分页」模板 = `releases-view.tsx`/`plugins-view.tsx`。
- **前台** `apps/desktop`:React+Vite+Tailwind v4;现「帮助与反馈」仅 `AvatarMenu.tsx:120` 外链;
  页面在 `pages/`,API 边界 `lib/api.ts`(`api<T>(path, opts)`,带 `Authorization` + `X-Client: desktop`)。
- 迁移用 Prisma migration 目录 `prisma/migrations/<时间戳>_<name>/migration.sql`;seed 见 `src/seed-*.ts`。

## Decisions (confirmed with user)

1. **附件**:新建受控本地目录(`uploads/tickets/`),**不**走公开 `/downloads`。下载经鉴权接口,
   仅提交人本人或有后台权限的管理员可读。日志可能含敏感信息,不暴露可猜 URL。
2. **归属**:工单关联提交人 `userId` + 提交时当前团队 `teamId`(`ensureCurrentTeam`)。
   前台仅能查看本人提交的工单;后台管理员看全部,可按团队/状态/类型筛选。
3. **回复**:多轮对话(`TicketMessage` 表)。用户与管理员均可追加消息,形成时间线。
4. **后台入口**:新增顶级菜单「工单反馈」+ 新权限码 `platform.ticket.*`,与 releases/plugins 平级。

## Requirements

### 数据模型
- R1 `Ticket`:id、提交人 userId、teamId(可空)、category(枚举:bug/feature/account/other)、
  title、status(OPEN/IN_PROGRESS/RESOLVED/CLOSED)、priority(LOW/NORMAL/HIGH,默认 NORMAL)、
  handlerUserId(可空,最近处理管理员)、lastReplyAt、createdAt、updatedAt。
- R2 `TicketMessage`:id、ticketId、authorUserId、authorRole(USER/ADMIN)、body、createdAt。
- R3 `TicketAttachment`:id、ticketId、messageId(可空,首贴附件可挂工单本身)、
  filename、storedName、mimeType、sizeBytes、kind(LOG/IMAGE/OTHER)、createdAt。

### 前台(desktop)
- R4 「帮助与反馈」入口从外链改为打开应用内工单页面(新 page)。
- R5 提交工单:选分类、填标题、填首条描述、上传附件(日志/图片);提交后进列表。
- R6 工单列表:仅本人工单,显示标题/分类/状态/最近更新,点开看详情。
- R7 工单详情:对话时间线(用户+管理员消息)、附件下载、可追加回复与附件;CLOSED 工单只读。

### 后台(collab-admin)
- R8 工单列表 view:全部工单,按 status/category/team/关键词筛选 + 分页;显示提交人、团队、状态、优先级、最近更新。
- R9 工单详情:对话时间线、附件下载、改 status/priority、追加管理员回复(可带附件)。
- R10 顶级菜单「工单反馈」,受新权限码控制。

### 附件存储与下载
- R11 上传走 multer `memoryStorage`/`diskStorage`,写 `uploads/tickets/<ticketId>/<随机名>`,不公开静态托管。
- R12 下载接口 `GET /api/tickets/:id/attachments/:attachmentId`:鉴权后校验「本人 or 后台权限」,流式返回文件。
- R13 限制:单文件 ≤ 10MB,单次 ≤ 5 个,允许 MIME:`text/*`、`application/json`、常见日志后缀、`image/png|jpeg|webp|gif`。

### 权限与通知
- R14 新权限码:`platform.ticket.view`(查看)、`platform.ticket.manage`(处理/回复/改状态)。注册 + seed。
- R15 管理员回复或改状态时,触发 `NotificationService.create` 通知提交人(try/catch 包裹,不阻塞)。

## Acceptance Criteria

- [ ] 后端 `pnpm -C apps/collab-api typecheck && test && build` 全绿;新增 ticket.service 单测覆盖状态流转、越权(他人工单返 not_found)、附件限制。
- [ ] Prisma migration 生成且 schema 含 Ticket/TicketMessage/TicketAttachment 三表 + 枚举。
- [ ] 前台:能提交带附件工单、看到本人列表、打开详情追加回复;无法看到他人工单。
- [ ] 后台:新「工单反馈」菜单在有权限时可见;能筛选/分页、改状态/优先级、回复;附件可下载。
- [ ] 附件不经 `/downloads` 公开;无权限用户访问下载接口被拒。
- [ ] `pnpm -C apps/collab-admin typecheck && build`、`pnpm -C apps/desktop typecheck && vite:build && test` 全绿。

## Out of Scope

- 工单分配/工作流引擎、SLA 计时、邮件外发通知(仅站内 Notification)。
- 附件病毒扫描、缩略图生成、富文本/Markdown 渲染附件预览。
- 知识库/FAQ/帮助文档内容本身(本任务只做工单;帮助文档仍可保留外链)。
- 工单评分/满意度回访。
- 真正对象存储(OSS/S3)迁移——仍用本地磁盘,后续可替换存储适配层。

## Open Questions

- 无阻塞性问题。实现细节(枚举命名、分页大小默认值)按现有约定取值。
