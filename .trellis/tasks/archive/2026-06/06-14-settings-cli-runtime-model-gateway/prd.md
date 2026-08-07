# 设置页 CLI/运行时检测安装与模型网关配置

## Goal（目标）

在桌面端「设置页」加入三个顶部 Tab，承载一套跨端能力：

1. **CLI 与运行时管理**（Tab1）：自动检测 ClaudeCode / Codex / Opencode CLI、Node.js / Python 运行时是否安装；未装时支持 **winget 自动安装**（仅 Windows），并支持半装状态检测与清理。
2. **模型网关配置**（Tab2）：平台 Admin 维护「网关目录」（provider + apiUrl + 模型清单，应用发布时 seed 默认值）；租户在目录里选网关、填自己的 **apiKey（AES-256-GCM 加密存云，方便跨电脑）**、选模型；保存后可解密下发到桌面端供本地 CLI 使用。
3. **后端服务**（Tab3）：现有「后端地址」Card 搬入，零功能改动。

## 背景（为什么改）

- 桌面 Rust 侧**已有**完整的 CLI 探测（`code_assistant::list_tools`/`check_tool`，基于 `find_binary`）和运行时探测（`plugin_script::probe_script_runtime`，识别 Microsoft Store stub），但**前端设置页完全没调用**这些能力——设置页（`apps/desktop/src/pages/Settings.tsx`）当前只有一张「后端地址」Card，用户无法直观看到本机装了哪些 CLI/运行时。
- 后端 collab-api **完全没有** LLM 网关模块：`app.module.ts` 只导入 Auth + Collab；`schema.prisma` 无任何网关/绑定表；`packages/contract/src/llm.ts` 的网关 schema 在 CONTRACT-06 已被删除（注释明确「无 /llm/proxy 路由、无 LlmGateway 表」）。ADR-0002 描述的「网关绑定 + apiKey」在 Rust→NestJS 迁移时被丢弃。本任务是**全新能力**，不是改造。
- `tabs.tsx`（基于 @base-ui/react）已存在，可直接用。
- 后端已有 `class-validator` + 全局 `ValidationPipe`（whitelist+forbidNonWhitelisted+transform）、`AuditLog` 表、`ensurePlatformAdmin`/`ensureTeamAdmin`/`ensureCurrentTeam`、JWT_SECRET fail-fast 启动断言模式——全部可复用。

## Scope（范围）

### R1 后端：模型网关模块（collab-api）

**数据模型**（新增 2 表 + 2 枚举）：

- `LlmGateway`（平台级）：`provider`（String，平台维护的白名单值）/ `name`（唯一展示名）/ `apiUrl`（规范化去尾斜杠）/ `models`（Json string[]）/ `description` / `sortOrder` / `status`（ENABLED|DISABLED）。
- `TenantLlmBinding`（租户级）：`teamId` / `gatewayId` / `provider`（冗余）/ `encryptedApiKey`（AES-256-GCM 密文）/ `apiKeyHint`（脱敏串）/ `keyFingerprint`（sha256 前16位）/ `enabled` / `modelOverride`（Json?）/ `createdById` / `updatedById`，唯一约束 `(teamId, gatewayId)`。
- `Team`/`User` 加反向关系。

**加密**（新 `crypto/credential-cipher.ts`）：

- Node `crypto` AES-256-GCM，密钥从 env `LLM_KEY_ENCRYPTION_KEY`（64 位 hex → 32 字节）读取。
- 密文打包为单字符串 `base64(iv(12B) || tag(16B) || ciphertext)`，每次新 IV。
- `encryptApiKey`/`decryptApiKey`/`maskApiKey`/`fingerprintApiKey`/`requireKeyEncryptionKey`，全单测覆盖（往返/篡改 tag/iv 各自抛错/IV 随机性/脱敏边界）。
- `main.ts` 复刻 JWT_SECRET 的 fail-fast 断言：生产缺密钥 throw，dev warn 但**不生成兜底密钥**（首次加解密 throw `llm_key_not_configured`）。

**端点**（全局 JwtAuthGuard 下，前缀 `/api`）：

- 平台 Admin（`AdminController` + `ensurePlatformAdmin`）：
  - `GET /api/admin/llm-gateways`（含 DISABLED + 全字段）
  - `POST /api/admin/llm-gateways`（`GatewayCreateDto`）
  - `PATCH /api/admin/llm-gateways/:id`（全可选 `GatewayUpdateDto`）
  - `PATCH /api/admin/llm-gateways/:id/status`（软删除，**无物理 DELETE**——防误删清空全部租户 key）
- 租户级（新 `LlmController @Controller('llm')`）：
  - `GET /api/llm/gateways`（仅 ENABLED，无任何 key）
  - `GET /api/llm/binding`（`ensureCurrentTeam`，apiKey 脱敏，零解密）
  - `PUT /api/llm/binding`（`ensureTeamAdmin`，写库即加密 + `$transaction` + 审计）
  - `DELETE /api/llm/binding/:gatewayId`（`ensureTeamAdmin`）
  - `POST /api/llm/binding/:gatewayId/decrypt`（`ensureTeamAdmin`，返回明文供桌面 CLI 使用；**强审计**；明文不进日志/审计 metadata/command_preview）

**审计**：复用 `AuditLog`，action 用自由 String（`admin.llm_gateway.*` / `llm_binding.*`），metadata 永远只 `{teamId, gatewayId, provider, kind, ...}`，**绝不记 apiKey 明文/密文/脱敏串/hint**。

**seed**：应用发布时 seed 一批默认网关（openai/anthropic/deepseek/moonshot/qwen/azure），方便开箱即用。provider 白名单 = 这批 seed 的 provider 集合。

### R2 桌面端：CLI/运行时检测 + winget 自动安装（Tauri）

**复用现有**（前端 `tauriInvoke` 调用，不重写探测）：

- `code_assistant_list_tools()` → `Vec<ToolAvailability>`（含 version/binary_path/models/default_model）
- `code_assistant_check_tool({tool})` → `ToolAvailability`
- `probe_script_runtime({runtime})` → `Result<ProbeResult, String>`

**新增命令**（新 `cli_installer.rs`）：

- `install_cli({target: 'claude'|'codex'|'opencode'})` → `Result<InstallResult, String>`，走 `Command::new("winget")` + `env_clear()` + 最小白名单 env（裁掉宿主 token/key），300s 硬超时。
- `install_runtime({target: 'nodejs'|'python'})` → 同上。
- `cancel_install({target})` → 杀进程组。
- 安装成功后 emit `code-assistant://availability-changed`（payload = 全量 `Vec<ToolAvailability>`，与 main.rs:232 首启 emit 同形态）。

**winget 包 id**（已核实，microsoft/winget-pkgs 官方 manifest）：

- claude → `Anthropic.ClaudeCode`（独立二进制，非 npm）
- codex → `OpenAI.Codex`（Rust 二进制）
- opencode → `SST.opencode`（注意 publisher 是 SST）
- nodejs → `OpenJS.NodeJS.LTS`（**注意不是 `OpenJS.Technology.NodeJS`**）
- python → `Python.Python.3.12`

**半装处理**：超时/失败后检测残留（winget 包残留文件/`winget list` 查 id），尝试 `winget uninstall <id>` 清理，再提示重试。

**可见性提升**（最小改动）：`code_assistant.rs` 的 `kill_child_tree`、`plugin_script.rs` 的 `minimal_env` 提升为 `pub(crate)` 供 cli_installer 复用。

**平台范围**：首版仅 Windows。macOS/Linux 返回 `InstallResult{status:'Unsupported', message:'请手动安装...'}`。

### R3 前端：设置页 Tab 化（apps/desktop/src）

**Settings.tsx 改造**为三 Tab 骨架（`<Tabs defaultValue="cli">` + 3 个 `TabsTrigger` + 3 个 `keepMounted` 的 `TabsContent`）：

- Tab1 `cli`：CLI 与运行时管理（新 `settings/CliRuntimeTab.tsx`）
- Tab2 `gateway`：模型网关（新 `settings/ModelGatewayTab.tsx`）
- Tab3 `backend`：现有后端地址 Card（零改动搬入）
- 顶层 state（cliResults/runtimeResults/binding/gateways）+ `tauriListen('code-assistant://availability-changed')` + `useRef` 重入守卫。

**Tab1 CliRuntimeTab**：5 行（3 CLI + 2 运行时），每行：名称 / 版本 / 状态 Badge（已装/未装/检测中）/ 未装时「自动安装」LoadingButton + 确认 Dialog（「将执行 winget install，可能需管理员权限」）/ 顶部「重新检测全部」按钮。调用 `tauriInvoke('code_assistant_list_tools')` + `tauriInvoke('probe_script_runtime',{runtime})` + `tauriInvoke('install_cli'/'install_runtime',{target})`。

**Tab2 ModelGatewayTab**：`GET /api/llm/gateways` 拉网关目录（下拉选）+ `GET /api/llm/binding` 显示当前绑定（apiKey 脱敏）+ 编辑表单（选网关 + 填 apiKey + 选模型）+ `PUT /api/llm/binding` 保存。apiKey 按 ErrorCode 分支错误处理（不 `message.includes`）。

### R4 契约包单一真源（packages/contract）

重建 `src/llm.ts` zod schema：`LlmGatewayPublicSchema` / `TenantBindingPublicSchema` / `BindingUpsertInputSchema` / `GatewayCreateInputSchema` / `GatewayUpdateInputSchema` + 新增 ErrorCode（`gateway_disabled`/`binding_not_found`/`llm_key_decrypt_failed`/`llm_key_not_configured`/`install_unsupported`/`install_failed`）。前后端一律 `import { ... } from '@lingfang/contract'`。

## Constraints（约束）

- **简体中文**（注释/commit/UI 文案/文档）。文件操作用专用工具（Read/Edit/Write/Glob/Grep），禁 Shell 直接操作。前端 pnpm，Python 脚本用 **py launcher**（不是 `python`）。
- **复用优先**：后端探测能力已在桌面 Rust 实现，前端只 `tauriInvoke`；后端复用 `class-validator`/`AuditLog`/`ensureXxx`/`ValidationPipe`/JWT_SECRET fail-fast 模式；前端复用 `tabs.tsx`/`ui/*`/`api.ts`/`tauriInvoke`。
- **破坏式不向后兼容**：后端无旧 LLM 表，直接新建；contract 重建 schema 不保留旧空壳。
- **apiKey 加密存储**（用户凭据保护，非平台安全控制）：AES-256-GCM 落库，密钥从 env 读不入库不入 git，明文永不在日志/审计/command_preview。
- **解密下发权衡**（用户决策：跨电脑方便）：新增 `POST /api/llm/binding/:gatewayId/decrypt`，仅 `ensureTeamAdmin` + 强审计，明文经 HTTPS 返回给已认证桌面客户端供 CLI 使用。库泄漏 ≠ key 泄漏（库是密文）。
- **仅 Windows 安装**：cli_installer 首版只 winget，macOS/Linux 返回 Unsupported + 提示。
- **半装检测+清理**：超时/失败后检测残留并尝试 `winget uninstall` 清理。
- UTF-8 无 BOM 编码。

## Acceptance Criteria

- [ ] AC1 设置页三 Tab 切换正常，Tab3 后端地址 Card 功能不回归（保存/测试连接/重新登录）。
- [ ] AC2 Tab1 检测出本机已装的 CLI（claude/codex/opencode）与运行时（node/python），显示版本 + 路径 + 已装 Badge。
- [ ] AC3 Tab1 未装的 CLI/运行时点「自动安装」→ 弹确认 Dialog → 执行 winget → 装完自动刷新探测（监听 `code-assistant://availability-changed`），状态变已装。
- [ ] AC4 Tab1 安装超时/失败时检测半装残留并尝试 `winget uninstall` 清理，给用户「请重试」提示。
- [ ] AC5 macOS/Linux 点安装返回 Unsupported + 手动安装提示（不崩）。
- [ ] AC6 Tab2 平台 Admin 能在后台增删改网关目录（含软删除 DISABLED，无物理 DELETE）。
- [ ] AC7 Tab2 租户选网关 + 填 apiKey + 选模型 → 保存成功；GET 返回 apiKey 脱敏（`sk-1***wxyz`），明文永不返回。
- [ ] AC8 Tab2 普通 MEMBER 不能 PUT/DELETE 绑定（403），只有 TEAM_ADMIN 能改。
- [ ] AC9 Tab2 `POST /api/llm/binding/:gatewayId/decrypt` 仅 TEAM_ADMIN 可调，返回明文，每次调用写审计（含谁/何时/哪个网关，不含 key）。
- [ ] AC10 禁用网关（status=DISABLED）后，租户绑定变只读，decrypt/使用返回 `gateway_disabled` 错误码。
- [ ] AC11 库里 `encryptedApiKey` 是密文；篡改 tag/iv 解密失败抛 `llm_key_decrypt_failed`；密钥缺失启动 fail-fast（生产 throw / dev warn）。
- [ ] AC12 审计 metadata 永不含 apiKey 明文/密文/脱敏串/hint（单测断言）。
- [ ] AC13 跨电脑：A 电脑保存绑定 → B 电脑登录同租户 → GET 能看到绑定（脱敏）→ decrypt 能拿到明文供 CLI。
- [ ] AC14 应用发布 seed 默认网关（openai/anthropic/deepseek/moonshot/qwen/azure），开箱即在 Tab2 下拉可选。
- [ ] AC15 本地验证全绿：`cd apps/desktop/src-tauri && cargo test` + `pnpm --filter desktop typecheck/test/build` + `pnpm --filter @lingfang/collab-api test/typecheck` + `pnpm --filter @lingfang/contract typecheck`。

## 分阶段（渐进式）

- **阶段1 契约 + 后端基础**：contract zod schema → prisma 2 表 + migration → credential-cipher + 单测 → main.ts 密钥断言 + .env.example → DTO + enums。
- **阶段2 后端端点**：llm.service（$transaction + 审计 + ensureXxx）+ 单测 → llm.controller + admin 路由 + collab.module 注册 → seed 默认网关。
- **阶段3 桌面 Tauri**：可见性提升 → cli_installer.rs（winget + 半装清理 + 平台策略表 + 本地 history）→ main.rs 注册命令 + emit 事件。
- **阶段4 前端 Tab 化**：lib/install-cli.ts + lib/llm 配置 → CliRuntimeTab + ModelGatewayTab → Settings.tsx Tab 化 + listener → 联调。

依赖：阶段1 → {阶段2, 阶段3 可并行} → 阶段4。

## Notes

- 多视角设计 + 12 路对抗评审 + 综合的完整方案见 Workflow 输出（`wejzp1c32`），关键裁决 26 条（B1-B26）记录在 design.md §1。
- 用户 4 个决策已固化：① apiKey 云端加密存储跨电脑（推翻 keychain 方案，新增 decrypt 端点）② provider 平台管理 + seed 默认值 ③ 仅 Windows 安装 ④ 半装检测+清理。
- winget 包 id 全部经 microsoft/winget-pkgs 官方 manifest 核实（见 design.md §4.4）。
- design.md 写技术设计（数据模型/加密/端点/Tauri 命令/Tab 布局/裁决），implement.md 写四阶段有序 checklist。
