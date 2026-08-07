# 后端完善（平台设置+通知+日志健康+导出注销）

## Goal（目标）

完善 collab-api 后端 4 大块（对照调研报告后端缺口 + 配合前端 settings-view）：平台设置端点 + 通知系统 + 结构化日志/健康检查 + 数据导出/注销。

## 范围（4 块，用户全选）

### 1. 平台设置端点（接前端 settings-view TODO）

- 新增 `PlatformSetting` 表（key/value 键值存全局配置：platformName/platformDescription/logoUrl/smtpConfig 等）。
- `GET /api/admin/settings`：读全部配置（ensurePlatformAdmin）。
- `PATCH /api/admin/settings`：更新配置（批量 key/value）。
- 前端 settings-view 从 localStorage 切换为调这个端点（留前端改动给后续，本任务只做后端端点）。
- 平台名称/logo 等公开部分：`GET /api/platform-info`（@Public，官网/客户端展示用）。

### 2. 通知系统

- 新增 `Notification` 表（userId/type/title/body/read/createdAt/relatedType?/relatedId?）。
- 触发点（在现有 service 内埋点）：
  - 审核通过/驳回（adminApprovePlugin/adminRejectPlugin）→ 通知插件作者。
  - 插件被购买（purchasePlugin）→ 通知卖家。
  - 团队管理员申请审批结果 → 通知申请者。
- `GET /api/notifications`（ensureCurrentTeam/当前用户）：我的通知列表（分页 + 未读数）。
- `POST /api/notifications/:id/read`：标记已读。
- `POST /api/notifications/read-all`：全部已读。

### 3. 结构化日志 + 健康检查增强

- 引入 `nestjs-pino`（JSON 结构化日志，生产可聚合到 ELK/Loki）。
  - 请求日志（method/url/status/duration/ip/userId）。
  - 替代 Nest 默认 logger。
  - 敏感字段脱敏（apiKey/password/token 不进日志，pino 的 redact 配置）。
- `/api/health/ready` 端点：DB 探活（`prisma.$queryRaw('SELECT 1')`），失败返 503。
  - 区别于现有 `/api/health`（liveness，始终 200）：ready 检查依赖是否就绪。

### 4. 数据导出 + 账号注销（合规）

- `GET /api/me/export`：导出当前用户数据（个人信息 + 插件 + 购买记录 + 钱包流水 + 对话，返 JSON 或 ZIP）。
- `POST /api/me/delete-account`：注销账号（软删除：status=DISABLED + email 打码 + tokenVersion++，保留数据 N 天后硬删的留 TODO；或硬删 + 审计记录）。
  - 注销前校验无进行中的购买/余额为 0（或允许，标注后果）。

## Constraints

- 简体中文注释。UTF-8 无 BOM。
- 复用：ensurePlatformAdmin/ensureCurrentTeam/ensureTeamAdmin/AppError/AuditLog/$transaction。
- 新表用迁移（非破坏式，加表 + 索引）。
- pino 日志的 redact 必须覆盖 apiKey/password/token/secret（不进日志）。
- 注销用软删除（DISABLED）+ 审计，不立即硬删（避免数据丢失，合规留痕）。
- 通知触发不阻塞主操作（异步写，失败不影主流程）。

## Acceptance Criteria

- [ ] AC1 GET/PATCH /api/admin/settings 读写平台配置（ensurePlatformAdmin）。
- [ ] AC2 GET /api/platform-info 公开返平台名称/logo。
- [ ] AC3 Notification 表 + 触发点（审核/购买至少 3 处）+ GET/POST notifications 端点。
- [ ] AC4 通知未读数正确 + 标记已读。
- [ ] AC5 nestjs-pino JSON 日志 + 请求日志 + apiKey/password/token redact。
- [ ] AC6 /api/health/ready DB 探活（SELECT 1），DB 挂时 503。
- [ ] AC7 GET /api/me/export 导出用户数据（JSON）。
- [ ] AC8 POST /api/me/delete-account 软删除（DISABLED + email 打码 + tokenVersion++）+ 审计。
- [ ] AC9 全量测试绿（新端点单测 + 现有测试不回归 + typecheck/build）。

## 实施顺序（Workflow 并行 4 组）

- 组A：平台设置（schema PlatformSetting + service/controller + platform-info 公开端点）。
- 组B：通知系统（schema Notification + service/controller + 触发点埋点）。
- 组C：pino 日志 + health/ready（main.ts + health.controller）。
- 组D：导出 + 注销（me.controller 扩展 + service）。
  4 组改不同文件（A: admin/new setting / B: notification / C: main/health / D: me），冲突最小。schema 迁移各自一个文件。
