# 执行计划：设置页 CLI/运行时检测安装与模型网关配置

> 配套 `design.md` + `prd.md`。四阶段渐进式 checklist，每步含「改什么 + 验证命令 + 通过标准」。简体中文注释，文件操作用专用工具，前端 pnpm，Rust cargo，Prisma 脚本走 `pnpm --filter`。

## 前置依赖

- 已具备：桌面 Rust 探测（`code_assistant::list_tools`/`check_tool`/`probe_script_runtime`）、后端 `class-validator`+`ValidationPipe`+`AuditLog`+`ensurePlatformAdmin`/`ensureTeamAdmin`/`ensureCurrentTeam`+JWT_SECRET fail-fast 模式、`tabs.tsx`/`ui/*`/`api.ts`/`tauriInvoke`/`tauriListen`。
- 环境：Windows + PowerShell 7，pnpm 包管理，cargo（apps/desktop/src-tauri），Python 用 **py launcher**。
- 不改：现有探测逻辑、后端既有端点、settings 后端地址 Card 逻辑、contract 既有 schema。

---

## 阶段 1：契约 + 后端基础（无前端/桌面依赖，先行）

**目标**：单一真源契约 + 数据模型 + 加密工具就位，后续端点与服务可依赖。

### 1.1 契约包重建 zod schema

- 改 `packages/contract/src/llm.ts`（已读，当前仅 ChatMessage + ErrorCode）：
  - 保留 `ChatMessage`、现有 `ErrorCode`。
  - 追加 design §8 的 `LlmGatewayPublicSchema`/`TenantBindingPublicSchema`/`BindingUpsertInputSchema`/`GatewayCreateInputSchema`/`GatewayUpdateInputSchema` + 导出类型。
  - 追加 `LlmErrorCode` enum（6 个新码）。
  - 顶部注释更新：移除「CONTRACT-06 删除空壳」说明，改为「LLM 网关目录 + 租户绑定单一真源（本任务重建）」。
- 验证：`pnpm --filter @lingfang/contract typecheck`。通过标准：无 TS 报错。

### 1.2 Prisma 数据模型

- 改 `apps/collab-api/prisma/schema.prisma`（已读全文）：
  - enum 区（紧邻 `PluginReviewStatus` 后）追加 `enum LlmGatewayStatus { ENABLED DISABLED }`。
  - 文件末尾追加 `model LlmGateway` + `model TenantLlmBinding`（design §2 完整字段）。
  - `model Team`（:103-116）`plugins Plugin[]` 后追加 `bindings TenantLlmBinding[]`。
  - `model User`（:76-101）`auditLogs AuditLog[]` 后追加 `createdLlmBindings`/`updatedLlmBindings`（@relation("BindingCreator"/"BindingUpdater")）。
- 生成迁移：`pnpm --filter @lingfang/collab-api prisma:migrate -- --name llm_gateway_catalog`（生成 `migrations/20260614*_llm_gateway_catalog/migration.sql`）。
  - 若交互卡住（migrate dev 需连库），改用：`cd apps/collab-api && pnpm prisma migrate dev --name llm_gateway_catalog`（DATABASE_URL 已在 .env）。
- 验证：`pnpm --filter @lingfang/collab-api prisma:generate` + 查看生成的 migration.sql 含两表两枚举。通过标准：generate 无错，migration.sql 含 `CREATE TABLE "LlmGateway"` / `"TenantLlmBinding"`。

### 1.3 加密工具 + 单测

- 新建 `apps/collab-api/src/crypto/credential-cipher.ts`（design §3 完整签名）：
  - `requireKeyEncryptionKey()` / `encryptApiKey(plain,key)` / `decryptApiKey(packed,key)` / `maskApiKey(plain)` / `fingerprintApiKey(plain)`。
  - `decryptApiKey` 失败抛 `new AppError(500,'llm_key_decrypt_failed','apiKey 解密失败')`（import AppError from '../common'）。
- 新建 `apps/collab-api/src/crypto/credential-cipher.spec.ts`（design §10.1）：
  - `encrypt_decrypt_roundtrip`、`tampered_tag_throws`、`tampered_iv_throws`、`iv_randomness`、`mask_boundary`、`fingerprint_stable`。
- 验证：`pnpm --filter @lingfang/collab-api test -- credential-cipher`。通过标准：6 个新测全绿。

### 1.4 main.ts 密钥断言 + .env.example

- 改 `apps/collab-api/src/main.ts`（已读，:24-29 JWT_SECRET 断言后）追加 LLM 密钥 fail-fast（design §3 断言代码块）。
  - 解析出的 key 暂存为模块级变量或 Nest provider token，供 LlmService 注入（1.5/2.1 用）。
- 改 `apps/collab-api/.env.example`（已读，:9 后）追加 `LLM_KEY_ENCRYPTION_KEY=""` + 注释。
- 验证：`pnpm --filter @lingfang/collab-api typecheck`。通过标准：无 TS 报错。

### 1.5 DTO + enums

- 新建 `apps/collab-api/src/modules/dto/llm.dto.ts`（design §5 完整 4 个 DTO）。
- 改 `apps/collab-api/src/modules/dto/enums.ts` 追加 `LLM_PROVIDER` / `LLM_GATEWAY_STATUS` 常量（design §5 末尾）。
- 验证：`pnpm --filter @lingfang/collab-api typecheck`。通过标准：无 TS 报错。

**阶段 1 Review Gate**：`pnpm --filter @lingfang/contract typecheck` + `pnpm --filter @lingfang/collab-api typecheck && test`（含 credential-cipher 6 测）+ migration.sql 生成正确。未过不进阶段 2。

---

## 阶段 2：后端端点（依赖阶段 1）

**目标**：LlmService + LlmController + admin 路由 + seed 就位，端到端 API 可用。

### 2.1 LlmService

- 新建 `apps/collab-api/src/modules/llm.service.ts`：
  - 注入 `PrismaService`、`AuthService`（复用 ensureXxx）、加密 key（Nest DI token）。
  - 平台网关目录方法：`adminListGateways(actorId)` / `adminCreateGateway(actorId,dto)` / `adminUpdateGateway(actorId,id,dto)` / `adminSetGatewayStatus(actorId,id,status)`，首行均 `ensurePlatformAdmin`。
  - 租户方法：`listGatewaysForTenant(actorId)`（ensureCurrentTeam，仅 ENABLED）/ `listBindings(actorId)`（ensureCurrentTeam，publicBinding 映射，零解密）/ `upsertBinding(actorId,dto)`（ensureTeamAdmin，gateway.status 校验，$transaction: upsert + auditLog）/ `deleteBinding(actorId,gatewayId)`（ensureTeamAdmin，$transaction）/ `decryptBindingKey(actorId,gatewayId)`（ensureTeamAdmin + binding 存在 + gateway ENABLED + $transaction: auditLog + 返回明文）。
  - 辅助：`publicBinding(binding)` 显式挑字段白名单（不依赖拦截器）、`effectiveModels(binding,gateway)` = modelOverride ?? gateway.models、`normalizeApiUrl(url)` 去尾斜杠。
  - apiKey 可选语义（B5）：dto.apiKey undefined → 保留原密（kind=config_only）；非空 → encryptApiKey + 覆盖 apiKeyHint + keyFingerprint（kind=key_rotated 或 create）。
  - 审计 metadata 固定 shape `{teamId,gatewayId,provider,kind?,enabled?}`，**永不记 key 明文/密文/hint**。
- 新建 `apps/collab-api/src/modules/llm.service.spec.ts`（design §10.1）：
  - `member_cannot_upsert_binding`（403）/ `disabled_gateway_rejected`（gateway_disabled）/ `cross_tenant_invisible` / `dto_whitelist_strips_unknown` / `audit_metadata_has_no_key`（AC12）/ `decrypt_writes_audit`。
- 验证：`pnpm --filter @lingfang/collab-api test -- llm.service`。通过标准：6 测全绿。

### 2.2 LlmController + admin 路由

- 新建 `apps/collab-api/src/modules/llm.controller.ts`：
  - `@Controller('llm')` + `@ApiTags('LLM')` + `@ApiBearerAuth()`。
  - 5 个路由（design §4.2）：GET /gateways、GET /binding、PUT /binding、DELETE /binding/:gatewayId、POST /binding/:gatewayId/decrypt。
  - 每个方法 `@Req() req` + `requireUser(req).id` 透传 service。
- 改 `apps/collab-api/src/modules/admin.controller.ts`（已读全文）追加 4 个 `/admin/llm-gateways` 路由（GET/POST/PATCH/:id/PATCH/:id/status，design §4.1），委托 admin.service 或直接调 LlmService。
- 改 `apps/collab-api/src/modules/admin.service.ts` 追加 4 个 admin 网关方法（委托 LlmService + ensurePlatformAdmin 已在 service 内）。
- 验证：`pnpm --filter @lingfang/collab-api typecheck`。通过标准：无 TS 报错。

### 2.3 collab.module 注册

- 改 `apps/collab-api/src/modules/collab.module.ts`（已读）：
  - controllers 追加 `LlmController`。
  - providers 追加 `LlmService` + 加密 key 的 Nest provider（如 `{ provide: 'LLM_KEY', useFactory: () => requireKeyEncryptionKey() }`）。
- 验证：`pnpm --filter @lingfang/collab-api typecheck && pnpm --filter @lingfang/collab-api build`。通过标准：构建成功。

### 2.4 seed 默认网关

- 改 `apps/collab-api/src/seed-admin.ts`（或新建 `seed-llm-gateways.ts` 由 package.json `db:setup` 调用）追加 DEFAULT_GATEWAYS upsert（design §9，按 name 幂等 upsert）。
- 改 `apps/collab-api/package.json` 的 `db:setup` 脚本若新文件则串联调用。
- 验证：`cd apps/collab-api && pnpm seed:admin`（或 db:setup）。通过标准：无错，查库 `SELECT name FROM "LlmGateway"` 含 6 条默认。

**阶段 2 Review Gate**：`pnpm --filter @lingfang/collab-api typecheck && test && build` 全绿 + seed 6 条默认网关入库 + 手动 curl/swagger 验证 GET/PUT/decrypt 端点（AC6-AC10/AC13）。未过不进阶段 4。

---

## 阶段 3：桌面 Tauri（可与阶段 2 并行，依赖阶段 1 契约）

**目标**：cli_installer 命令就位，前端可调。

### 3.1 可见性提升

- 改 `apps/desktop/src-tauri/src/code_assistant.rs:1293` `fn kill_child_tree` → `pub(crate) fn kill_child_tree`。
- 改 `apps/desktop/src-tauri/src/plugin_script.rs:187` `fn minimal_env` → `pub(crate) fn minimal_env`。
- 验证：`cd apps/desktop/src-tauri && cargo build`。通过标准：编译无错（可见性提升不破坏现有调用）。

### 3.2 cli_installer.rs

- 新建 `apps/desktop/src-tauri/src/cli_installer.rs`（design §6 完整）：
  - 顶部安全边界注释（仿 plugin_script.rs:1-16 风格）：声明本通道是「用户主动触发的包管理器执行」，winget id 白名单、env_clear 裁宿主 token、输出 redact。
  - 类型：`InstallTarget` enum（serde lowercase）/ `InstallStatus` enum（PascalCase）/ `InstallResult` / `InstallInput`。
  - `winget_package_id(target)` 查表（design §6.4，5 个 id）。
  - `installer_env()` 构造白名单 env（design §6.6）。
  - `redact_log_line(line)` 过滤敏感行（design §6.7）。
  - `cleanup_partial_install(target)`（design §6.5）：winget list 查残留 → winget uninstall。
  - `install_cli`/`install_runtime` 命令（design §6.3 流程）：平台判定 → 查 id → spawn winget → run_capture_with_env 300s → 判定 exit code → 失败/超时调 cleanup → Succeeded emit `code-assistant://availability-changed` → 写 install-history.jsonl。
  - `cancel_install` 命令：杀进程组（复用 kill_child_tree）。
  - `#[cfg(test)]`（design §10.2）：`winget_package_id_lookup` / `non_windows_unsupported`（cfg gate）/ `installer_env_no_token_key` / `redact_filters_secret` / `cleanup_args_correct`。
- 验证：`cd apps/desktop/src-tauri && cargo test`。通过标准：新测 + 现有测全绿。

### 3.3 main.rs 注册

- 改 `apps/desktop/src-tauri/src/main.rs`（已读）：
  - `mod` 区（:4-8）追加 `mod cli_installer;`。
  - invoke_handler（:237-258）`generate_handler!` 在 `plugin_script::run_plugin_script`（:257）后追加 `cli_installer::install_cli, cli_installer::install_runtime, cli_installer::cancel_install,`。
- 验证：`cd apps/desktop/src-tauri && cargo test && cargo build`。通过标准：构建成功，命令注册无错。

**阶段 3 Review Gate**：`cargo test` + `cargo build` 全绿（无 warning）+ 手动 `tauriInvoke('install_cli',{target})` 在有/无 winget 环境验证（AC3-AC5）。未过不进阶段 4。

---

## 阶段 4：前端 Tab 化（依赖阶段 1 契约 + 阶段 3 命令）

**目标**：三 Tab 设置页 + CLI 检测安装 + 网关配置端到端可用。

### 4.1 lib 封装

- 新建 `apps/desktop/src/lib/install-cli.ts`：
  - 导出 `INSTALL_DONE_EVENT = 'install-cli://done'`、`AVAILABILITY_EVENT = 'code-assistant://availability-changed'` 常量。
  - `installCli(target)` / `installRuntime(target)` 封装 `tauriInvoke('install_cli'/'install_runtime',{target})`。
  - `cancelInstall(target)` 封装。
- 新建 `apps/desktop/src/lib/cli-types.ts`：
  - `ToolAvailability` / `ProbeResult` / `InstallResult` / `InstallTarget` 类型（镜像 Rust serde 输出，snake_case 字段，注释标注「Rust serde 命名，与 HTTP DTO camelCase 不同」）。
- 验证：`pnpm --filter desktop typecheck`。通过标准：无 TS 报错。

### 4.2 CliRuntimeTab

- 新建 `apps/desktop/src/pages/settings/CliRuntimeTab.tsx`（design §7.2）：
  - props 接收 Settings 顶层的 cliResults/runtimeResults/onProbeAll/onInstall。
  - 5 行渲染（3 CLI + 2 运行时）：名称 / 版本 / binary_path（折叠）/ Badge / 未装时「自动安装」LoadingButton。
  - 安装按钮：弹 Dialog（B17 确认文案）→ onInstall(target) → LoadingButton loading 态 → 监听 AVAILABILITY_EVENT 自动刷新。
  - 顶部「重新检测全部」按钮。
- 验证：`pnpm --filter desktop typecheck`。通过标准：组件编译通过。

### 4.3 ModelGatewayTab

- 新建 `apps/desktop/src/pages/settings/ModelGatewayTab.tsx`（design §7.3）：
  - useEffect 挂载并行拉 `GET /llm/gateways` + `GET /llm/binding`。
  - 网关下拉（Select）+ 绑定展示（apiKeyHint 脱敏）+ 编辑表单（apiKey password input + 模型 checkbox 组 + enabled 开关）+ 保存 `PUT /llm/binding`。
  - 错误按 `LlmErrorCode` 分支（B25，不 message.includes）：gateway_disabled / binding_not_found / llm_key_decrypt_failed。
  - import 契约类型：`import { LlmGatewayPublic, TenantBindingPublic, BindingUpsertInput } from '@lingfang/contract'`。
- 验证：`pnpm --filter desktop typecheck`。通过标准：无 TS 报错。

### 4.4 Settings.tsx Tab 化

- 改 `apps/desktop/src/pages/Settings.tsx`（已读全文）：
  - import Tabs 组件 + CliRuntimeTab + ModelGatewayTab。
  - 顶层 state（design §7.1）：cliResults/runtimeResults/probingRef。
  - probeAll()：并行 list_tools + probe_script_runtime(nodejs/python)，useRef 重入守卫。
  - useEffect 挂载 probeAll + `tauriListen(AVAILABILITY_EVENT, () => probeAll())`。
  - 三 Tab 骨架（design §7.1 JSX），keepMounted。
  - 现有后端地址 Card 逻辑（backendInput/testBackend/saveBackend）零改动搬进 Tab3 TabsContent。
- 验证：`pnpm --filter desktop typecheck && pnpm --filter desktop build`。通过标准：构建成功。
- 手动验证：启动桌面壳，三 Tab 切换正常；Tab1 显示本机已装 CLI/运行时；Tab2 网关下拉有 seed 默认值；Tab3 后端地址保存/测试不回归。

**阶段 4 Review Gate**：`pnpm --filter desktop typecheck && test && build` 全绿 + AC1-AC14 手动通过 + 跨电脑 decrypt 验证（AC13）。

---

## Review Gate（每阶段强制）

| 阶段 | Gate 命令                                                                                                              | 通过标准                                                        | 未过处理   |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------- |
| 1    | `pnpm --filter @lingfang/contract typecheck` + `pnpm --filter @lingfang/collab-api typecheck && test` + migration 生成 | typecheck/test 绿 + credential-cipher 6 测 + migration.sql 正确 | 修到绿进 2 |
| 2    | `pnpm --filter @lingfang/collab-api typecheck && test && build` + seed 6 条 + 手动 curl                                | 全绿 + seed 入库 + AC6-10/13                                    | 修到过进 4 |
| 3    | `cd apps/desktop/src-tauri && cargo test && cargo build`                                                               | 全测绿 + 无 warning + AC3-5 手动                                | 修到过进 4 |
| 4    | `pnpm --filter desktop typecheck && test && build` + AC1-14 手动                                                       | 全绿 + 手动全过                                                 | 修到过收尾 |

最终收尾：全量 `cargo test` + `pnpm --filter desktop typecheck/test/build` + `pnpm --filter @lingfang/collab-api typecheck/test/build` + `pnpm --filter @lingfang/contract typecheck`（AC15）。

---

## 回滚点

- **阶段 1 回滚**：schema 两表 + credential-cipher 是纯增量（新表新文件），回滚 = revert migration + 删 crypto/ 文件，前端/桌面未接无影响。
- **阶段 2 回滚**：LlmService/Controller + admin 路由是新增（collab.module 注册是唯一改动点），回滚 = revert collab.module + 删 llm.* 文件，既有端点不受影响。
- **阶段 3 回滚**：cli_installer 是新模块 + 两处可见性提升（pub(crate) 不破坏现有调用），回滚 = revert main.rs 注册 + 可见性 + 删 cli_installer.rs。
- **阶段 4 回滚**：Tab 化是 Settings 改造 + 2 新 Tab 组件，回滚 = revert Settings.tsx 回单 Card + 删 settings/ 子组件。

每阶段独立 commit，支持按阶段单独回滚。

---

## 产出物清单

### 代码

**新增**（13 文件）：

- `packages/contract/src/llm.ts`（重建，算改动）
- `apps/collab-api/prisma/migrations/20260614*_llm_gateway_catalog/migration.sql`
- `apps/collab-api/src/crypto/credential-cipher.ts` + `.spec.ts`
- `apps/collab-api/src/modules/llm.service.ts` + `.spec.ts`
- `apps/collab-api/src/modules/llm.controller.ts`
- `apps/collab-api/src/modules/dto/llm.dto.ts`
- `apps/desktop/src-tauri/src/cli_installer.rs`
- `apps/desktop/src/lib/install-cli.ts` + `cli-types.ts`
- `apps/desktop/src/pages/settings/CliRuntimeTab.tsx` + `ModelGatewayTab.tsx`

**修改**（11 文件）：

- `apps/collab-api/prisma/schema.prisma`（2 表 2 枚举 + Team/User 关系）
- `apps/collab-api/src/main.ts`（密钥断言）
- `apps/collab-api/.env.example`
- `apps/collab-api/src/modules/dto/enums.ts`
- `apps/collab-api/src/modules/admin.controller.ts` + `admin.service.ts`
- `apps/collab-api/src/modules/collab.module.ts`
- `apps/collab-api/src/seed-admin.ts`（或新 seed-llm-gateways）
- `apps/desktop/src-tauri/src/main.rs`（注册）
- `apps/desktop/src-tauri/src/code_assistant.rs` + `plugin_script.rs`（可见性）
- `apps/desktop/src/pages/Settings.tsx`（Tab 化）

### 测试

- credential-cipher.spec.ts（6 测）
- llm.service.spec.ts（6 测）
- cli_installer.rs #[cfg(test)]（5 测）

### 验证记录

- `.claude/operations-log.md`：每阶段编码前后检查（复用组件 / 命名约定 / 不重复造轮子声明）。
- `.claude/verification-report.md`：四阶段 Gate 输出 + AC1-AC15 结果 + 综合评分。

### PRD AC 映射

| AC                          | 阶段 | 验证                        |
| --------------------------- | ---- | --------------------------- |
| AC1 三 Tab + 后端不回归     | 4    | 手动切换 + 保存/测试连接    |
| AC2 检测已装                | 4    | 手动 list_tools/probe 返回  |
| AC3 自动安装刷新            | 3+4  | 手动 install_cli + 监听事件 |
| AC4 半装清理                | 3    | 手动超时场景 + cleanup 测   |
| AC5 macOS/Linux Unsupported | 3    | cfg gate 测                 |
| AC6 Admin 网关 CRUD         | 2    | 手动 + service 测           |
| AC7 租户保存 + 脱敏         | 2    | 手动 PUT + GET 无明文       |
| AC8 MEMBER 403              | 2    | service 测                  |
| AC9 decrypt 审计            | 2    | service 测 + 手动           |
| AC10 禁用网关只读           | 2    | service 测                  |
| AC11 加密 + fail-fast       | 1    | cipher 测 + 启动断言        |
| AC12 审计无 key             | 2    | service 测（metadata 断言） |
| AC13 跨电脑                 | 2    | 手动 A/B 电脑               |
| AC14 seed 默认              | 2    | seed 后查库                 |
| AC15 全绿                   | 收尾 | 全套 typecheck/test/build   |
