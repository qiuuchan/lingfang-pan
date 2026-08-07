# 帮助与反馈工单系统 — 技术设计

## 架构总览

```
desktop (前台)                collab-api (后端 NestJS)               collab-admin (后台)
┌──────────────┐    HTTP     ┌──────────────────────────┐  HTTP    ┌──────────────────┐
│ pages/Help-  │ ──────────▶ │ TicketController         │ ◀─────── │ tickets-view.tsx │
│ Feedback.tsx │  /api/      │  (前台 requireUser)      │ /api/    │ (lazy view)      │
│ lib/tickets  │  tickets/*  │ AdminTicketController    │ admin/   │ lib/tickets.ts   │
└──────────────┘             │  (@RequirePermission)    │ tickets/*└──────────────────┘
                             │ TicketService            │
                             │ ├─ Prisma: Ticket /       │
                             │ │  TicketMessage /        │
                             │ │  TicketAttachment       │
                             │ └─ 本地磁盘 uploads/tickets│
                             └──────────────────────────┘
```

设计原则:复刻现有 `notification` + `release` 模块的分层与约定,不引入新框架或新依赖。
附件存储复用 `release.service.uploadAsset` 的 multer 落盘思路,但目录改为受控的 `uploads/tickets/`,
**不**经 Express static 公开,改由鉴权流式下载接口提供。

## 数据模型(Prisma schema 增量)

```prisma
enum TicketCategory { BUG FEATURE ACCOUNT OTHER }
enum TicketStatus   { OPEN IN_PROGRESS RESOLVED CLOSED }
enum TicketPriority { LOW NORMAL HIGH }
enum TicketAuthorRole { USER ADMIN }
enum TicketAttachmentKind { LOG IMAGE OTHER }

model Ticket {
  id            String         @id @default(uuid())
  userId        String                                  // 提交人
  teamId        String?                                 // 提交时当前团队(ensureCurrentTeam,可空)
  category      TicketCategory @default(OTHER)
  title         String
  status        TicketStatus   @default(OPEN)
  priority      TicketPriority @default(NORMAL)
  handlerUserId String?                                 // 最近处理的管理员
  lastReplyAt   DateTime?                               // 最近一条消息时间(列表排序)
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt
  user          User           @relation("TicketSubmitter", fields: [userId], references: [id], onDelete: Cascade)
  team          Team?          @relation(fields: [teamId], references: [id], onDelete: SetNull)
  messages      TicketMessage[]
  attachments   TicketAttachment[]

  @@index([userId, createdAt])
  @@index([status, createdAt])
  @@index([teamId, status])
}

model TicketMessage {
  id           String           @id @default(uuid())
  ticketId     String
  authorUserId String
  authorRole   TicketAuthorRole
  body         String
  createdAt    DateTime         @default(now())
  ticket       Ticket           @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  attachments  TicketAttachment[]

  @@index([ticketId, createdAt])
}

model TicketAttachment {
  id         String               @id @default(uuid())
  ticketId   String
  messageId  String?                                    // null = 工单首贴附件
  filename   String                                     // 原始展示名
  storedName String                                     // 磁盘随机名(uploads/tickets/<ticketId>/<storedName>)
  mimeType   String
  sizeBytes  Int
  kind       TicketAttachmentKind @default(OTHER)
  createdAt  DateTime             @default(now())
  ticket     Ticket               @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  message    TicketMessage?       @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@index([ticketId])
  @@index([messageId])
}
```

User/Team 模型加反向关系字段:`User.submittedTickets Ticket[] @relation("TicketSubmitter")`、
`Team.tickets Ticket[]`。`handlerUserId` 不建强关系(避免 User 关系爆炸,与 `auditLog.actorUserId` 同风格弱引用 + 出参时按需 join 查 displayName)。

> 注意:迁移需对 PostgreSQL 和 MySQL 双 provider 生效。按现有做法写 `prisma/migrations/<ts>_ticket_system/migration.sql`;
> 若仓库用 `prisma migrate dev` 自动生成则照常生成,人工核对 enum 在 MySQL provider 下的渲染(参考 `.generated/mysql/schema.prisma`)。

## 状态机

```
OPEN ──(管理员开始处理)──▶ IN_PROGRESS ──(标记解决)──▶ RESOLVED ──(关闭)──▶ CLOSED
  │                            │                          │
  └────────── 任意活跃态可直接 CLOSED(管理员关闭) ─────────┘
RESOLVED/IN_PROGRESS ──(用户追加回复)──▶ 自动回到 IN_PROGRESS(重新打开讨论)
CLOSED:只读,双方均不可追加(前台 R7 / 后台 R9)。需重开则新建工单。
```

- 用户追加消息:若工单为 RESOLVED,自动置回 IN_PROGRESS(用户不满意继续沟通);OPEN/IN_PROGRESS 保持。
- 管理员可显式设 status/priority;每次管理员回复默认把 status 至少推进到 IN_PROGRESS 并记 handlerUserId。
- 任意消息写入后更新 `lastReplyAt`。

## API 契约

### 前台(`TicketController`,`@Controller('tickets')`,全部 `requireUser(req).id`)

- `POST /api/tickets` — multipart:fields(category,title,body)+ files[](≤5)。
  service 内 `ensureCurrentTeam(userId)` 取 teamId(无团队则 null,catch 兜底),建 Ticket + 首条 USER message + 附件。
- `GET /api/tickets` — 本人工单列表,query:status?/limit?(clamp [1,50]),按 lastReplyAt desc。
- `GET /api/tickets/:id` — 详情(校验 `ticket.userId === currentUser`,否则 `notFound` 不泄漏存在性),含 messages + attachments。
- `POST /api/tickets/:id/messages` — multipart:body + files[]。追加 USER 消息,触发状态机(RESOLVED→IN_PROGRESS)。
- `GET /api/tickets/:id/attachments/:attachmentId` — 鉴权流式下载(见下「附件下载」)。

### 后台(`AdminTicketController`,`@Controller('admin/tickets')`)

- `GET` (`platform.ticket.view`) — 全部工单,query:status?/category?/teamId?/q?(标题模糊)/page/pageSize。
- `GET /:id` (`platform.ticket.view`) — 任意工单详情。
- `POST /:id/messages` (`platform.ticket.manage`) — multipart:追加 ADMIN 消息(+附件),记 handlerUserId,推进状态,触发 Notification。
- `PATCH /:id` (`platform.ticket.manage`) — 改 status/priority(校验状态机合法转移)。
- `GET /:id/attachments/:attachmentId` (`platform.ticket.view`) — 下载。

> 复用决策:下载逻辑前后台一致,抽 `TicketService.streamAttachment(ticketId, attachmentId, viewer)`,
> viewer = { userId, isAdmin };非 admin 时校验 `ticket.userId === viewer.userId`。controller 各自挂鉴权后调用。

## 附件存储与下载(核心差异点)

- **上传**:controller 用 `FileFieldsInterceptor([{name:'files',maxCount:5}], { limits:{ fileSize: 10*1024*1024 } })`
  (与 `admin.controller.ts:349` 同款,maxCount/limits 调整)。service 内:
  - 校验 MIME 白名单(R13);不合规 `badRequest`。
  - 目录 `resolve(process.cwd(), 'uploads', 'tickets', ticketId)`,`mkdirSync(..,{recursive:true})`。
  - storedName = `${randomBytes(8).hex}${ext}`;`writeFileSync`(buffer 模式)/`copyFileSync`(path 模式),与 release 一致。
  - kind 推断:`image/*`→IMAGE;`text/*`/`.log`/`application/json`→LOG;否则 OTHER。
- **下载**:NestJS `@Res({ passthrough:false })` 取 Express res,或返回 `StreamableFile`。
  设 `Content-Disposition: attachment; filename*=UTF-8''<encoded>`、`Content-Type: mimeType`,
  `createReadStream(filePath)` 流式返回。文件缺失 → `notFound`。
  **绝不**把 uploads/ 目录注册到 `express.static`(与 downloads/ 的关键区别)。
- **删除工单**:Prisma `onDelete: Cascade` 删 DB 记录;磁盘文件清理本期不做(与 release 删除不清 downloads/ 同款,记 Out of Scope 注释)。

## 权限(`permission-codes.ts` 增量)

在 `PLATFORM_MODULES` 加一个模块(sortOrder 取 75,介于 release 70 与 admin 80 之间):

```ts
defineModule('PLATFORM', 'platform.ticket', '工单反馈', 75, [
  { code: 'platform.ticket.view',   label: '查看工单',   description: '查看用户提交的帮助与反馈工单' },
  { code: 'platform.ticket.manage', label: '处理工单',   description: '回复工单、变更状态与优先级' },
]),
```

- `seed-rbac.ts` 全量 upsert ALL_PERMISSIONS,新码自动入 PermissionEntry;系统平台管理员角色应包含新码(确认 seed-rbac 给 PLATFORM_ADMIN 授全量平台权限,否则显式补)。
- AdminTicketController 方法挂 `@RequirePermission('platform.ticket.view'|'manage')`。

## 前端设计

### desktop

- 新 `pages/HelpFeedback.tsx`(或 `pages/help/` 目录,若 >300 行拆 list/detail/submit 子组件)。
- `lib/tickets.ts`:API helpers(list/get/submit/reply/下载 URL 构造)。multipart 用 `FormData`,
  经 `api()` 发送时需绕过默认 `Content-Type: application/json` —— 新增 `apiUpload()` helper 或给 `api()` 加
  `body instanceof FormData` 分支(让浏览器自动设 multipart boundary)。**这是 lib/api.ts 唯一需改处**。
- 下载附件:`fetch(base + path, { headers: Authorization })` → blob → `URL.createObjectURL` 触发下载
  (不能用裸 URL,因为下载接口需 Bearer)。
- `AvatarMenu.tsx:120`:`onClick` 从 `window.open(docs)` 改为切到工单页面(走 AppContext 的页面切换)。

### collab-admin

- 新 `components/tickets-view.tsx`,套 `releases-view.tsx` 模板:Section + 筛选栏 + Table + 分页 + DetailSheet/Dialog。
- `lib/tickets.ts`:admin API helpers。multipart 上传同样需 FormData(确认 `lib/api.ts` 的 `api()` 是否已支持 FormData,
  不支持则同样加分支)。
- 注册三处:`lib/types.ts` View 联合加 `'tickets'`;`App.tsx` lazy import + `{view === 'tickets' && <TicketsView/>}`;
  `lib/navigation.ts` 在「内容」或新增组里加 `{ view:'tickets', label:'工单反馈', icon: LifeBuoyIcon }`。

## 通知联动

- 管理员回复 / 改状态后,`NotificationService.create(ticket.userId, 'ticket_reply', title, body, { relatedType:'Ticket', relatedId:ticket.id })`,
  try/catch 包裹仅记日志(与现有埋点一致)。TicketModule 注入 NotificationService。

## 模块装配

- 新 `ticket.module.ts` 或并入现有聚合 module。注册 TicketController、AdminTicketController、TicketService;
  导入 PrismaService、AuthService、NotificationService。参考 `collab.module.ts` 装配方式。

## 风险与权衡

- **multipart + 全局 JSON 中间件**:`main.ts` 全局 `json()`/`urlencoded()` 不影响 multipart(multer 拦截器先吃 multipart body)。已被 release 上传验证可行。
- **MySQL enum 渲染**:双 provider,迁移需核对 `.generated/mysql`。新增 5 个枚举,风险低但需 typecheck + 生成验证。
- **附件目录权限**:`uploads/` 应在部署文档/`.gitignore` 标注(与 `downloads/` 同款,不入库)。检查 `.gitignore` 是否需加 `uploads/`。
- **下载越权**:核心安全点。service 层统一校验 viewer,单测必须覆盖「他人下载本人附件被拒」。

## 回滚

- 后端:删 TicketModule/三 controller-service/权限码增量;migration 写对应 down(或新 migration 删表)。
- 前端:View 联合、navigation、App.tsx、AvatarMenu 改动均为增量,revert 即可;无破坏性 schema 外改动。
