# 愿景与当前架构

> 本文描述当前实现。历史技术选择和迁移过程保存在 `docs/adr/` 与带有“历史参考”标记的设计文档中。

## 产品愿景

LingFang 是面向团队的 AI 插件创建、分发和运行平台。用户在桌面端通过对话创建插件，在本地隔离环境中验证，再发布到团队或市场；平台后端统一提供身份、团队、插件治理、模型 relay、计费、通知和版本发布能力。

## 当前系统

```text
Desktop (Tauri 2 + React)
  - OpenAI Agents SDK 对话创建器
  - 草稿工作区与本地插件运行
  - 插件市场、团队、钱包和更新
             |
             | HTTPS / SSE
             v
collab-api (NestJS + Prisma)
  - JWT / RBAC / 团队
  - 插件 package / release / listing / review
  - relay / 灵石账本 / 调用日志
  - 通知 / 发布更新 / 管理 API
             |
             v
PostgreSQL or MySQL (+ optional Redis)

collab-admin (React) ----------------> collab-api
```

## 关键边界

### 桌面端

`apps/desktop` 是 Tauri 2 桌面应用。React 负责产品工作区，Rust 壳负责本机文件、进程、插件安装账本、运行时解析和更新。AI 创建链路位于 `src/lib/agent/` 与 `src/components/creator/`，通过 OpenAI Agents SDK 连接平台 relay；已删除的本地 CLI 助手链路不是当前架构。

Python 和 Node 插件只通过应用的 Runtime Resolver 启动。Resolver 使用应用管理或用户显式指定的运行时，不静默回退系统 PATH。client 插件运行在受控 WebView/iframe 边界。

### 协作后端

`apps/collab-api` 是唯一平台后端，基于 NestJS 11、Prisma 7 和 PostgreSQL/MySQL。它拥有云端业务状态，桌面 Rust 壳不承担租户、市场、钱包或模型网关职责。

### 管理端

`apps/collab-admin` 是 React 管理后台。管理列表使用服务端分页，实体详情和重型字段按需加载；插件发行与团队管理员申请集中在治理中心。

### 契约

`packages/contract` 保存跨前端和后端共享的 Zod 契约。`.lfplugin`、插件 manifest、发行版和治理 DTO 的变更应先更新契约，再同步 API 和桌面消费者。

## 核心链路

1. 用户在桌面创建器描述需求，Agent 生成或修改结构化工作区文件。
2. 桌面端验证 manifest、入口文件与能力声明，并在相应运行时中预览。
3. 发布时生成可复现的 `.lfplugin` 制品，上传为 package release。
4. 平台治理中心按 release 审核；通过后 listing 指向符合规则的当前市场版本。
5. 桌面市场安装制品，校验摘要后原子激活；更新失败保留原活动版本。
6. AI 请求经 relay 路由到平台配置的模型渠道，并写入灵石账本与调用日志。

## 非目标

- 不在桌面端保存平台数据库真相源。
- 不允许插件直接获得平台密钥或宿主全部环境变量。
- 不把历史 Rust/axum 服务、旧 CLI 生成器或迁移期领域模型描述为当前实现。

## 延伸阅读

- [领域与插件](./02-domain-and-plugins.md)
- [工程指南](./04-engineering.md)
- [协作 API](./collab-api.md)
- [协作平台](./collab-platform.md)
- [桌面客户端](./collab-desktop-client.md)
