# 技术设计

## 边界与数据流

渠道数据流为 PostgreSQL -> Prisma channel service -> 管理 API JSON -> `Channel` 类型 -> `ChannelsView` 表单。前端不得假设历史数据或简化列表响应一定含 `models`；在表单映射边界将非数组值归一为空数组，正常数组保持不变。

后台页面清单以 `src/lib/navigation.ts` 的 `NAV_GROUPS` 为单一来源。已认证浏览器会话依次打开所有 15 个后台视图，收集未捕获异常、静态资源失败和阻断性 API 5xx；写操作仅覆盖渠道 CRUD。

Docker 数据流为浏览器 -> collab-admin 静态服务 -> `/api/*` -> collab-api -> PostgreSQL。验证现有 Compose 声明是否真正提供该链路；若同源代理缺失，在 admin 镜像内提供明确的反向代理配置，而不是依赖未声明的宿主 Nginx。

## 兼容与测试

- 保持 API 对正常 `models: string[]` 的现有行为。
- 缺失或空 `models` 显示为空模型列表，不让 React 渲染崩溃。
- 用纯映射函数单元测试或等价组件回归覆盖缺失、空和正常数组。
- Docker 验证使用项目 Compose 文件和临时/全新卷，结束后清理本任务创建的容器与卷。

## 回滚

前端兼容修复可单文件回滚。Docker 配置变更保持在 admin Dockerfile/代理配置与 Compose 范围，若启动验证失败，保留日志并回滚到最后可构建状态，不影响宿主已有数据库。
