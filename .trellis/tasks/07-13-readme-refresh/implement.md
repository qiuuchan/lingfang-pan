# 实施计划 — README 重写与缺口补全（Child C）

> 关联：`prd.md`、父任务 `07-13-doc-and-sdk-overhaul`
> 前置：Child A 与 Child B 全部完成

## §0 准备（0.3h）

### 步骤

- [ ] 0.1 读取当前 README：`read P:\lingfang-platform\README.md`
- [ ] 0.2 读取实际内置插件清单：
  ```bash
  Get-ChildItem apps/desktop/builtin-plugins -Directory | ForEach-Object {
    $m = Get-Content "$_\\manifest.json" -Raw | ConvertFrom-Json
    [PSCustomObject]@{ dir=$_.Name; id=$m.id; name=$m.name; runtime=$m.runtime_type }
  }
  ```
- [ ] 0.3 读取实际 docs/ 清单：
  ```bash
  Get-ChildItem docs -Recurse -Filter *.md | Select-Object -ExpandProperty FullName
  ```
- [ ] 0.4 读取 collab-api 模块数：
  ```bash
  (Get-ChildItem apps/collab-api/src/modules -Filter *.controller.ts -Recurse).Count
  ```
- [ ] 0.5 读取 ADR 数：
  ```bash
  (Get-ChildItem docs/adr -Filter *.md).Count
  ```
- [ ] 0.6 读取 Prisma 迁移数：
  ```bash
  (Get-ChildItem apps/collab-api/prisma/migrations -Directory).Count
  ```
- [ ] 0.7 读取 `.env.example` 拿真实环境变量清单

### 闸门

所有真实数字 / 路径已知 → 继续 §1。

---

## §1 修正"内置插件"表（0.3h）

### 现有（错）

```markdown
| 插件 | 能力 |
|------|------|
| `file-explorer` | 文件管理器 |
| `system-info` | 系统信息 |
| `todo-list` | 待办事项 |

另有 `plugins/summarizer`（长文总结）作为 LLM 能力示例插件。
```

### 改为（正确）

```markdown
桌面端内置 5 个示例插件（位于 `apps/desktop/builtin-plugins/`）：

| 目录 | 名称 | runtime | 能力 |
|------|------|---------|------|
| `ai-example` | AI 能力实例 | client | `llm.chat` + `image.generate` 演示 |
| `ai-python-example` | Python AI 实例 | python | Python 版 AI 演示 |
| `game-2048` | 2048 小游戏 | nodejs | 自建 HTTP 服务 + 浏览器游戏 |
| `calculator` | 计算器 | python | PySide6 GUI |
| `notes` | Markdown 笔记 | client | `storage.kv` + `llm.chat` 综合应用 |

另有 3 个独立示例插件（位于 `plugins/`）：

| 目录 | 名称 | runtime | 能力 |
|------|------|---------|------|
| `summarizer` | 长文总结 | client | `fs.pick` + `fs.read` + `llm.chat` |
| `ai-demo` | AI 能力演示 | nodejs | `llm.chat` + `image.generate`（脚本桥调用） |
| `videodl` | 视频下载器 | python | PySide6 GUI + videofetch |

> 想自己写一个？见 [插件开发](#插件开发) 章节，或直接 [插件开发文档](docs/plugin-development/README.md)。
```

### 闸门

5+3 个插件全部列出 + 名称与 manifest `name` 字段一致 → 继续 §2。

---

## §2 新增"插件开发"章节（0.5h）

### 位置

在"开发指南"章节之后、"文档"章节之前。

### 内容

```markdown
## 插件开发

LingFang 是插件平台，开发插件是核心用法。插件用 `@lingfang/plugin-sdk` 提供的 CLI 一行起工程。

### 一行起工程

\`\`\`bash
pnpm plugin:create my-plugin --runtime nodejs
cd my-plugin
pnpm plugin:validate
pnpm plugin:build
\`\`\`

`pnpm plugin:*` 是仓库根脚本，等价于 `pnpm -C packages/plugin-sdk exec lingfang-plugin <cmd>`。

### 三类运行时

| runtime | 入口 | 适用场景 |
|---------|------|---------|
| `client` | HTML | UI 交互、需要宿主样式、单页应用（iframe 内运行） |
| `nodejs` | `.js` | 后端服务、HTTP API、需要 npm 包 |
| `python` | `.py` | 数据处理、ML、需要 pip 包 |

> `cloud` runtime 在桌面壳内视为 `client`；v1 不提供模板。

### 能力声明

插件在 `manifest.json` 的 `capabilities` 数组中声明所需能力（如 `llm.chat` / `fs.read` / `storage.kv`），桌面壳在运行时三重校验后执行。完整能力清单见 [`docs/plugin-development/03-capabilities.md`](docs/plugin-development/03-capabilities.md)。

### 发布

打包为 `.lfplugin` 后上传到团队 plugin-registry，可选择提交市场审核：

\`\`\`bash
pnpm plugin:build
pnpm -C packages/plugin-sdk exec lingfang-plugin publish <plugin>.lfplugin \
  --base http://localhost:3000 --token $JWT
\`\`\`

### 深入阅读

- [插件开发文档](docs/plugin-development/README.md) — 完整开发指南
- [SDK 使用指南](docs/sdk-guide/README.md) — CLI / 类型 / 校验器
- [插件 API 参考](docs/api-reference/plugin-registry.md) — 发布端点
- [插件能力契约](docs/02-domain-and-plugins.md) — 领域模型
```

### 闸门

新章节 5 个内部链接全部可达 → 继续 §3。

---

## §3 补全"文档"清单（0.3h）

### 现有（不完整）

```markdown
| 文档 | 内容 |
|------|------|
| [愿景与架构](docs/01-vision-and-architecture.md) | ... |
| [领域模型与插件](docs/02-domain-and-plugins.md) | ... |
| [后端与 LLM](docs/03-backend-and-llm.md) | ... |
| [工程规范](docs/04-engineering.md) | ... |
| [协作平台架构](docs/collab-platform.md) | ... |
| [协作 API](docs/collab-api.md) | ... |
| [协作部署](docs/collab-deployment.md) | ... |
| [桌面客户端](docs/collab-desktop-client.md) | ... |
| [管理端指南](docs/collab-admin-guide.md) | ... |
| [插件工作台实跑测试](docs/plugin-workbench-real-cli-test.md) | ... |
| [ADR](docs/adr/) | ... |
```

### 改为（完整）

```markdown
### 架构与领域

| 文档 | 内容 |
|------|------|
| [愿景与架构](docs/01-vision-and-architecture.md) | 产品定位、系统设计 |
| [领域模型与插件](docs/02-domain-and-plugins.md) | 实体契约、插件清单、领域边界 |
| [后端与 LLM 历史沿革](docs/03-backend-and-llm.md) | v0.x Rust 后端的历史沿革（已被 NestJS 取代） |
| [工程规范](docs/04-engineering.md) | Monorepo 约定、配置隔离 |

### 部署与运维

| 文档 | 内容 |
|------|------|
| [协作部署](docs/collab-deployment.md) | Docker 与手动部署 |
| [桌面客户端](docs/collab-desktop-client.md) | 桌面端说明 |
| [管理端指南](docs/collab-admin-guide.md) | 管理后台使用 |

### 计费与模型

| 文档 | 内容 |
|------|------|
| [计费与中继设计](docs/billing-and-relay-design.md) | 资源池、渠道、信用、relay、定价 |
| [API 概览](docs/collab-api.md) | 鉴权、错误格式、分页约定（端点详见 api-reference/） |

### 插件开发

| 文档 | 内容 |
|------|------|
| [插件开发指南](docs/plugin-development/README.md) | 完整开发流程：quickstart、manifest、runtime、能力、调试、发布 |
| [SDK 使用指南](docs/sdk-guide/README.md) | CLI、运行时客户端、manifest 校验器、模板、TypeScript 类型 |
| [HTTP API 参考](docs/api-reference/README.md) | 全部 controller 端点逐个文档 |

### 架构决策记录

[ADR](docs/adr/) 共 5 篇：桌面壳选型 / LLM 第三方网关 / 多租户持久化 / 插件能力沙箱 / Monorepo 工程。
```

注意：
- 删除"协作平台架构"`collab-platform.md`（已归档）
- 删除"插件工作台实跑测试"`plugin-workbench-real-cli-test.md`（已归档）
- 加入"计费与中继设计"`billing-and-relay-design.md`
- 加入 3 个新目录

### 闸门

文档清单与 docs/ 实际文件一一对应 → 继续 §4。

---

## §4 校正事实点（0.5h）

### 项目结构图

修订：
- "5 篇 ADR" → 确认仍是 5 篇（在 §0.5 已验证）
- "11 个迁移" → 用 §0.6 的实际数字
- 模块清单：把"auth / me / teams / applications / plugins / marketplace / wallet / llm / notifications / release / admin / settings"改为更准确描述（不必全列 24+，但分类汇总）

例：
```
│   │   └── modules/              业务模块（24+ controller，含 auth/me/teams/applications/plugins/
│   │                              plugin-registry/marketplace/wallet/billing/pools/notifications/
│   │                              relay/release/admin-*/settings/setup/search/tickets/roles/...）
```

### 环境变量表

逐项对照 `apps/collab-api/.env.example`（在 §0.7 已读取）：
- 缺的环境变量加上
- 多余的删掉
- 默认值与 `.env.example` 一致

### 内置插件名（已在 §1 处理）

### 仓库结构图中的 packages/

确认 `plugin-sdk` 描述准确：
- 现有："插件能力客户端 SDK（桥 __lingfangInvoke）"
- 改为："插件开发 SDK（运行时客户端 + CLI 脚手架 + manifest 校验器 + 模板）"

### 闸门

所有数字 / 路径 / 描述与实际一致 → 继续 §5。

---

## §5 整合验证（0.3h）

### 步骤

- [ ] 5.1 全文搜索禁词：
  ```bash
  Select-String -Path README.md -Pattern 'file-explorer|system-info|todo-list|apps/server|localhost:4174'
  # 应无输出
  ```
- [ ] 5.2 链接可达性检查：写脚本扫所有 `(docs/...)` 链接，验证目标存在
  ```powershell
  $content = Get-Content README.md -Raw
  $matches = [regex]::Matches($content, '\]\((docs/[^)]+)\)')
  foreach ($m in $matches) {
      $path = $m.Groups[1].Value -replace '#.*$', ''
      if (-not (Test-Path $path)) { Write-Host "broken: $path" }
  }
  ```
- [ ] 5.3 长度检查：`README.md` 行数 ≤ 现有 × 1.3
- [ ] 5.4 模拟新读者：从 README 顶部读到底部，确认所有指引都可达

### 闸门

无禁词 + 无 broken link + 长度合理 → 进入 Phase 3.3 spec update。

---

## §6 失败回退

- §2 新增章节描述的 CLI 与 Child A 实际不一致：以 Child A 为真源，回退 README 描述
- §3 文档清单中的路径与 Child B 实际不一致：以 Child B 为真源，回退 README 链接

---

## 预计耗时

| 章节 | 时长 |
|------|------|
| §0 | 0.3h |
| §1 | 0.3h |
| §2 | 0.5h |
| §3 | 0.3h |
| §4 | 0.5h |
| §5 | 0.3h |
| **合计** | **~2.2h**（约半天） |

## Review Gates

- Gate 1（§2 完成后）：插件开发章节交用户确认风格
- Gate 2（§5 完成后）：完整 README 让用户从头到尾过目一遍

## 不在本计划内

- 不动 docs/ 下任何文件
- 不动代码 / 配置
- 不重写为英文
- 不加新 badge / banner
