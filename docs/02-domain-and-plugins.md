# 领域模型与插件系统

> 蓝图 · 2026-06-09（v2：生成为核心）· 上游 [愿景与架构](01-vision-and-architecture.md)
> 契约单一事实来源：`packages/contract`（TS 权威，Rust 端按同字段实现）

---

# A 部分 · 领域模型

## 1. 实体关系

```
User ──< Membership >── Tenant
                          ├──< PluginDraft        ★核心：正在生成/迭代的插件
                          ├──< Plugin             （草稿发布后的成品）
                          ├──< PluginInstallation
                          ├──< PluginGrant
                          ├──< LlmGatewayBinding
                          └──< InvocationAudit
```

**PluginDraft（AI 生成中的草稿）→ 发布 → Plugin（成品）。** 草稿是产品的核心对象。

## 2. 实体契约

```ts
type TenantRole = 'owner' | 'admin' | 'developer' | 'member';
type RuntimeType = 'client' | 'cloud';   // 首发主用 client

interface User       { id; email; display_name; status:'active'|'disabled'; created_at }
interface Tenant     { id; name; slug; owner_user_id; status:'active'|'suspended'; created_at }
interface Membership { tenant_id; user_id; role:TenantRole; status:'active'|'invited'|'disabled'; joined_at }

// ★核心对象：一次「描述 → 生成 → 迭代」的插件草稿
interface PluginDraft {
  id; tenant_id; created_by;
  title;                                  // 插件名
  source_prompt: string;                  // 用户最初的自然语言描述
  status: 'generating'|'ready'|'invalid'|'published';
  files: { path: string; content: string }[];          // AI 生成的插件文件（manifest/ui/...）
  turns: { role:'user'|'assistant'; content:string; at:string }[];  // 对话式迭代历史
  diagnostics: { stage:'schema'|'security'|'preview'; status:'pass'|'fail'; message:string }[];
  updated_at;
}

interface Plugin     { id; name; version; description; author_tenant_id; runtime_type;
                       entry; capabilities:PluginCapability[]; visibility:'private'|'tenant'; status }
interface PluginInstallation { tenant_id; plugin_id; version; status:'installed'|'disabled'; installed_by; installed_at }
interface PluginGrant        { tenant_id; plugin_id; subject_kind:'user'|'role'; subject_id; effect:'allow'|'deny' }

interface LlmGatewayBinding {        // ★生成与运行的 LLM 调用都经它
  id; tenant_id; name; protocol:'openai-compatible';
  base_url; api_key_ciphertext;      // 加密存储，前端/插件永不见明文
  models: string[]; status; created_by; created_at;
}

interface InvocationAudit {          // 只记事实，不记费用；含「生成」与「运行」两类调用
  id; tenant_id; plugin_id?; draft_id?; user_id; kind:'generate'|'runtime';
  capability?; model?; status:'ok'|'denied'|'error'; error_code?; started_at; finished_at;
}
```

## 3. 关键约束

1. **租户隔离**：除 `User` 外所有表带 `tenant_id`，按 JWT 注入的 `tenant_id` 强制过滤。
2. **凭据保护**：`api_key` 加密落库，仅服务端可解密；接口脱敏。
3. **审计≠计费**：审计记 生成/运行 两类调用事实，计费交第三方网关。
4. **状态显式**：所有 `status` 显式枚举，无 `_demo` 兜底。
5. **授权解析**：`PluginGrant` deny 优先、user 级优先于 role 级，默认无权。

## 4. 契约治理

单一事实来源 = `packages/contract`（TS + zod）。Rust 服务端与 SDK 对齐，字段漂移即缺陷。

---

# B 部分 · 插件系统

## 1. 插件是什么

> **一个插件 = 跑在沙箱里的 Web 功能单元**：声明受控能力、提供 UI、可选调 LLM。
> **首发插件主要由 AI 根据用户的自然语言描述生成**（用户全程 no-code）。

## 2. 包结构

```
plugin/
├── manifest.json     # 元信息 + 能力声明
├── ui/{index.html, main.js, styles.css}   # styles 只消费 design token
└── README.md
```

AI 生成时直接产出这套文件；校验通过后才能预览/发布。

## 3. Manifest 与能力清单

```ts
type CapabilityKind =
  | 'ui.view' | 'fs.pick' | 'fs.read' | 'fs.write' | 'net.fetch'
  | 'clipboard' | 'llm.chat' | 'storage.kv'
  | 'system.screenshot'   // ★系统截屏，映射 Tauri 2 系统 capability
  | 'system.notify';

interface PluginCapability {
  kind: CapabilityKind; reason: string;
  risk: 'none'|'low'|'medium'|'high';
  requires_admin: boolean;
  scope?: Record<string, unknown>;
}
```

> 「截图插件」例子：声明 `{kind:'system.screenshot', risk:'medium', requires_admin:true}`，映射 Tauri 2 系统 capability，管理员授权后放行。完整示例见 `plugins/summarizer/manifest.json`。
>
> **AI 生成时**，会根据用户描述自动产出 manifest 与能力声明；高风险能力默认 `requires_admin:true`，由管理员确认。

## 4. 沙箱与安全

- **隔离**：插件跑在受限 WebView / `<iframe sandbox>`；生成后的草稿在**同一沙箱即时预览**。
- **零直连**：不能 fetch/require/读文件/持 key，越权操作只能经 `sdk.invoke`。
- **三重校验**（Rust 核网关）：Tauri capability 文件 → manifest 声明 → 用户授权。
- **生成期校验**：AI 产出的代码先过 schema + 安全校验（禁直连网络/越权）才允许预览，不过则把错误回喂重生成。
- **主题统一**：CSS 只消费 design token（`packages/ui-tokens`）。

## 5. 插件 SDK（`@lingfang/plugin-sdk`）

AI 生成的插件代码通过 SDK 访问能力（骨架见 `packages/plugin-sdk/src/index.ts`）：

```ts
const [file] = await sdk.fs.pick({ accept:['.pdf','.txt','.md'] });
const text   = await sdk.fs.read(file);
const out    = await sdk.llm.chat({ messages:[...] });  // 不含 key/base_url/供应商
await sdk.ui.render(out);
```

## 6. 生命周期（生成为核心）

```
描述 → AI 生成草稿(PluginDraft) → 校验(schema+安全) → 沙箱预览 → 对话迭代
                                                              │ 满意
                                    发布(Plugin) → 安装 → 授权 → 使用 → 审计
```

- **核心首发（M1/M2）**：描述 → 生成 → 校验 → 预览 → 迭代。
- **接着（M3）**：发布 → 安装 → 授权 → 使用。
- **后置（M4）**：分享 / 公开市场。
