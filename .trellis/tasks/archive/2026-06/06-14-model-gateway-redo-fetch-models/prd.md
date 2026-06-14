# 模型网关重做（填 key + Rust 拉取模型）

## Goal（目标）

修正模型网关的交互设计：租户在设置页**只填一个 apiKey**（针对选中的 provider），填好后**桌面 Rust 用 key 调 provider 的 `/v1/models` 接口动态拉取可用模型列表**，用户从拉取的列表里选模型。url 不由租户管——来自后台云分发的 provider 配置列表。

## 背景（为什么改）

上一版模型网关（settings-cli-runtime-model-gateway 任务）做成了「网关目录让租户选 + 从静态 models 列表勾选」——Admin 维护 `LlmGateway.models` 静态数组，租户从中选子集。用户反馈这不对：
- 大模型 url 应**后台云分发**（或打包进软件），不是让租户感知「网关目录」。
- 租户**只填 apiKey**，模型应该是**填 key 后动态拉取**（调 provider 真实的 `/v1/models`），不是从静态列表选。

## Scope（范围）

### 保留不变（上一版已就绪，复用）
- `LlmGateway` 表 + `/api/llm/gateways` 端点：语义从「网关目录」改为「**provider 配置云分发**」（下发给所有客户端的固定 provider 列表：provider + apiUrl + 默认模型提示）。表结构不动。
- `TenantLlmBinding` 表：`(teamId, gatewayId)` 唯一（一个 provider 一条绑定），`encryptedApiKey`（AES-256-GCM）+ `apiKeyHint` + `keyFingerprint` 保留。`modelOverride` 语义微调（见下）。
- 加密/审计/端点鉴权（ensureTeamAdmin 等）全部保留。

### 改动

#### R1 桌面 Rust：新增 fetch_models 命令
- 新建命令 `fetch_models({ provider, apiUrl, apiKey })`：
  - 用 reqwest 调 `{apiUrl}/v1/models`（OpenAI 兼容标准），`Authorization: Bearer {apiKey}`。
  - 解析返回的 `{ data: [{ id: "gpt-4o", ... }, ...] }`，提取 `id` 列表。
  - 返回 `{ models: string[] }`（模型 id 数组）。
  - 错误：网络失败/401 key 无效/非 OpenAI 兼容 → 友好错误（前端按 code 分支）。
  - **reqwest 不走 webview**，绕开 CORS；apiKey 只在 Rust 内存（reqwest 请求），不进前端 webview 长期持有。
- Cargo.toml 加 `reqwest`（features: json，rustls-tls 避免原生 TLS 依赖）。

#### R2 前端：重做 ModelGatewayTab
- 去掉当前「网关下拉 + 静态模型 checkbox 组」的交互。
- 新交互：
  1. **provider 选择**：从云分发列表（`GET /api/llm/gateways`）选一个 provider（下拉/卡片）。选 provider 只为确定 apiUrl（url 来自云分发，用户不感知 url）。
  2. **apiKey 输入**：一个 password input，填该 provider 的 key。已绑定则显示脱敏 hint（`sk-***xxxx`），可重新填覆盖。
  3. **「拉取模型」按钮**：填 key 后点击 → `tauriInvoke('fetch_models', { provider, apiUrl, apiKey })` → 显示拉取到的模型列表（可多选/单选当前要用的）。
  4. **保存**：`PUT /api/llm/binding`（gatewayId + apiKey + 选中的 modelOverride）。
- 模型展示：拉取后用 checkbox 组或多选展示，选中态存 `modelOverride`。

#### R3 后端：微调（可选，最小）
- `TenantLlmBinding.modelOverride`：语义从「gateway.models 静态子集」改为「拉取后选的子集」。字段类型不变（Json? string[]），service 的 `effectiveModels` 逻辑不变（modelOverride ?? gateway.models）。**若不拉取就保存，modelOverride 为空，effectiveModels 退回 gateway.models（默认提示模型）**。
- `LlmGateway.models` 字段：从「静态可选列表」改为「**默认/推荐模型提示**」（拉取失败或未拉取时的 fallback）。语义松绑，不强求精确。
- 无需新端点（fetch_models 是桌面 Rust 直连 provider，不经后端）。

## Constraints（约束）

- 简体中文。UTF-8 无 BOM。专用工具操作文件。
- 复用优先：保留上一版的表/加密/端点/审计，只改交互 + 加 fetch_models 命令。
- apiKey 加密存后端 + 跨电脑（不变）；拉取模型时 apiKey 在桌面 Rust 内存临时使用（reqwest），不进前端 webview 长期持有。
- reqwest 走 Rust，绕 webview CORS（provider 一般不放跨域）。
- 破坏式：ModelGatewayTab 直接重做，不保留旧「静态模型勾选」交互。

## Acceptance Criteria

- [ ] AC1 设置页模型网关：选 provider（从云分发列表）→ 填 apiKey → 点「拉取模型」→ 显示该 provider 真实可用模型列表。
- [ ] AC2 key 无效（401）→ 友好提示「apiKey 无效或已过期」，不崩。
- [ ] AC3 网络失败/超时 → 友好提示，可重试。
- [ ] AC4 provider 不兼容 OpenAI `/v1/models` 协议 → 提示「该 provider 暂不支持自动拉取模型」。
- [ ] AC5 保存绑定 → 后端加密存库 + 跨电脑可见（GET 返脱敏 hint）。
- [ ] AC6 已绑定 provider 重新进入：显示脱敏 hint + 可重新拉取/覆盖 key。
- [ ] AC7 fetch_models 命令的 apiKey 不进前端 webview 长期内存（仅 Rust reqwest 临时用）。
- [ ] AC8 cargo test + pnpm typecheck/test/build 全绿，现有测试不回归。

## Notes

- OpenAI 兼容 `/v1/models` 返回 `{data: [{id, object, created, owned_by}, ...]}`，提取 id。
- Anthropic 的 `/v1/models`（2024 后支持）格式类似；Azure 是 `/openai/deployments` 不同——首版聚焦 OpenAI 兼容协议，Azure 等特殊 provider 留 TODO。
- design.md 写技术设计（fetch_models 签名/ModelGatewayTab 布局/错误码），implement.md 写步骤。
