# 技术设计：设置页 CLI/运行时检测安装与模型网关配置

> 配套 `prd.md`。本文件是工程实现的技术契约：精确到 file:line 的现状引用、数据模型、加密方案、端点契约、Tauri 命令、Tab 布局、26 条裁决。行号基于 main 分支当前实现（核对 2026-06-14）。

## 1. 26 条裁决（对抗评审综合，精简版）

用户 4 个决策对综合方案的调整（**已采纳，覆盖原 B1/B3**）：
- **D1（用户）apiKey 云端加密存储、跨电脑**：推翻原 B1 的 keychain 方案。后端 AES-256-GCM 密文存库为**唯一真源**；新增 `POST /api/llm/binding/:gatewayId/decrypt` 端点（ensureTeamAdmin + 强审计）按需解密下发明文。**砍掉** `keyring` crate 和 `llm_keychain.rs`。
- **D2（用户）provider 平台管理 + seed 默认值**：provider 不写死 enum，`LlmGateway.provider` 为 String；应用 seed 一批默认网关。
- **D3（用户）仅 Windows 安装**：cli_installer 只 winget；macOS/Linux 返回 `Unsupported`。
- **D4（用户）半装检测+清理**：超时/失败后检测残留并 `winget uninstall` 清理。

其余裁决（B2-B26 精简）：
- **B2 契约单一真源**：`packages/contract/src/llm.ts` 重建 zod schema，前后端共用，ErrorCode 新增 6 个。
- **B3 事件名**：`code-assistant://availability-changed`（与 main.rs:232 一致）+ install 用 `install-cli://done`。
- **B4 可见性**：`kill_child_tree`/`minimal_env` 提升 `pub(crate)`；不复用 `redact_arg`（范畴错），cli_installer 新写 `redact_log_line`。
- **B5 apiKey 可选语义**：`undefined` 保留原密（仅改 config），非空重新加密+轮换 hint；`undefined` 且无 binding 返 `binding_not_found`。
- **B7 流式安装**：首版非流式（run_capture 一次性）+ 单次 done 事件 + 300s 硬超时。
- **B8 软删除**：网关目录无物理 DELETE，仅 `PATCH status=DISABLED`；binding 上 `onDelete: Restrict`。
- **B9 审计原子性**：PUT/DELETE/decrypt binding 用 `prisma.$transaction`（binding 操作 + auditLog.create 同事务）。
- **B10 createdById/updatedById**：binding 加两字段，FK User，onDelete: SetNull。
- **B11 camelCase**：所有 `/api/llm/*` 字段 camelCase。
- **B12 零解密列表**：`apiKeyHint`/`keyFingerprint` 写入时持久化，GET 列表只读不调 decrypt。
- **B13 Tab keepMounted**：base-ui 真实属性 `keepMounted`；探测/binding state 上提 Settings 顶层。
- **B16 入参白名单**：前端 + Rust 双枚举校验 install target。
- **B17 二次确认**：前端 Dialog 确认（Rust 不内置）。
- **B21 UAC 判定**：仅退出码（0x80070005 ACCESSDENIED → NeedsConfirmation），其余非0 → Failed。
- **B22 npm fallback**：固定官方 scope + `--ignore-scripts`（winget 失败时兜底）。
- **B23 effectiveModels**：`effectiveModels = modelOverride ?? gateway.models`。
- **B24 无测试连接端点**：本期不提供（与「解密仅供 CLI」语义一致）。

## 2. 数据模型（Prisma，新增）

```prisma
// apps/collab-api/prisma/schema.prisma 追加

enum LlmGatewayStatus {
  ENABLED
  DISABLED
}

model LlmGateway {
  id          String           @id @default(uuid())
  provider    String                            // openai|anthropic|azure|deepseek|moonshot|qwen|custom（String，非 enum，平台维护）
  name        String           @unique          // 展示名，如「OpenAI 官方」
  apiUrl      String                            // 规范化：去尾斜杠、http/https
  status      LlmGatewayStatus @default(ENABLED)
  models      Json             @default("[]")   // string[]，如 ["gpt-4o",...]
  description String           @default("")
  sortOrder   Int              @default(0)      // 小在前
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt
  bindings    TenantLlmBinding[]

  @@index([status, sortOrder])
}

model TenantLlmBinding {
  id              String     @id @default(uuid())
  teamId          String
  gatewayId       String
  provider        String                       // 冗余，与 gateway.provider 一致
  encryptedApiKey String                       // base64(iv(12B) || tag(16B) || ciphertext)
  apiKeyHint      String     @default("")      // 明文存非敏感脱敏串（PUT 时计算落库）
  keyFingerprint  String     @default("")      // sha256(plaintext).slice(0,16)
  enabled         Boolean    @default(true)
  modelOverride   Json?                        // null=继承 gateway.models；string[]=子集
  createdById     String?                       // FK User
  updatedById     String?                       // FK User
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  team       Team       @relation(fields: [teamId], references: [id], onDelete: Cascade)
  gateway    LlmGateway @relation(fields: [gatewayId], references: [id], onDelete: Restrict)
  createdBy  User?      @relation("BindingCreator", fields: [createdById], references: [id], onDelete: SetNull)
  updatedBy  User?      @relation("BindingUpdater", fields: [updatedById], references: [id], onDelete: SetNull)

  @@unique([teamId, gatewayId])
  @@index([teamId, enabled])
}

// model Team 追加：bindings TenantLlmBinding[]
// model User 追加：
//   createdLlmBindings TenantLlmBinding[] @relation("BindingCreator")
//   updatedLlmBindings TenantLlmBinding[] @relation("BindingUpdater")
```

**迁移**：`apps/collab-api/prisma/migrations/20260614130000_llm_gateway_catalog/migration.sql`（命名对齐现有 `20260614000001_user_token_version` 时间戳风格）。执行：`cd apps/collab-api && py -3 ../node_modules/prisma/build/index.js migrate dev` 或通过 `pnpm --filter @lingfang/collab-api prisma:migrate`。

## 3. 加密方案（新 `crypto/credential-cipher.ts`）

**位置**：`apps/collab-api/src/crypto/credential-cipher.ts`（与 `security.ts` 并列的纯工具模块）。

```ts
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const IV_LEN = 12;   // GCM 推荐 12 字节
const TAG_LEN = 16;
const KEY_LEN = 32;  // AES-256

/** 启动期 fail-fast 解析密钥；缺失/格式错返回 null（由 main.ts 决定 throw/warn）。 */
export function requireKeyEncryptionKey(): Buffer | null {
  const raw = process.env.LLM_KEY_ENCRYPTION_KEY;
  if (!raw) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null; // 必须 64 位 hex
  return Buffer.from(raw, 'hex');                  // → 32 字节
}

/** 加密：返回 base64(iv || tag || ciphertext)，每次新 IV。 */
export function encryptApiKey(plain: string, key: Buffer): string;

/** 解密：校验 tag，失败抛 AppError(500,'llm_key_decrypt_failed')。 */
export function decryptApiKey(packed: string, key: Buffer): string;

/** 脱敏：len>=12 → 前3***后4；len>=6 → ***后2；否则 ***。单测断言永不露连续≥6 明文。 */
export function maskApiKey(plain: string): string;

/** 指纹：sha256(plain).slice(0,16)，稳定标识「这是哪个 key」。 */
export function fingerprintApiKey(plain: string): string;
```

**main.ts 断言**（复刻 JWT_SECRET 模式，main.ts:24-29）：
```ts
const llmKey = requireKeyEncryptionKey();
if (!llmKey) {
  if (process.env.NODE_ENV === 'production') throw new Error('启动失败：必须设置 LLM_KEY_ENCRYPTION_KEY（64 位 hex，openssl rand -hex 32 生成）');
  console.warn('[安全警告] LLM_KEY_ENCRYPTION_KEY 未设置，开发环境继续，生产将拒绝启动。');
}
```
密钥在 `main.ts` bootstrap 内解析后注入 `LlmService`（通过 Nest DI provider 或 module token），不重复解析。

**`.env.example` 追加**（apps/collab-api/.env.example:9 后）：
```
# apiKey 加密密钥（64 位 hex，openssl rand -hex 32 生成；生产必设，不入 git）
LLM_KEY_ENCRYPTION_KEY=""
```

## 4. 端点契约（前缀 /api，全局 JwtAuthGuard）

### 4.1 平台 Admin 网关目录（挂 AdminController，ensurePlatformAdmin）

| 方法 | 路径 | 入参 DTO | 出参 |
|---|---|---|---|
| GET | `/api/admin/llm-gateways` | — | `{ gateways: LlmGateway[] }`（含 DISABLED + 全字段） |
| POST | `/api/admin/llm-gateways` | `GatewayCreateDto{provider,name,apiUrl,models?,description?,sortOrder?,status?}` | `{ gateway }` |
| PATCH | `/api/admin/llm-gateways/:id` | `GatewayUpdateDto`（全可选） | `{ gateway }` |
| PATCH | `/api/admin/llm-gateways/:id/status` | `{status:'ENABLED'\|'DISABLED'}` | `{ gateway }`（软删除） |

**无 DELETE 端点**（B8）。binding 上 `onDelete: Restrict`，禁用网关不删绑定。

### 4.2 租户级（新 LlmController @Controller('llm')）

| 方法 | 路径 | 鉴权 | 入参 | 出参 |
|---|---|---|---|---|
| GET | `/api/llm/gateways` | ensureCurrentTeam | — | `{ gateways: [{id,provider,name,apiUrl,models,description,sortOrder}] }`（仅 ENABLED） |
| GET | `/api/llm/binding` | ensureCurrentTeam | — | `{ bindings: TenantBindingPublic[] }`（脱敏，零解密） |
| PUT | `/api/llm/binding` | ensureTeamAdmin | `BindingUpsertDto{gatewayId,apiKey?,enabled?,modelOverride?}` | `{ binding }`（$transaction+audit） |
| DELETE | `/api/llm/binding/:gatewayId` | ensureTeamAdmin | — | `{ ok:true }`（$transaction+audit） |
| POST | `/api/llm/binding/:gatewayId/decrypt` | ensureTeamAdmin | — | `{ apiKey: string }`（$transaction+audit，强审计） |

**TenantBindingPublic**（GET 出参单条）：`{id, gatewayId, provider, gatewayName, apiUrl, gatewayStatus, enabled, apiKeyHint, keyFingerprint, gatewayModels: string[], modelOverride: string[]|null, effectiveModels: string[], updatedBy?:{id,displayName}, updatedAt}`。

### 4.3 service 鉴权（auth.service.ts 已有签名）

- `adminCreateGateway(actorId, dto)`：首行 `await this.auth.ensurePlatformAdmin(actorId)`（auth.service.ts:146）。
- `upsertBinding(actorId, dto)`：首行 `const m = await this.auth.ensureTeamAdmin(actorId); const teamId = m.team.id;`（auth.service.ts:140 返回 membership），再校验 `gateway.status==='ENABLED'`（DISABLED 抛 `gateway_disabled`）。
- `decryptBindingKey(actorId, gatewayId)`：同 ensureTeamAdmin + 校验 binding 存在 + 校验 gateway.status==='ENABLED' + `$transaction` 写审计 + 返回明文。

### 4.4 审计动作（复用 AuditLog，action 自由 String）

- `admin.llm_gateway.created` / `.updated` / `.disabled`，targetType=`LlmGateway`
- `llm_binding.upserted`（metadata.kind=`create`|`key_rotated`|`config_only`）/ `.deleted`，targetType=`TenantLlmBinding`
- `llm_binding.key_decrypted`（解密专用审计），targetType=`TenantLlmBinding`
- **metadata 永远只 `{teamId, gatewayId, provider, kind?, enabled?}`**，绝不记 apiKey 明文/密文/hint/fingerprint。单测断言（AC12）。

## 5. DTO（class-validator，对齐现有 dto/ 模式）

`apps/collab-api/src/modules/dto/llm.dto.ts`：

```ts
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class GatewayCreateDto {
  @IsString() @MinLength(1) provider: string;
  @IsString() @MinLength(1) name: string;
  @IsString() @MinLength(1) apiUrl: string;           // 服务端规范化去尾斜杠
  @IsOptional() @IsArray() @IsString({ each: true }) models?: string[];
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsEnum(['ENABLED', 'DISABLED']) status?: 'ENABLED' | 'DISABLED';
}
export class GatewayUpdateDto { /* 全可选，同上字段 */ }
export class BindingUpsertDto {
  @IsString() gatewayId: string;
  @IsOptional() @IsString() @MinLength(1) apiKey?: string;  // undefined=保留原密
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) modelOverride?: string[] | null;
}
export class GatewayStatusDto {
  @IsEnum(['ENABLED', 'DISABLED']) status: 'ENABLED' | 'DISABLED';
}
```

`apps/collab-api/src/modules/dto/enums.ts` 追加：`export const LLM_PROVIDER = ['openai','anthropic','azure','deepseek','moonshot','qwen','custom'] as const;`、`export const LLM_GATEWAY_STATUS = ['ENABLED','DISABLED'] as const;`。

## 6. Tauri 命令（新 `cli_installer.rs`）

### 6.1 复用现有（不改签名）

- `code_assistant_list_tools()` → `Vec<ToolAvailability>`（main.rs:68 wrapper）
- `code_assistant_check_tool({tool})` → `ToolAvailability`（main.rs:73）
- `probe_script_runtime({runtime})` → `Result<ProbeResult, String>`（plugin_script.rs:127，**有 Result，前端 try/catch**）

### 6.2 新增命令

| 命令 | 入参 | 出参 |
|---|---|---|
| `install_cli` | `{target:'claude'\|'codex'\|'opencode'}` | `Result<InstallResult, String>` |
| `install_runtime` | `{target:'nodejs'\|'python'}` | `Result<InstallResult, String>` |
| `cancel_install` | `{target: InstallTarget}` | `Result<(), String>` |

```rust
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallTarget { Claude, Codex, Opencode, Nodejs, Python }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct InstallResult {
    pub status: InstallStatus,  // Succeeded|NeedsConfirmation|Failed|Unsupported
    pub exit_code: Option<i32>,
    pub elapsed_ms: u64,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub message: String,
}
```

### 6.3 安装流程（Windows winget）

```
install_cli/install_runtime(target):
  1. 平台判定：非 Windows → return InstallResult{Unsupported, "请手动安装..."}
  2. 查包 id（§6.4 平台策略表）→ None → return Failed("暂不支持的包")
  3. spawn: Command::new("winget")
       .args(["install","--id",<id>,"-e","--accept-source-agreements","--accept-package-agreements","--silent"])
       .env_clear().envs(installer_env())          // 裁掉宿主 token/key
       .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
  4. run_capture_with_env(binary, args, None, 300_000, env)  // 300s 硬超时
  5. 判定：
       exit 0 + 探测到 binary → Succeeded + 装后 check_tool 取 version
       exit 0x80070005 / stderr 含 "elevation"/"administrator" → NeedsConfirmation
       超时 → 走 §6.5 半装清理 → Failed("安装超时，已清理残留，请重试")
       其余非 0 → 走 §6.5 半装清理 → Failed(stderr_tail 经 redact)
  6. Succeeded 时 emit code-assistant://availability-changed（全量 Vec<ToolAvailability>）
  7. 写本地 install-history.jsonl
```

### 6.4 平台策略表（winget id 已核实）

```rust
fn winget_package_id(target: InstallTarget) -> Option<&'static str> {
    match target {
        InstallTarget::Claude  => Some("Anthropic.ClaudeCode"),
        InstallTarget::Codex   => Some("OpenAI.Codex"),
        InstallTarget::Opencode=> Some("SST.opencode"),
        InstallTarget::Nodejs  => Some("OpenJS.NodeJS.LTS"),   // 不是 OpenJS.Technology.NodeJS
        InstallTarget::Python  => Some("Python.Python.3.12"),
    }
}
```

**npm fallback**（winget 失败时，B22）：固定官方 scope + `--ignore-scripts`：`@anthropic-ai/claude-code` / `@openai/codex` / `opencode-ai`。node/python 无 npm fallback。npm fallback 标注「供应链风险」提示。

### 6.5 半装检测+清理（D4）

```rust
fn cleanup_partial_install(target: InstallTarget) {
    // winget list 查包是否残留 → 若在则 winget uninstall --id <id> --silent
    let id = winget_package_id(target)?;
    let check = run_capture_with_env("winget", vec!["list","--id",id], None, 30_000, installer_env());
    if 包存在 {
        let _ = run_capture_with_env("winget", vec!["uninstall","--id",id,"--silent"], None, 60_000, installer_env());
    }
}
```

超时分支、Failed 分支均调 `cleanup_partial_install`。

### 6.6 installer_env（新写，不复用 minimal_env 的实例但复用其 pub(crate) 定义）

```rust
fn installer_env() -> Vec<(OsString, OsString)> {
    // 复用 plugin_script::minimal_env 的 keys 白名单思路，但独立构造实例。
    // 保留 PATH/SystemRoot/TEMP/USERPROFILE（winget/npm 需要），裁掉 LINGFANG_*/TOKEN/KEY/SECRET。
    let keys = ["PATH","SystemRoot","TEMP","TMP","USERPROFILE","APPDATA","LOCALAPPDATA","PATHEXT"];
    keys.iter().filter_map(|k| std::env::var_os(k).map(|v| (OsString::from(k), v))).collect()
}
```

### 6.7 redact_log_line（新写，B4 不复用 redact_arg）

```rust
/// 过滤安装输出中的敏感行（Bearer token / sk- 开头 key / env 赋值 / URL user:pass）。
fn redact_log_line(line: &str) -> String { /* regex 或子串匹配 → [redacted] */ }
```

### 6.8 main.rs 注册（invoke_handler 追加）

```rust
// main.rs mod 区：mod cli_installer;
// invoke_handler generate_handler! 追加：
plugin_script::probe_script_runtime,
plugin_script::run_plugin_script,
cli_installer::install_cli,
cli_installer::install_runtime,
cli_installer::cancel_install,
```

### 6.9 可见性提升（最小改动）

- `code_assistant.rs:1293` `fn kill_child_tree` → `pub(crate) fn kill_child_tree`（供 cancel_install 杀进程组）。
- `plugin_script.rs:187` `fn minimal_env` → `pub(crate) fn minimal_env`（供 installer_env 参考复用 keys 白名单）。

## 7. 前端 Tab 布局

### 7.1 Settings.tsx Tab 化

```tsx
// apps/desktop/src/pages/Settings.tsx 改造
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { CliRuntimeTab } from './settings/CliRuntimeTab';
import { ModelGatewayTab } from './settings/ModelGatewayTab';

export function Settings() {
  // 顶层 state（B13）：不进 useApp，探测结果缓存避免每次切 Tab 重探
  const [cliResults, setCliResults] = useState<ToolAvailability[] | null>(null);
  const [runtimeResults, setRuntimeResults] = useState<Record<'nodejs'|'python', ProbeResult|null>|null>(null);
  const probingRef = useRef(false);  // B26 重入守卫

  // 监听安装完成事件 → 自动重探
  useEffect(() => tauriListen('code-assistant://availability-changed', () => { probeAll(); }), []);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Tabs defaultValue="cli">
        <TabsList>
          <TabsTrigger value="cli">CLI 与运行时</TabsTrigger>
          <TabsTrigger value="gateway">模型网关</TabsTrigger>
          <TabsTrigger value="backend">后端服务</TabsTrigger>
        </TabsList>
        <TabsContent value="cli" keepMounted><CliRuntimeTab ... /></TabsContent>
        <TabsContent value="gateway" keepMounted><ModelGatewayTab /></TabsContent>
        <TabsContent value="backend" keepMounted>{/* 现有后端地址 Card 零改动搬入 */}</TabsContent>
      </Tabs>
    </div>
  );
}
```

### 7.2 CliRuntimeTab（新 `pages/settings/CliRuntimeTab.tsx`）

5 行：3 CLI（list_tools 取 claude/codex/opencode）+ 2 运行时（probe_script_runtime nodejs/python）。每行：
- 名称（Claude Code / Codex / opencode / Node.js / Python）
- 版本（`version` 字段）+ 路径（`binary_path`，可折叠）
- 状态 Badge（已装=green / 未装=muted / 检测中=spinner）
- 未装时「自动安装」LoadingButton → 弹确认 Dialog（B17）→ `tauriInvoke('install_cli'/'install_runtime',{target})` → LoadingButton loading → done 事件自动刷新
- 顶部「重新检测全部」按钮（调 probeAll）

### 7.3 ModelGatewayTab（新 `pages/settings/ModelGatewayTab.tsx`）

- `useEffect` 挂载：`api<...>('/llm/gateways')` + `api<...>('/llm/binding')` 并行拉取
- 网关下拉（Select）：`gateways.map(g => <option value={g.id}>{g.name}（{g.provider}）</option>)`
- 当前绑定展示：`binding.apiKeyHint`（脱敏）+ `effectiveModels`
- 编辑表单：选网关 + 填 apiKey（password input）+ 选模型（checkbox 组，来自 gateway.models）+ enabled 开关
- 保存 `api('/llm/binding',{method:'PUT',body:{gatewayId,apiKey,enabled,modelOverride}})`
- 错误按 ErrorCode 分支（B25）：`gateway_disabled`→提示切换网关 / `binding_not_found`→引导填表

### 7.4 lib 封装（新）

- `apps/desktop/src/lib/install-cli.ts`：`tauriInvoke('install_cli'/'install_runtime',{target})` + `INSTALL_DONE_EVENT = 'install-cli://done'` + `AVAILABILITY_EVENT = 'code-assistant://availability-changed'` 常量
- `apps/desktop/src/lib/cli-types.ts`：`ToolAvailability`/`ProbeResult`/`InstallResult` 类型（镜像 Rust serde，snake_case，注明与 HTTP DTO 命名不同）

## 8. 契约包（packages/contract）

`packages/contract/src/llm.ts` 重建：

```ts
import { z } from 'zod';

export const LlmGatewayPublicSchema = z.object({
  id: z.string(), provider: z.string(), name: z.string(), apiUrl: z.string(),
  models: z.array(z.string()).default([]), description: z.string().default(''),
  sortOrder: z.number().default(0),
});
export type LlmGatewayPublic = z.infer<typeof LlmGatewayPublicSchema>;

export const TenantBindingPublicSchema = z.object({
  id: z.string(), gatewayId: z.string(), provider: z.string(), gatewayName: z.string(),
  apiUrl: z.string(), gatewayStatus: z.enum(['ENABLED','DISABLED']), enabled: z.boolean(),
  apiKeyHint: z.string(), keyFingerprint: z.string(),
  gatewayModels: z.array(z.string()), modelOverride: z.array(z.string()).nullable(),
  effectiveModels: z.array(z.string()),
  updatedBy: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  updatedAt: z.string(),
});
export type TenantBindingPublic = z.infer<typeof TenantBindingPublicSchema>;

export const BindingUpsertInputSchema = z.object({
  gatewayId: z.string(), apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(), modelOverride: z.array(z.string()).nullable().optional(),
});
export type BindingUpsertInput = z.infer<typeof BindingUpsertInputSchema>;

export const GatewayCreateInputSchema = z.object({
  provider: z.string().min(1), name: z.string().min(1), apiUrl: z.string().min(1),
  models: z.array(z.string()).optional(), description: z.string().optional(),
  sortOrder: z.number().min(0).optional(), status: z.enum(['ENABLED','DISABLED']).optional(),
});
export type GatewayCreateInput = z.infer<typeof GatewayCreateInputSchema>;

export const GatewayUpdateInputSchema = GatewayCreateInputSchema.partial();
export type GatewayUpdateInput = z.infer<typeof GatewayUpdateInputSchema>;

// ErrorCode 追加（保留现有 ErrorCode，extend）
export const LlmErrorCode = z.enum([
  'gateway_disabled','binding_not_found','llm_key_decrypt_failed',
  'llm_key_not_configured','install_unsupported','install_failed',
]);
```

## 9. seed 默认网关（D2）

`apps/collab-api/src/seed-admin.ts` 追加（或新 `seed-llm-gateways.ts` 由 `db:setup` 调用）：

```ts
const DEFAULT_GATEWAYS = [
  { provider:'openai',    name:'OpenAI 官方',    apiUrl:'https://api.openai.com/v1',      models:['gpt-4o','gpt-4o-mini'], sortOrder:1 },
  { provider:'anthropic', name:'Anthropic 官方', apiUrl:'https://api.anthropic.com',       models:['claude-sonnet-4-6','claude-opus-4-8'], sortOrder:2 },
  { provider:'deepseek',  name:'DeepSeek',       apiUrl:'https://api.deepseek.com',         models:['deepseek-chat','deepseek-reasoner'], sortOrder:3 },
  { provider:'moonshot',  name:'月之暗面 Kimi',   apiUrl:'https://api.moonshot.cn/v1',      models:['moonshot-v1-8k','moonshot-v1-32k'], sortOrder:4 },
  { provider:'qwen',      name:'通义千问',        apiUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1', models:['qwen-max','qwen-plus'], sortOrder:5 },
  { provider:'azure',     name:'Azure OpenAI',   apiUrl:'https://<your-resource>.openai.azure.com', models:['gpt-4o','gpt-4o-mini'], sortOrder:6 },
];
// upsert by name（幂等，重复 seed 不报错）
```

## 10. 验证策略

### 10.1 后端单测（vitest）

- `crypto/credential-cipher.spec.ts`：往返 / 篡改 tag 抛 `llm_key_decrypt_failed` / 篡改 iv 抛错 / IV 随机性（同明文两次密文不同）/ maskApiKey 边界（len<6/6-11/≥12）/ fingerprint 稳定性。
- `llm.service.spec.ts`：ensureTeamAdmin 守卫（MEMBER PUT → 403）/ gateway DISABLED 拒绝（`gateway_disabled`）/ binding 归属校验（跨租户不可见）/ DTO 字段白名单（forbidNonWhitelisted 剥离）/ 审计 metadata 不含 key（AC12）/ decrypt 写审计。

### 10.2 桌面单测（cargo test）

- `cli_installer.rs #[cfg(test)]`：`winget_package_id` 查表 / 非 Windows 返回 Unsupported / `installer_env` 不含 TOKEN/KEY / `redact_log_line` 过滤 sk-/Bearer / `cleanup_partial_install` 参数构造正确（不实跑 winget）。

### 10.3 类型与构建

- `pnpm --filter @lingfang/contract typecheck`
- `pnpm --filter @lingfang/collab-api typecheck && pnpm --filter @lingfang/collab-api test`
- `pnpm --filter desktop typecheck && pnpm --filter desktop test && pnpm --filter desktop build`
- `cd apps/desktop/src-tauri && cargo test && cargo build`

### 10.4 手动验收（对应 PRD AC1-AC14）

见 implement.md §4 映射表。

## 11. 安全风险

> 全局 CLAUDE.md 安全优先级最低，但 apiKey 属用户凭据保护（非平台安全控制），加密是基本工程要求。

- **apiKey 明文经 HTTPS 下发**（D1 用户决策）：decrypt 端点仅 ensureTeamAdmin + 强审计 + HTTPS。库是密文，库泄漏 ≠ key 泄漏。缓解：HTTPS 强制、审计每次解密、明文不进日志。
- **密钥丢失=历史 key 不可解密**：文档强调备份；轮换留 TODO。
- **winget 执行高权限**：子进程 env_clear 裁掉宿主 token；输出 redact 后落 history；用户 Dialog 二次确认。
- **npm fallback 供应链**：固定官方 scope + `--ignore-scripts`；winget 优先，npm 仅兜底。

## 12. 不动清单

- 现有 code_assistant/plugin_script 探测逻辑（只复用，不改）。
- 现有 settings 后端地址 Card 逻辑（搬进 Tab3，零功能改动）。
- 现有 auth/wallet/plugin/admin 模块（只追加 llm 相关，不改既有端点）。
- packages/contract 既有 schema（只重建 llm.ts，其他文件不动）。
