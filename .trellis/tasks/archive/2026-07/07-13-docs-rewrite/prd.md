# docs 全量文档重写与新增（Child B）

> 父任务：`.trellis/tasks/07-13-doc-and-sdk-overhaul`
> 调研依据：`bg_c9d2b000`（docs 审计，14 篇 + ADR）

## Goal

把 `docs/` 下所有非 ADR 文档对齐当前代码事实，并新增三大主题目录（插件开发 / API 参考 / SDK 使用指南）。最终状态：任意打开一篇文档，复制其中命令 / 字段 / 路径都能直接执行，且**无任何过时引用**（如已删除的 `apps/server`、错的管理端端口、不存在的内置插件名）。

## Background

**审计发现（bg_c9d2b000）**：

| 文件                                | 严重程度 | 主要问题                                                                                                                                                                                          |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collab-api.md`                     | **严重** | 24 个 controller 仅覆盖 ~10 个，缺约 60% 端点（plugin-registry / notifications / search / pools / releases / changelog / setup / platform-info / tickets / roles / permission-groups 等全部缺失） |
| `02-domain-and-plugins.md`          | **严重** | 缺 v4 插件注册表、PluginGrant（授权）、PluginAiPolicy、PluginArtifact/PluginPackage 上传、Pool/Channel（计费）、Ticket、Role/PermissionGroup（RBAC）、Release/ReleaseAsset 等约 50% 当前领域实体  |
| `collab-admin-guide.md`             | **严重** | 仅覆盖 ~20% 管理功能；缺计费配置 / 模型服务 / 平台设置 / 角色权限 / 发布管理 / 插件注册表管理等                                                                                                   |
| `billing-and-relay-design.md`       | **高**   | 数据模型过时（2026-06-23 资源池重构后 `ChannelBinding`/`ModelTierConfig` 被 `Pool` 取代）；缺 `/api/relay/v1/images/edits` 端点；缺故障转移 / 协议转换 / 容量预扣机制                             |
| `03-backend-and-llm.md`             | **严重** | 引用 `apps/server`（Rust axum），**该目录已被完全删除**                                                                                                                                           |
| `collab-deployment.md`              | 中       | 端口不一致（写 4174，实际 19005）；缺生产安全清单 / 备份程序                                                                                                                                      |
| `collab-desktop-client.md`          | 中       | 缺插件创建工作流 / SDK 使用 / 运行时操作 / 更新机制                                                                                                                                               |
| `01-vision-and-architecture.md`     | 低       | 架构图准确但过简，未含计费 / 插件注册表层                                                                                                                                                         |
| `04-engineering.md`                 | 低       | 基本准确，可补根脚本与测试约定                                                                                                                                                                    |
| `collab-platform.md`                | 低       | 33 行与 README 大量重叠                                                                                                                                                                           |
| `plugin-workbench-real-cli-test.md` | 历史快照 | 应归档，从 docs/ 移走                                                                                                                                                                             |
| `self-review-v4-ui.md`              | 历史快照 | 应归档，从 docs/ 移走                                                                                                                                                                             |

**重大空白**：没有任何一篇"如何开发插件"的文档。这是新 docs/plugin-development/ 要填补的核心。

## Scope

### 必交付

#### A. 重写 12 篇既有文档（不含 ADR）

按 `bg_c9d2b000` 审计分三档处理：

**全量重写**（结构与内容均大改）：

1. `collab-api.md` — 系统盘点 24 个 controller 全部端点，按"公共 / 前台客户端 / 团队管理员 / 平台管理员 / 计费中转"五类组织
2. `02-domain-and-plugins.md` — 补全 v4 插件注册表 / 授权 / AI 策略 / 上传制品 / 计费池 / RBAC / 工单 / 发布等领域实体
3. `collab-admin-guide.md` — 按 20+ 项实际功能重写管理后台使用指南
4. `billing-and-relay-design.md` — 用 Pool 模型重写数据模型，补故障转移 / 协议转换 / 容量预扣
5. `collab-desktop-client.md` — 扩展为完整用户工作流：插件创建器 / SDK 使用 / 运行时 / 更新

**部分更新**：6. `03-backend-and-llm.md` — 压缩为 ≤30 行"历史沿革"说明，引用 ADR；删除所有 `apps/server` 路径引用7. `collab-deployment.md` — 修端口（4174 → 19005）+ 加生产安全清单 + 备份程序 8. `01-vision-and-architecture.md` — 架构图补计费 / 插件注册表层；其余保留 9. `04-engineering.md` — 加根脚本说明 / 测试约定 / Docker Compose 工作流 10. `collab-platform.md` — 决定去留：要么删除（信息已在 README），要么改造为深度平台架构（推荐删除，由 README + 01-vision 承担）

**归档**（移到 `.trellis/evidence/archive/`）：11. `plugin-workbench-real-cli-test.md` 12. `self-review-v4-ui.md`

#### B. 新增三大文档目录

##### B1. `docs/plugin-development/`（插件开发指南）

| 文件                 | 内容                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `README.md`          | 索引 + 5 分钟 quickstart                                         |
| `01-manifest.md`     | manifest.json 字段全表 + 校验规则 + 范例                         |
| `02-runtimes.md`     | 4 类 runtime（client/nodejs/python/cloud）机制、入口形状、桥差异 |
| `03-capabilities.md` | 14 种 capability 详解：声明、调用、风险等级、常见组合            |
| `04-sdk-usage.md`    | `import { sdk }` / `window.sdk` 两种消费方式 + 各 API 用法       |
| `05-local-dev.md`    | 本地预览方法（builtin-plugins 复制法）+ 调试技巧                 |
| `06-publish.md`      | 打包 → 上传到团队 → 提交市场审核全流程                           |
| `07-examples.md`     | 8 个现有插件逐个剖析（按 runtime 分组）                          |

##### B2. `docs/api-reference/`（HTTP API 参考）

| 文件                    | 内容                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `README.md`             | 索引 + 鉴权概述 + 错误码总表 + 分页约定                                                        |
| `auth.md`               | `/api/auth/*`（含 admin/login、forgot-password、reset-password、verify-email）                 |
| `me.md`                 | `/api/me/*`（含 export、delete-account、onboarding）                                           |
| `teams.md`              | `/api/teams/*`（含 public、join、profile、default-pool）                                       |
| `applications.md`       | `/api/applications/*`（团队管理员申请）                                                        |
| `plugins.md`            | `/api/plugins/*`（含 edit-meta、set-price、policy/check）                                      |
| `plugin-registry.md`    | `/api/plugin-registry/*`（v4 发布流程）                                                        |
| `plugin-grants.md`      | `/api/teams/current/plugin-packages/*/grants`                                                  |
| `marketplace.md`        | `/api/marketplace/*`                                                                           |
| `wallet.md`             | `/api/wallet/*`                                                                                |
| `billing.md`            | `/api/admin/billing/*`（pools、channels、pricing、credits、call-logs）+ `/api/pools/available` |
| `user-billing.md`       | `/api/teams/current/credits/*`                                                                 |
| `notifications.md`      | `/api/notifications/*`                                                                         |
| `search.md`             | `/api/search/*`                                                                                |
| `tickets.md`            | `/api/tickets/*`                                                                               |
| `releases.md`           | `/api/releases/*`（公开更新检查）                                                              |
| `changelog.md`          | `/api/changelog`                                                                               |
| `setup.md`              | `/api/setup/*`（安装向导）                                                                     |
| `platform-info.md`      | `/api/platform-info`                                                                           |
| `relay.md`              | `/api/relay/v1/*`（chat/completions、messages、images/generations、images/edits、models）      |
| `admin-users.md`        | `/api/admin/users/*`                                                                           |
| `admin-teams.md`        | `/api/admin/teams/*`（含 :id/roles）                                                           |
| `admin-plugins.md`      | `/api/admin/plugins/*`（含 :id/releases、approve、reject）                                     |
| `admin-roles.md`        | `/api/admin/roles/*` + `/api/admin/permission-groups/*`                                        |
| `admin-applications.md` | `/api/admin/applications/*`                                                                    |
| `admin-audit.md`        | `/api/admin/audit-logs`                                                                        |
| `admin-stats.md`        | `/api/admin/stats/*`                                                                           |
| `admin-releases.md`     | `/api/admin/releases/*`                                                                        |
| `admin-settings.md`     | `/api/admin/settings/*`                                                                        |

> 文件按 controller 一对一（或一组对应一个），每个端点列出：method + path + 鉴权要求 + 请求 schema（引 contract Zod）+ 响应 schema + 错误码 + 范例 curl。

##### B3. `docs/sdk-guide/`（SDK 使用指南）

| 文件                       | 内容                                                     |
| -------------------------- | -------------------------------------------------------- |
| `README.md`                | 索引 + 安装方式（workspace / 未发布到 npm 的说明）       |
| `01-runtime-client.md`     | `import { sdk }` 8 组 API 用法 + 错误处理                |
| `02-manifest-validator.md` | `import { validateManifest }` 用法 + 业务规则            |
| `03-cli.md`                | `lingfang-plugin create/validate/build/publish` 完整用法 |
| `04-templates.md`          | 3 套模板结构 + 字段含义                                  |
| `05-typescript.md`         | `ClientPluginEntry` 类型用法                             |

> **依赖 Child A**：本目录所有内容描述 Child A 的真实 CLI / API 形态。Child A 必须先完成或并行同步。

### 不交付（明确出范围）

- 不重写 ADR（5 篇历史决策快照保留原貌）
- 不写英文版（项目语言策略是简体中文）
- 不写交互式 API explorer / Swagger 替代品（已有 `/api/docs` Swagger）
- 不写架构图重制（保留 Mermaid 源码，渲染由 GitHub 完成）
- 不写监控 / 日志 / 性能调优运维手册（部署文档已覆盖基础）

## Requirements

### 功能性

- R1：12 篇既有文档全部按 scope 处理（5 全量重写 + 5 部分更新 + 2 归档）。
- R2：`docs/plugin-development/` 8 篇文档全部新增且互相交叉引用有效。
- R3：`docs/api-reference/` 约 30 篇文档全部新增；每篇覆盖对应 controller 的全部端点（用 Swagger 装饰器为真源）。
- R4：`docs/sdk-guide/` 5 篇文档全部新增；与 Child A 的实际 CLI / API 一字不差。
- R5：README 的"文档"清单（由 Child C 维护）指向本任务产出的所有文档，链接可达。

### 非功能性

- N1（事实一致）：每个文档中的命令、路径、字段名、HTTP 端点、错误码必须经过代码交叉验证。**禁止**复制旧文档未经验证的内容。
- N2（真源优先级）：
  - HTTP 端点真源 → `apps/collab-api/src/modules/*.controller.ts` 的 Swagger 装饰器
  - 领域模型真源 → `packages/contract/src/*.ts` Zod schema
  - 配置项真源 → `apps/collab-api/.env.example`
  - 端口 / 脚本真源 → 各 app 的 `package.json`
- N3（语言）：全部简体中文；代码标识符、HTTP method、JSON 字段名保持英文。
- N4（链接）：所有 docs/ 内部交叉引用使用相对路径；README 指向 docs 的链接在 GitHub 与本地 Markdown 预览都能打开。
- N5（ADR 不动）：5 篇 ADR 不做内容修改。如某 ADR 提到的实体已被取代，在新文档中加"已被 ADR-XXX 演进，见 docs/xxx.md"提示，不修 ADR 本身。
- N6（不破坏代码）：本任务只动 `docs/` 与归档目录。不动任何代码 / 配置 / schema。
- N7（中文风格一致）：所有文档遵循同一风格——标题层级 / 代码块语言标签 / 表格格式 / 警告块（`> **注意**：`）/ 范例 curl 格式。

### 约束

- C1：不引入文档生成工具（如 TypeDoc / Swagger UI 静态化）。手写 Markdown。理由：项目无此构建链，且手写更可控。
- C2：不在 docs/ 内嵌大量自动生成的 API schema（如完整 Prisma DDL）。引用文件路径即可。
- C3：归档目录路径：`.trellis/evidence/archive/`（与现有 `.trellis/evidence/` 一致），不另起。

## Acceptance Criteria

- [ ] `docs/` 下 12 篇非 ADR 文档全部按 scope 完成（重写 / 更新 / 归档）
- [ ] `docs/plugin-development/` 至少 8 篇 .md 文件，索引 README 可达所有子文档
- [ ] `docs/api-reference/` 至少 30 篇 .md 文件，覆盖 24 个 controller 的全部公开端点
- [ ] `docs/sdk-guide/` 至少 5 篇 .md 文件，描述的 CLI / API 与 Child A 实际实现一致
- [ ] 全文搜索 `apps/server` 在 docs/ 中无残留（仅在 ADR 中允许，且 ADR 不动）
- [ ] 全文搜索 `localhost:4174` 在 docs/ 中无残留（实际端口是 19005）
- [ ] 全文搜索 `file-explorer`/`system-info`/`todo-list` 在 docs/ 中无残留（实际内置插件是 ai-example / ai-python-example / game-2048 / calculator / notes）
- [ ] 抽样验证：随机选 10 个文档中的 curl 命令，本地启动后端后能跑通 ≥ 8 个（不允许的端点如 admin 删除用户除外）
- [ ] 所有 docs/ 内部交叉引用链接在 GitHub 渲染下可达（用 `find docs -name '*.md' | xargs grep -E '\]\(' | ...` 自查）

## Open Questions

- OQ1：`collab-platform.md` 是删除还是改造？design.md 倾向**删除**（信息已在 README + 01-vision），但需用户确认。
- OQ2：`docs/api-reference/` 拆成 30 个小文件 vs 合并为 1 个大文件？design.md §2 倾向**拆分**（单文件易写易维护），但 Child C 的 README 索引会变长。

## Dependencies

- **强依赖**：Child A 完成（`docs/sdk-guide/` 描述 Child A 的 CLI）
- **弱依赖**：Child A 的 implement.md §0 调研产出（`.lfplugin` 格式、publish 端点 schema）应作为 docs 对应章节的真源

## Notes

- 本任务工作量最大（~30+ 篇新文档 + 12 篇既有处理），建议**并行委派**给多个文档子代理，每个 agent 负责 1-3 个 controller 的 api-reference 章节。
- 子代理 dispatch 时必须在 prompt 中提供 controller 源码路径作为真源，要求 agent 读源码而非旧文档。
