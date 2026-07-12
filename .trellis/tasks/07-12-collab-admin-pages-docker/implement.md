# 实施计划

1. 盘点 `NAV_GROUPS`、view 懒加载分支、API 端点和现有 Playwright 基础设施。
2. 复现并修复渠道 `models` 缺失时的表单崩溃，增加缺失/空/正常数据回归覆盖。
3. 执行 collab-admin typecheck/build 和 collab-api typecheck/test/build，修复阻断问题。
4. 配置已认证页面冒烟测试，依次验证 15 个后台视图；渠道执行 CRUD，并检查控制台异常与 5xx。
5. 执行 `docker compose -f docker-compose.collab.yml config` 和 build；以隔离项目名及全新卷启动三服务。
6. 检查迁移、种子、容器健康/日志、admin 入口、API 健康端点及同源 `/api` 请求；修复 Docker 部署问题。
7. 重跑相关自动化与 Docker 冒烟，清理隔离容器和卷。

## 验证命令

- `pnpm -C apps/collab-admin typecheck`
- `pnpm -C apps/collab-admin build`
- `timeout 60 pnpm -C apps/collab-api test`
- `pnpm -C apps/collab-api typecheck`
- `pnpm -C apps/collab-api build`
- `docker compose -f docker-compose.collab.yml config`
- `docker compose -p lingfang-collab-check -f docker-compose.collab.yml build`
- `docker compose -p lingfang-collab-check -f docker-compose.collab.yml up -d`

## 风险点

- 不复用或删除现有 Compose 项目的数据卷。
- 渠道 CRUD 只操作测试创建的数据。
- 外部模型、邮件、对象存储调用不纳入冒烟测试。
