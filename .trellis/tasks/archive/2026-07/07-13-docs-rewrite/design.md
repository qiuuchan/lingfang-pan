# 技术设计 — docs 全量文档重写与新增（Child B）

> 真源：`bg_c9d2b000` 审计 + 24 个 controller + 9 个 contract schema 文件

## 1. 文档目录最终态

```
docs/
├── 01-vision-and-architecture.md       (更新)
├── 02-domain-and-plugins.md            (全量重写)
├── 03-backend-and-llm.md               (压缩为历史沿革 ≤30 行)
├── 04-engineering.md                   (更新)
├── billing-and-relay-design.md         (全量重写)
├── collab-platform.md                  (删除 — 见 OQ1 决定)
├── collab-api.md                       (改造为索引导航，详见 §3)
├── collab-deployment.md                (更新)
├── collab-desktop-client.md            (全量重写)
├── collab-admin-guide.md               (全量重写)
├── adr/                                (5 篇不动)
├── evidence/                           (保留现有)
├── plugin-development/                 (新增 8 篇 + README)
├── api-reference/                      (新增 ~30 篇 + README)
└── sdk-guide/                          (新增 5 篇 + README)
```

归档：`plugin-workbench-real-cli-test.md`、`self-review-v4-ui.md` 移到 `.trellis/evidence/archive/`。

## 2. api-reference 章节切分原则

**1 controller = 1 文件**为主，**功能强相关的一组 controller = 1 文件**为例外。理由：单文件易写、易审、易并行委派。

切分映射表（24 controller → 约 30 文件）：

| 文件                    | 覆盖 controller                                                | 备注                                            |
| ----------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| `auth.md`               | `auth.controller.ts`                                           | 含 admin/login、forgot/reset、verify-email      |
| `me.md`                 | `me.controller.ts`                                             | 含 export、delete-account、onboarding           |
| `teams.md`              | `teams.controller.ts` + `PublicTeamsController`                | 含 public、join、profile、default-pool          |
| `applications.md`       | `applications.controller.ts`                                   | 团队管理员申请                                  |
| `plugins.md`            | `plugins.controller.ts`                                        | 含 edit-meta、set-price（即使现在 stub 也列）   |
| `plugin-registry.md`    | `plugin-registry.controller.ts`                                | v4 发布流程                                     |
| `plugin-grants.md`      | `plugin-grants.controller.ts`                                  |                                                 |
| `marketplace.md`        | `marketplace.controller.ts`                                    |                                                 |
| `wallet.md`             | `wallet.controller.ts`                                         |                                                 |
| `billing.md`            | `billing.controller.ts` + `pools.controller.ts`                | admin 端 + `/pools/available`                   |
| `user-billing.md`       | `user-billing.controller.ts`                                   | 团队级 credits                                  |
| `notifications.md`      | `notification.controller.ts`                                   |                                                 |
| `search.md`             | `search/search.controller.ts`                                  |                                                 |
| `tickets.md`            | `ticket.controller.ts`                                         |                                                 |
| `releases.md`           | `release.controller.ts`                                        | 公开更新检查                                    |
| `changelog.md`          | `changelog.controller.ts`                                      |                                                 |
| `setup.md`              | `setup.controller.ts`                                          | 安装向导                                        |
| `platform-info.md`      | `platform-info.controller.ts`                                  |                                                 |
| `relay.md`              | `relay/relay.controller.ts`                                    | 含 chat、messages、images、images/edits、models |
| `admin-users.md`        | `admin-users.controller.ts`（或对应）                          |                                                 |
| `admin-teams.md`        | `admin-teams.controller.ts` + `admin-team-roles.controller.ts` | 含 :id/roles                                    |
| `admin-plugins.md`      | `admin-plugins.controller.ts`                                  | 含 :id/releases、approve、reject                |
| `admin-roles.md`        | `roles.controller.ts` + `permission-groups.controller.ts`      |                                                 |
| `admin-applications.md` | 对应 admin applications controller                             |                                                 |
| `admin-audit.md`        | `audit-logs` 相关                                              |                                                 |
| `admin-stats.md`        | `stats` 相关                                                   |                                                 |
| `admin-releases.md`     | `admin/releases/*`                                             |                                                 |
| `admin-settings.md`     | `admin/settings/*` + `gitee-changelog`                         |                                                 |

如果某 controller 不存在或已被合并，跳过该文件（不写）。

## 3. `collab-api.md` 改造方向

不再放端点列表（已迁到 api-reference/），改为：

- 一句话说明"完整 API 参考见 `api-reference/`"
- 鉴权概述（JWT + tokenVersion + Bearer 头）
- 错误响应统一格式
- 分页约定
- 限流策略
- 示例 curl（注册 → 登录 → 调一个业务端点 → 退出）

长度控制在 ≤80 行。

## 4. plugin-development 章节内容详规

### `01-manifest.md`

- 字段全表（id / name / version / description / runtime_type / entry / visibility / capabilities）每个：类型、约束、范例
- capabilities 子字段（kind / reason / risk / requires_admin / scope）每个：类型、取值、含义
- 风险等级（none/low/medium/high）权威解释 + 推荐 requires_admin 配对
- 校验规则（指向 sdk-guide/02-manifest-validator.md 的 M1-M10）
- 范例：4 类 runtime 各一个最小 manifest

### `02-runtimes.md`

| runtime | 入口 | 执行          | 桥机制                           | 适用场景                        |
| ------- | ---- | ------------- | -------------------------------- | ------------------------------- |
| client  | HTML | iframe srcDoc | `window.sdk` 注入                | UI 交互、需要宿主样式、单页应用 |
| nodejs  | .js  | 子进程        | `LINGFANG_PLUGIN_BRIDGE_URL` env | 后端服务、HTTP API、需要 npm 包 |
| python  | .py  | 子进程        | `LINGFANG_PLUGIN_BRIDGE_URL` env | 数据处理、ML、需要 pip 包       |
| cloud   | URL  | 云端          | 不在桌面壳执行                   | （v1 不写模板，仅说明）         |

每类附"如何调能力"代码片段。

### `03-capabilities.md`

14 种 kind（来自 `CapabilityKind` enum）逐个说明：

- 用途
- 调用签名（含入参 / 返回）
- 风险与权限提示
- 常见组合（如 `fs.pick` + `fs.read` + `llm.chat` 是文档总结类插件典型组合）

### `04-sdk-usage.md`

- client 模式：用 `window.sdk`（宿主注入）+ TS 用户加 `declare const sdk: ClientPluginEntry`
- nodejs/python 模式：`import { sdk, PluginAiError } from '@lingfang/plugin-sdk'`
- 错误处理：`PluginAiError` 的 code/status/requestId 字段含义 + 常见错误码
- 禁忌：不写 apiKey / apiUrl / provider / Authorization header（强约束）

### `05-local-dev.md`

- builtin-plugins 复制法（v1 标准做法）：
  1. `lingfang-plugin validate`
  2. 复制到 `apps/desktop/builtin-plugins/<name>/`
  3. `pnpm -C apps/desktop dev` 重启
- 调试技巧：iframe devtools / Python venv 路径 / Node 日志位置

### `06-publish.md`

- 4 步流程：
  1. `lingfang-plugin build`
  2. `lingfang-plugin publish --base <api> --token <jwt>`
  3. 在桌面端"我的插件"看到新 release
  4. （可选）在管理端 / 团队管理员端"提交市场审核"
- DRAFT → PENDING → APPROVED/REJECTED 状态机

### `07-examples.md`

8 个现有插件逐个剖析：

- summarizer（client + llm.chat + fs.read）：最小文档总结
- ai-demo（nodejs + llm.chat + image.generate）：脚本插件桥调用
- videodl（python + ui.view）：独立 GUI 插件
- ai-example（client + AI）：宿主 SDK 用法
- ai-python-example（python + AI）：脚本 + AI
- game-2048（nodejs + ui.view）：纯 HTTP UI
- calculator（python + ui.view）：极简 GUI
- notes（client + storage + llm.chat）：综合应用

## 5. sdk-guide 章节内容

依赖 Child A 完成。每篇不超过 200 行。

| 文件                       | 内容                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `README.md`                | 索引 + 安装（workspace / 未来 npm）                                                      |
| `01-runtime-client.md`     | `sdk.fs` / `sdk.net` / `sdk.llm` / ... 8 组 API + 错误处理                               |
| `02-manifest-validator.md` | `validateManifest` + 10 条业务规则                                                       |
| `03-cli.md`                | `lingfang-plugin create/validate/build/publish` 完整用法（与 implement.md 对应章节同步） |
| `04-templates.md`          | 3 套模板结构 + 默认值 + 字段含义                                                         |
| `05-typescript.md`         | `ClientPluginEntry` 用法                                                                 |

## 6. 并行委派策略

docs/api-reference/ 的 ~30 篇文件高度独立（每个 controller 独立），可并行委派给 `quick` 类子代理。每个子代理 prompt 必须包含：

- 该 controller 源码路径作为真源
- 输出模板（method + path + 鉴权 + 请求 schema 引用 + 响应 schema 引用 + 错误码 + 范例 curl）
- 中文文案约束
- 不许复制旧 collab-api.md 内容（已审计为过时）

推荐 batch 大小：每批 5 个 controller，并行 4 批（共约 20 个 controller 在第一波），剩余 / 跨控的放第二波。

## 7. 风格指南（强制）

- **标题层级**：H1 文档标题（与文件名一致）、H2 章节、H3 子章节、H4 极少用
- **代码块语言标签**：`bash`/`json`/`typescript`/`http`/`mermaid` 必填
- **HTTP 端点格式**：
  ```http
  POST /api/path/{param}
  Authorization: Bearer <jwt>
  Content-Type: application/json
  ```
- **curl 范例**：
  ```bash
  curl -X POST http://localhost:3000/api/path \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    -d '{"key":"value"}'
  ```
- **表格**：所有字段说明用表格，不用项目符号列表
- **警告块**：`> **注意**：...` 用于关键约束 / 安全提示
- **链接**：相对路径，如 `[详见](../api-reference/auth.md)`

## 8. 既有文档处理决策

### `collab-platform.md`（OQ1）

**决定：删除**。理由：

- 33 行内容已被 README 完整覆盖
- 01-vision-and-architecture.md 承担深度架构
- 保留只会让维护两份相似内容
- 删除后 README 文档清单同步更新

实施：移动到 `.trellis/evidence/archive/collab-platform.md.bak` 而非真删除（保留可追溯）。

### `03-backend-and-llm.md`

**决定：压缩为 ≤30 行历史沿革**。结构：

- 一句话说明：这是 v0.x 的 Rust + axum 后端，已被 NestJS collab-api 取代
- 关键决策的 ADR 索引（0002、0003）
- 不再列任何路由 / 鉴权细节
- 警告：所有引用的 `apps/server` 路径已不存在

## 9. 真源验证清单

实施时每个端点必须用以下方式之一验证：

1. `apps/collab-api/src/modules/<x>.controller.ts` 的 `@Get/@Post...` 装饰器 + path
2. 启动后端后用 `curl` 实测
3. Swagger `/api/docs` 渲染

禁止：复制旧 collab-api.md / 旧 README / 旧审计报告未验证内容。

## 10. 风险与缓解

| 风险                    | 概率 | 影响 | 缓解                                                                                     |
| ----------------------- | ---- | ---- | ---------------------------------------------------------------------------------------- |
| api-reference 漏端点    | 高   | 中   | 按 controller 文件清单逐一勾对，缺一个不算完成                                           |
| 端点 path / method 写错 | 中   | 高   | 每篇完成后用 curl 实测 ≥ 3 个端点（启动后端后）                                          |
| 契约 schema 引用过时    | 中   | 中   | api-reference 文档中只引用 contract 文件路径（不复制 schema 定义），让读者打开文件看最新 |
| 中文风格不统一          | 中   | 低   | 强制按 §7 风格指南；review 阶段统一过一遍                                                |
| 并行子代理产出质量参差  | 高   | 中   | 子代理 dispatch prompt 给详尽模板 + 强约束；review 时统一返工                            |
