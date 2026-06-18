// llm-fetch.ts — 模型网关「拉取模型」Tauri 命令封装（design §3.1）。
//
// 职责：封装桌面壳 fetch_models 命令，用 apiKey 直连 provider 的 /v1/models 拉取可用模型列表。
//
// 安全（design §5 / AC7）：apiKey 仅作为本函数参数经 IPC 传给 Rust reqwest 临时使用，请求结束释放，
// 不存入前端任何 state/localStorage/全局变量，也不进前端 webview 长期内存。后端只存加密后的 key。
//
// 错误约定（与 llm_fetch.rs 顶部注释对齐，前端按 err.message 前缀 code 分支，不 message.includes）：
// - "api_key_invalid:" → apiKey 无效或过期（HTTP 401/403，AC2）。
// - "provider_response_unsupported:" → provider 非 OpenAI 兼容（AC4）。
// - 含「网络」字样 → 网络失败/超时（AC3）。
// - 其余 → 直接展示 err.message。

import { tauriInvoke } from '@/lib/api';

/** fetch_models 命令出参（与 Rust FetchModelsResult 对齐）。 */
interface FetchModelsOutput {
  models: string[];
}

/**
 * 拉取 provider 的可用模型列表。
 *
 * 走 Rust reqwest 直连 `{apiUrl}/v1/models`（OpenAI 兼容协议），Bearer apiKey 鉴权。
 * reqwest 在 Rust 进程发起请求，不经 webview，绕开 CORS（AC7：apiKey 不进前端长期内存）。
 *
 * @param provider  provider 标识（仅错误提示上下文，如 "openai" / "deepseek"）
 * @param apiUrl    provider 基础地址（来自云分发 LlmGateway.apiUrl，不含 /v1 后缀）
 * @param apiKey    用户填的明文 apiKey（仅本次 reqwest 请求用）
 * @returns 模型 id 数组（如 ["gpt-4o", "gpt-4o-mini"]）；失败时抛 Error，message 含 code 前缀
 */
export async function fetchModels(provider: string, apiUrl: string, apiKey: string): Promise<string[]> {
  // 入参契约：Tauri 要求 struct 入参包 `{ input: {...} }`，
  // 否则报 `missing required key input`。Rust FetchModelsInput 标了 rename_all=camelCase，
  // 故此处传 camelCase 的 apiUrl/apiKey（与 Rust 字段 api_url/api_key 映射）。
  const result = await tauriInvoke<FetchModelsOutput>('fetch_models', {
    input: { provider, apiUrl, apiKey },
  });
  return result.models;
}

/** test_llm_chat 命令出参（与 Rust TestLlmChatResult 对齐）。 */
interface TestLlmChatOutput {
  content: string;
}

/**
 * 测试模型连接：用配置的上游模型发送一条消息（默认 "hi"），返回助手回复。
 *
 * 走 Rust reqwest 直连 `{apiUrl}/v1/chat/completions`（OpenAI 兼容），Bearer apiKey。
 * 用于模型服务页「测试连接」按钮，验证 key/地址/模型组合是否可用。
 *
 * @param provider  provider 标识（仅错误提示上下文）
 * @param apiUrl    provider 基础地址
 * @param apiKey    明文 apiKey（仅本次请求用）
 * @param model     要测试的模型 id
 * @param prompt    可选自定义文案，默认 "hi"
 * @returns 助手回复内容；失败抛 Error，message 含 code 前缀（api_key_invalid:/网络等）
 */
export async function testLlmChat(
  provider: string,
  apiUrl: string,
  apiKey: string,
  model: string,
  prompt?: string,
): Promise<string> {
  const input: Record<string, string> = { provider, apiUrl, apiKey, model };
  if (prompt) input.prompt = prompt;
  const result = await tauriInvoke<TestLlmChatOutput>('test_llm_chat', { input });
  return result.content;
}
