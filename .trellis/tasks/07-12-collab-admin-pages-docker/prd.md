# 修复管理后台页面与 Docker 部署

## Goal

修复协作管理后台的运行时页面崩溃，并验证管理后台页面、后端 API 与 Docker Compose 生产部署链路可正常使用。

## Requirements

- 修复渠道管理编辑流程对缺失或旧版 `models` 数据不兼容导致的 `join` 运行时异常。
- 枚举并访问管理后台全部可导航页面，记录并修复阻断页面渲染的前端异常与关键接口错误。
- 验证管理后台与协作 API 的类型检查、构建和既有自动化测试。
- 使用 `docker-compose.collab.yml` 验证 PostgreSQL、collab-api、collab-admin 的构建、迁移、种子、启动、健康状态和前端到 API 的访问链路。
- 不修改或覆盖当前未提交的 `.trellis/tasks/07-12-bundled-base-runtimes/` 内容。

## Confirmed Facts

- `formFromChannel` 直接执行 `c.models.join('\n')`，而页面其他位置已将 `models` 视为可缺失字段，接口旧数据或列表简化响应会触发崩溃。
- 协作部署使用 `docker-compose.collab.yml`，包含 PostgreSQL、collab-api 和 collab-admin 三个服务。
- collab-api 容器启动时执行 Prisma generate/deploy、管理员与 RBAC 种子，然后启动 API。
- collab-admin 镜像当前使用 `serve` 提供静态文件；Compose 注释宣称由 Nginx 代理 `/api/`，但容器定义自身不包含 Nginx。

## Acceptance Criteria

- [x] 渠道列表及编辑弹窗面对缺失、空或正常 `models` 时均不崩溃，并有回归覆盖。
- [x] 管理后台全部可导航页面能在已认证会话中加载，无未捕获前端异常或阻断性 5xx。
- [x] 管理后台和协作 API 的构建、类型检查及相关测试通过。
- [x] `docker compose -f docker-compose.collab.yml build` 成功。
- [x] 全新 Docker 数据卷下三个服务能启动，数据库迁移与种子成功，管理后台入口和 API 健康端点可访问。
- [x] Docker 部署中的前端 API 请求路由与文档/配置一致，不依赖未声明的外部代理才能工作，或明确记录并验证该代理前置条件。

## Out of Scope

- 桌面端和插件页面的全面回归。
- 对真实第三方模型、邮件、对象存储等付费或外部服务执行破坏性测试。

## Open Question

- 已确认：全部后台页面覆盖加载和只读接口冒烟；渠道管理额外覆盖新增、编辑、删除。

## Notes

- 用户原始错误来自生产构建产物 `channels-view-*.js`，需要从源码修复并通过生产构建验证。
