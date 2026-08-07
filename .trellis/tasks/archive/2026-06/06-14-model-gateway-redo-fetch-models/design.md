# 技术设计：模型网关重做（填 key + Rust 拉取模型）

> 配套 `prd.md`。OpenAI 兼容 `/v1/models` 协议是事实标准（OpenAI/DeepSeek/Moonshot/Qwen/Anthropic 都遵循）。

## 1. 数据流（新交互）

```
设置页模型网关 Tab
  ├─ 挂载: GET /api/llm/gateways（云分发 provider 列表）+ GET /api/llm/binding（当前绑定）
  ├─ 用户选 provider（下拉）→ 确定 apiUrl（来自云分发，用户不感知 url）
  ├─ 用户填 apiKey（password input）
  ├─ 点「拉取模型」→ tauriInvoke('fetch_models', {provider, apiUrl, apiKey})
  │    → Rust reqwest GET {apiUrl}/v1/models, Authorization: Bearer {apiKey}
  │    → 解析 {data:[{id,...}]} → 返回 {models: ["gpt-4o",...]}
  │    → 前端显示模型列表（checkbox 多选）
  ├─ 用户选模型 → 存 modelOverride
  └─ 保存 → PUT /api/llm/binding（gatewayId, apiKey, modelOverride）
       → 后端加密存库（跨电脑）+ 审计
```

**关键**：fetch_models 是桌面 Rust **直连 provider**（不经后端 collab-api），apiKey 只在 Rust reqwest 请求时临时用，不进前端 webview 长期内存。后端只存加密后的 key（跨电脑用）。

## 2. 桌面 Rust：fetch_models 命令（新建）

### 2.1 Cargo.toml

```toml
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
```

（rustls-tls 避免原生 OpenSSL/WinHTTP 依赖；default-features=false 裁掉不需要的 feature。）

### 2.2 新建 `apps/desktop/src-tauri/src/llm_fetch.rs`

```rust
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct FetchModelsInput {
    provider: String,   // 仅用于错误提示，不参与请求
    api_url: String,    // 来自云分发 LlmGateway.apiUrl
    api_key: String,    // 用户填的明文（仅本次请求用）
}

#[derive(Serialize)]
struct FetchModelsResult {
    models: Vec<String>,
}

// OpenAI /v1/models 返回结构：{ data: [{ id, object, created, owned_by }, ...] }
#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}
#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

#[tauri::command]
pub async fn fetch_models(input: FetchModelsInput) -> Result<FetchModelsResult, String> {
    let url = format!("{}/v1/models", input.api_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("LingFang-Desktop")
        .build().map_err(|e| e.to_string())?;
    let resp = client.get(&url)
        .bearer_auth(&input.api_key)
        .send().await.map_err(|e| format!("网络请求失败：{e}"))?;
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("api_key_invalid:apiKey 无效或已过期".to_string());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("provider 返回错误：HTTP {status}"));
    }
    let parsed: ModelsResponse = resp.json().await
        .map_err(|_| "provider_response_unsupported:该 provider 返回格式非 OpenAI 兼容（无 data 数组）".to_string())?;
    Ok(FetchModelsResult {
        models: parsed.data.into_iter().map(|m| m.id).collect(),
    })
}
```

main.rs 注册：`mod llm_fetch;` + invoke_handler 加 `llm_fetch::fetch_models`。

## 3. 前端：重做 ModelGatewayTab

### 3.1 lib 封装（改 `lib/install-cli.ts` 同款，新建或并入现有 lib）

```ts
// fetch_models 命令封装
export async function fetchModels(
  provider: string,
  apiUrl: string,
  apiKey: string
): Promise<string[]> {
  const r = await tauriInvoke<{ models: string[] }>('fetch_models', {
    input: { provider, apiUrl, apiKey },
  });
  return r.models;
}
```

### 3.2 ModelGatewayTab 新交互（重写 433 行）

state：

- `providers: LlmGatewayPublic[]`（云分发列表，GET /llm/gateways）
- `bindings: TenantBindingPublic[]`（当前绑定）
- `selectedProviderId: string | null`（选中的 provider）
- `apiKeyInput: string`（用户填的明文，未保存）
- `fetching: boolean`（拉取中）
- `fetchedModels: string[]`（拉取到的模型）
- `selectedModels: string[]`（选中要用的，存 modelOverride）
- `saving: boolean`

UI 结构：

1. **provider 选择区**：从 providers 渲染下拉/卡片（显示 name + provider）。选中后：
   - 若已有该 provider 的绑定 → 显示 `apiKeyHint`（脱敏）+ 标记「已配置」。
   - apiKeyInput 清空（placeholder「重新填写覆盖」）。
2. **apiKey 输入**：password input + 「拉取模型」LoadingButton（disabled 当 apiKeyInput 空）。
3. **模型展示区**：fetching 时 spinner；拉取成功显示 checkbox 组（fetchedModels，选中 selectedModels）。
4. **保存按钮**：`PUT /api/llm/binding`（gatewayId=selectedProviderId, apiKey=apiKeyInput||undefined, modelOverride=selectedModels）。
5. **错误处理**（B25，按错误前缀 code 分支）：
   - `api_key_invalid` → toast「apiKey 无效或已过期」
   - `provider_response_unsupported` → toast「该 provider 暂不支持自动拉取模型」
   - 网络错误 → toast「网络请求失败，请检查网络」

## 4. 后端：无需改动（验证）

- `LlmGateway.models` 字段：语义松绑为「默认/推荐模型提示」（拉取失败 fallback）。不改结构。
- `TenantLlmBinding.modelOverride`：语义改为「拉取后选的子集」。`effectiveModels = modelOverride ?? gateway.models` 不变。
- `/api/llm/gateways` + `/api/llm/binding` 端点不变。
- 无新端点（fetch_models 直连 provider）。

## 5. 安全

- apiKey 在桌面 Rust 内存临时用（reqwest 请求），请求结束释放，不进前端 webview 长期持有（AC7）。
- 后端存的 encryptedApiKey 不变（跨电脑用）。
- fetch_models 不记日志（Rust 不打印 apiKey），command_preview 不含 key（redact 机制已有）。

## 6. 验证

- Rust 单测：URL 拼接（apiUrl 去尾斜杠 + /v1/models）；错误码映射（401→api_key_invalid）。
- 前端：typecheck + build + 现有 146 测不回归。
- 手动：选 OpenAI provider + 填真实 key + 拉取 → 显示 gpt-4o 等模型（需真实 key，或 mock 测）。

## 7. 实施顺序

1. Cargo.toml 加 reqwest + 新建 llm_fetch.rs + main.rs 注册 + 单测。
2. 前端 lib 封装 + ModelGatewayTab 重写。
3. 手动验证（拉取真实 provider 模型需 key，或用 mock server）。
