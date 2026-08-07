# 实施计划 — docs 全量文档重写与新增（Child B）

> 关联：`prd.md`、`design.md`、父任务 `07-13-doc-and-sdk-overhaul`
> 前置：Child A 的 §0-§4 完成（CLI 形态、manifest 校验器、模板）后 sdk-guide 章节才能写

## §0 准备（0.5h）

### 步骤

- [ ] 0.1 启动后端：`pnpm -C apps/collab-api dev`，确认 `http://localhost:3000/api/docs` Swagger 可访问
- [ ] 0.2 用 `gh` 或脚本导出 Swagger JSON 备份：`curl http://localhost:3000/api/docs-json > .trellis/tasks/07-13-docs-rewrite/research/swagger.json`
- [ ] 0.3 列出所有 controller 文件：`Get-ChildItem apps/collab-api/src/modules -Filter *.controller.ts -Recurse | Select-Object -ExpandProperty Name`，记到 `research/controllers.txt`
- [ ] 0.4 创建目录骨架：`docs/plugin-development/`、`docs/api-reference/`、`docs/sdk-guide/`、`.trellis/evidence/archive/`

### 闸门

后端可启动 + Swagger JSON 已备份 → 继续 §1。

---

## §1 归档历史快照（0.2h）

### 步骤

- [ ] 1.1 `git mv docs/plugin-workbench-real-cli-test.md .trellis/evidence/archive/`
- [ ] 1.2 `git mv docs/self-review-v4-ui.md .trellis/evidence/archive/`
- [ ] 1.3 `git mv docs/collab-platform.md .trellis/evidence/archive/collab-platform.md.bak`（OQ1 决定删除）

### 验证

`docs/` 下不再有这三个文件。

---

## §2 重写既有文档 — 高优先级（4h，可委派 5 个并行子代理）

按以下批次并行委派（每批一个 `quick` 子代理）：

### 批 2A：`collab-api.md` 全量改造（改为索引导航，详见 design.md §3）

**委派 prompt 要点**：

- 真源：`apps/collab-api/src/common/` 下的守卫 / 装饰器 / 异常过滤器
- 输出：≤80 行中文文档，含鉴权概述 + 错误格式 + 分页 + 限流 + 示例 curl
- 风格：按 design.md §7
- 不许复制旧 collab-api.md

### 批 2B：`02-domain-and-plugins.md` 全量重写

**委派 prompt 要点**：

- 真源：`packages/contract/src/*.ts` 全部 9 个 schema 文件
- 必须覆盖：identity / plugin / plugin-registry / admin-governance / draft / llm / rbac / billing / semver 全部领域
- 输出：领域边界 + 实体关系 + 状态机 + 契约文件路径索引
- 与 plugin-development/ 区分：本文档面向"理解架构"的二次开发者，不是"教写插件"的手册

### 批 2C：`collab-admin-guide.md` 全量重写

**委派 prompt 要点**：

- 真源：`apps/collab-admin/src/components/admins/` 全部子目录 + `apps/collab-api/src/modules/admin-*` + `apps/collab-api/src/modules/admin/*.controller.ts`
- 必须覆盖：仪表板、用户、团队、插件（含注册表）、应用、审批、审计、计费（pools/channels/pricing/credits/call-logs）、模型服务、平台设置、角色权限、发布、搜索配置、工单
- 每个功能：位置（左导航路径）+ 配置项 + 后端端点索引

### 批 2D：`billing-and-relay-design.md` 全量重写

**委派 prompt 要点**：

- 真源：
  - `apps/collab-api/src/modules/billing.controller.ts`（含 2026-06-23 重构注释）
  - `apps/collab-api/src/modules/pool.service.ts` / `channel.service.ts` / `credit.service.ts` / `pricing.service.ts`
  - `apps/collab-api/src/modules/relay/relay.service.ts`
  - `packages/contract/src/billing.ts`
- 必须覆盖：Pool 模型（DEDICATED/SHARED）、Channel（CHAT/IMAGE 分离）、故障转移 `ChannelRouterService.selectCandidates`、协议转换 OpenAI↔Anthropic、容量预扣 `CreditService.reserve/reconcile/refund`、上下文窗口计算、所有 relay 端点（含 `/images/edits`）、`normalizeDeveloperRole`、imageEditsPassthrough

### 批 2E：`collab-desktop-client.md` 全量重写

**委派 prompt 要点**：

- 真源：
  - `apps/desktop/src/pages/*.tsx`（PluginCreator / Plugins / Settings / Market / Team / Wallet / Auth 等）
  - `apps/desktop/src/lib/cli/` + `conversations/` + `plugin-draft/` + `updater/`
  - `apps/desktop/src-tauri/src/updater.rs`
  - `apps/desktop/builtin-plugins/`
- 必须覆盖：登录 / 团队切换、Agent 创建器工作流（对话→草稿→发布）、插件运行（4 类 runtime）、检查更新、平台 provider 配置、内置插件清单

### 闸门

5 篇全部提交 + 各自自查通过 → 继续 §3。

### 验证

```bash
# 抽查命令/路径
grep -nE 'apps/server' docs/02-domain-and-plugins.md docs/billing-and-relay-design.md docs/collab-admin-guide.md docs/collab-desktop-client.md
# 应无输出

grep -nE '4174|file-explorer|system-info|todo-list' docs/*.md
# 应无输出（除非是显式说明"已删除"）
```

---

## §3 更新既有文档 — 中优先级（1.5h）

### 步骤

- [ ] 3.1 `03-backend-and-llm.md`：压缩为 ≤30 行历史沿革（按 design.md §8）
- [ ] 3.2 `collab-deployment.md`：
  - 全文 sed 替换 `4174` → `19005`
  - 加"生产安全清单"章节（JWT ≥ 16 字符、LLM_KEY_ENCRYPTION_KEY、CORS、HTTPS 终结）
  - 加"备份程序"章节（PostgreSQL pg_dump / MySQL mysqldump 命令范例）
  - 加"更新程序"章节（Tauri updater minisign 签名流程）
- [ ] 3.3 `01-vision-and-architecture.md`：
  - 架构图（Mermaid）补：计费层（Pool/Channel/Credit）、插件注册表层、relay 层
  - 文字描述补：v4 插件注册表 / Pool 资源池 / 多租户 RBAC / 安装向导
- [ ] 3.4 `04-engineering.md`：
  - 加"根脚本"表（pnpm start / dist / typecheck / lint / test / dev:*）
  - 加"测试约定"（Vitest 单测 + Rust cargo test）
  - 加"Docker Compose 工作流"小节
- [ ] 3.5 `collab-api.md`：批 2A 已完成

### 闸门

5 篇更新完成 → 继续 §4。

---

## §4 新增 docs/plugin-development/（3h）

8 篇文档 + README，按 design.md §4 顺序写。

可委派并行：

- 4A：README + 01-manifest + 02-runtimes（一组子代理）
- 4B：03-capabilities + 04-sdk-usage（依赖 Child A）
- 4C：05-local-dev + 06-publish + 07-examples

### 闸门

8 篇 + README 全部完成 + 互相交叉引用链接验证 → 继续 §5。

### 验证

```bash
# 检查交叉引用链接
grep -nE '\]\(' docs/plugin-development/*.md | grep -vE '\]\(\./|\]\(\.\./|\]\(https?://'
# 应无输出（所有链接要么是相对路径要么是 http(s) URL）
```

---

## §5 新增 docs/api-reference/（5h，最大块）

按 design.md §2 的 30 个文件清单，**4 批并行委派**：

### 批 5A（auth + me + teams + applications + plugins）— 5 个 controller

### 批 5B（plugin-registry + plugin-grants + marketplace + wallet + billing）— 5 个

### 批 5C（user-billing + notifications + search + tickets + releases + changelog + setup + platform-info）— 8 个

### 批 5D（relay + admin-users + admin-teams + admin-plugins + admin-roles + admin-applications + admin-audit + admin-stats + admin-releases + admin-settings）— 10 个

每篇委派 prompt 模板：

```
[CONTEXT]
Active task: .trellis/tasks/07-13-docs-rewrite
真源：apps/collab-api/src/modules/<controller-name>.controller.ts
备份参考：.trellis/tasks/07-13-docs-rewrite/research/swagger.json

[REQUEST]
为 <controller-name> 写一份 docs/api-reference/<filename>.md，覆盖：
- 该 controller 所有公开端点
- 每个端点：method + path + 鉴权要求 + 请求 schema（引 contract 文件路径）+ 响应 schema + 错误码 + 范例 curl
- 文档头加一行"对应代码：<controller path>"
- 风格按 .trellis/tasks/07-13-docs-rewrite/design.md §7

[FORBIDDEN]
- 不许复制旧 collab-api.md 内容
- 不许编造端点（必须在源码装饰器中存在）
- 不许用英文（除代码标识符）

[OUTPUT]
单文件 markdown，长度 < 250 行
```

### 闸门

每批完成后跑：

```bash
# 自查：所有 controller 都被覆盖
$controllers = Get-ChildItem apps/collab-api/src/modules -Filter *.controller.ts -Recurse
foreach ($c in $controllers) {
    # 提取 controller 名，查 docs/api-reference/<x>.md 是否存在
    ...
}
```

缺一篇不算完成。

### 验证

```bash
# 抽样：启动后端，跑 5 个端点的 curl
curl -X POST http://localhost:3000/api/auth/login -d '{"email":"admin@example.com","password":"ChangeMe123!"}' -H "Content-Type: application/json"
# 应返回 200 + JWT
# 用 JWT 再跑 4 个端点...
```

---

## §6 新增 docs/sdk-guide/（1.5h，依赖 Child A）

5 篇文档 + README。

**前置条件**：Child A 的 §1-§8 完成（CLI、validator、templates 真实存在），否则不能写。

每篇直接以 Child A 的 design.md / implement.md 为真源。

### 闸门

5 篇 + README 完成 + 与 Child A 实际 CLI / API 一字不差 → 继续 §7。

### 验证

```bash
# 抽样：sdk-guide 中描述的每个 CLI 命令实测一遍
pnpm -C packages/plugin-sdk exec lingfang-plugin --help
pnpm -C packages/plugin-sdk exec lingfang-plugin create tmp-sdk-test --runtime client
pnpm -C packages/plugin-sdk exec lingfang-plugin validate tmp-sdk-test
rm -rf tmp-sdk-test
# 文档描述与实际行为一致
```

---

## §7 整合验证（1h）

### 步骤

- [ ] 7.1 全文搜索禁词：
  ```bash
  # 应无输出
  grep -rE 'apps/server' docs/
  grep -rE 'localhost:4174' docs/
  grep -rE 'file-explorer|system-info|todo-list' docs/ | grep -v archive
  grep -rE 'ChannelBinding|ModelTierConfig' docs/ | grep -v archive
  ```
  （archive 目录中可以保留，因为是历史快照）
- [ ] 7.2 链接自查：写一个 PowerShell 脚本扫所有 `[...](xxx)` 链接，验证目标文件存在
- [ ] 7.3 README 索引更新（与 Child C 协调，但本任务确保所有新文档路径已知）
- [ ] 7.4 风格统一过一遍（标题层级 / 代码块语言 / 表格格式）
- [ ] 7.5 抽样 10 个 curl 实测：启动后端，逐个跑

### 闸门

所有禁词清零 + 链接全可达 + 抽样 curl 通过率 ≥ 80% → 进入 Phase 3.3。

---

## §8 失败回退

- §2 某篇文档严重卡壳：单独保留旧文档，加 `> **注意**：本文档待重写` 标记，其他继续
- §5 某个 controller 源码不清晰：在文档中标注"待 controller 实现确认"，不写猜测内容
- §6 sdk-guide 与 Child A 失同步：以 Child A 实际实现为准，sdk-guide 二次校正

---

## 预计耗时

| 章节     | 时长                                              |
| -------- | ------------------------------------------------- |
| §0       | 0.5h                                              |
| §1       | 0.2h                                              |
| §2       | 4h（并行 5 子代理）                               |
| §3       | 1.5h                                              |
| §4       | 3h（并行 3 子代理）                               |
| §5       | 5h（并行 4 批子代理）                             |
| §6       | 1.5h                                              |
| §7       | 1h                                                |
| **合计** | **~16.7h**（约 2 工作日，并行委派后墙钟时间更短） |

## Review Gates

- Gate 1（§2 完成后）：5 篇高优先级重写文档交用户抽样过目
- Gate 2（§5 完成后）：抽 3 个 controller 文档让用户验证完整性
- Gate 3（§6 完成后）：sdk-guide 与 Child A 一致性确认
- Gate 4（§7 完成后）：所有禁词清零 + 链接全可达 → Phase 3.3 spec update

## 不在本计划内

- 不动 ADR（5 篇历史决策快照）
- 不写英文文档
- 不写运维监控手册
- 不生成静态 API explorer（已有 Swagger）
