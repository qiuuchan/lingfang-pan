# 多租户协作平台

## Goal

构建一个三平台多租户协作系统：

- 前台：改造现有本地客户端 `apps/desktop`，面向普通用户和团队管理员。
- 管理端：新增网页管理端 `apps/collab-admin`，仅面向平台管理员。
- 后端：新增统一 API 服务 `apps/collab-api`，承载认证、RBAC、团队、邀请码、审批、插件、团队共享余额、审计、Swagger/OpenAPI。

所有前端应用必须通过统一 API 进行认证、注册和业务操作。平台管理员只通过网页管理端访问；普通用户和团队管理员只通过本地客户端使用。

## Confirmed Facts

- 当前仓库已有 React/Tauri 本地客户端：`apps/desktop`。
- 当前仓库已有旧 Rust/SQLite 服务端：`apps/server`，本任务不在其上扩展新三平台业务。
- 当前桌面端已有后端 URL 配置、登录、租户选择、侧边栏、shadcn/ui 基础组件，可作为改造入口。
- 当前 pnpm workspace 只覆盖 `apps/desktop`、`packages/*`、`plugins/*`，需显式纳入新 Node/React 应用。
- 新后端技术栈确定为 `NestJS + Prisma + PostgreSQL`。
- 管理端视觉使用 shadcn/ui，并参考 shadcn dashboard 示例。

## Requirements

### Architecture

- 系统由前台本地客户端、网页管理端、统一后端 API 三部分组成。
- 前台和管理端不得各自维护业务状态分支，必须调用同一后端 API。
- 后端负责真实权限判断，前端只负责入口隔离和用户体验。

### Authentication And Initial Admin

- 后端提供统一注册、登录、当前会话、刷新会话、退出登录接口。
- 初始平台管理员通过后端 seed/bootstrap 创建，不采用“首个注册用户自动成为管理员”。
- seed 创建必须幂等：已有平台管理员时不重复创建、不覆盖密码。
- 平台管理员不能通过本地客户端注册得到。
- 平台管理员登录本地客户端时，本地客户端只提示使用网页管理端。

### RBAC And Isolation

- 角色包含 `PLATFORM_ADMIN`、`TEAM_ADMIN`、`MEMBER`。
- `PLATFORM_ADMIN` 只用于管理端，拥有全局管理能力。
- `TEAM_ADMIN` 只管理自己团队范围内的成员、邀请码和余额流水。
- `MEMBER` 只能访问所在团队授权数据。
- 后端接口必须验证请求者角色和资源归属。
- 团队域资源必须按团队隔离。

### Front Desk Local Client

- 改造 `apps/desktop`，作为普通用户和团队管理员前台。
- 注册页支持“我是团队管理员”选项。
- 普通用户注册后必须输入有效团队邀请码加入团队。
- 团队管理员注册申请进入待审批状态。
- 客户端提供团队空间首页、团队管理页、邀请码管理、成员管理、团队余额与流水展示。
- 客户端插件入口必须通过后端查询可用插件，禁用插件不可用。

### Admin Web

- 新增 `apps/collab-admin`。
- 管理端提供登录、仪表盘、用户管理、团队管理、插件管理、审批管理、审计日志。
- 管理端表单、表格、弹窗、卡片、按钮使用 shadcn/ui 风格组件。
- 普通用户或团队管理员登录管理端时必须被拒绝。

### Backend API

- 新增 `apps/collab-api`。
- 使用 PostgreSQL 持久化。
- 使用 Prisma 管理 schema、迁移和 seed。
- 使用 NestJS Guard 实现全局管理员和团队角色授权。
- 提供 Swagger UI 和 OpenAPI JSON。
- 错误响应格式统一，至少包含 `code`、`message`、`requestId`。

### Documentation

- 完善项目文档、API 文档、部署文档、初始管理员文档、本地客户端接入文档、管理端使用文档。
- 根 README 增加三平台协作系统入口链接，但不覆盖现有 LingFang 桌面/Rust/SQLite 主线说明。
- API 文档必须覆盖前台和管理端实际调用接口。

## Acceptance Criteria

- [ ] `apps/collab-api` 可以启动，并连接 PostgreSQL。
- [ ] `apps/collab-api` 提供 Swagger UI `/api/docs` 和 OpenAPI JSON `/api/docs-json`。
- [ ] 初始平台管理员可通过 seed/bootstrap 幂等创建。
- [ ] 平台管理员可登录 `apps/collab-admin`，普通用户和团队管理员不可进入管理端。
- [ ] 平台管理员可创建/管理用户、团队、插件、审批和团队余额。
- [ ] 普通用户可在 `apps/desktop` 注册、登录、输入邀请码加入团队并进入团队空间。
- [ ] 团队管理员可在 `apps/desktop` 提交申请，审批通过后管理所属团队成员和邀请码。
- [ ] 团队管理员不可修改团队余额，不可管理其他团队。
- [ ] 插件启用/禁用状态由后端控制，本地客户端只展示可用插件。
- [ ] 团队余额扣减使用后端事务，并写入余额流水。
- [ ] 项目文档能指导从空环境启动后端、创建初始管理员、登录管理端、配置本地客户端 API 地址。
- [ ] API 静态文档和 Swagger 均覆盖认证、onboarding、团队、成员、邀请码、审批、插件、余额、审计、管理端接口。
- [ ] 通过类型检查、构建、核心 API 测试和 Docker Compose 构建验证。

## Out Of Scope

- 不实现真实支付或第三方支付网关。
- 不新增普通用户网页前台。
- 不重写 Tauri 本地能力网关。
- 不把新业务接入旧 Rust/SQLite 服务端。
- 不实现复杂组织层级或跨团队多身份切换，除非后续需求明确。
