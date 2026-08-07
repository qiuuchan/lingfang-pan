// preset-models.ts —— 内置预设模型清单（2026.06 各 provider 官方最新真实模型）。
//
// 数据源：各 provider 官方文档（OpenAI / Anthropic / Google Gemini / DeepSeek / Moonshot Kimi / Qwen）。
// 每模型带 contextWindow（供上下文用量管理）+ supportsReasoning（是否支持思考/推理输出）。
// 渠道创建时 provider 选定后，可从对应预设勾选（也可手输自定义模型）。
//
// 维护：provider 发布新模型时在此更新（参考 model.dev / 官方 changelog）。

export interface PresetModel {
  id: string;
  label: string;
  contextWindow: number; // 最大上下文 token
  supportsReasoning?: boolean; // 是否支持思考/推理输出
}

/** 按 provider 分组的预设模型（key = LLM_PROVIDER 白名单值）。 */
export const PRESET_MODELS: Record<string, PresetModel[]> = {
  openai: [
    // GPT-5.5 系列（当前旗舰）
    { id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272000 },
    { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', contextWindow: 272000 },
    // GPT-5.4 系列（性价比主力）
    { id: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 272000 },
    { id: 'gpt-5.4-pro', label: 'GPT-5.4 Pro', contextWindow: 272000 },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 272000 },
    { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', contextWindow: 272000 },
    // GPT-5.3-Codex（编程专用）
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', contextWindow: 272000, supportsReasoning: true },
    // GPT-5.2 / 5.1 / 5（前代旗舰）
    { id: 'gpt-5.2', label: 'GPT-5.2', contextWindow: 272000 },
    { id: 'gpt-5.1', label: 'GPT-5.1', contextWindow: 272000 },
    { id: 'gpt-5', label: 'GPT-5', contextWindow: 272000 },
    { id: 'gpt-5-mini', label: 'GPT-5 mini', contextWindow: 400000 },
    { id: 'gpt-5-nano', label: 'GPT-5 nano', contextWindow: 400000 },
    // o 系列（推理模型）
    { id: 'o3', label: 'o3', contextWindow: 200000, supportsReasoning: true },
    { id: 'o3-pro', label: 'o3 Pro', contextWindow: 200000, supportsReasoning: true },
    // GPT-4.1（非推理，1M context）
    { id: 'gpt-4.1', label: 'GPT-4.1', contextWindow: 1047576 },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', contextWindow: 1047576 },
  ],
  anthropic: [
    // Claude 4.x 系列（2026.06 最新，context 1M）
    {
      id: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      contextWindow: 1000000,
      supportsReasoning: true,
    },
    {
      id: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      contextWindow: 1000000,
      supportsReasoning: true,
    },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 1000000 },
    // 前代（别名兼容）
    {
      id: 'claude-opus-4-7',
      label: 'Claude Opus 4.7',
      contextWindow: 1000000,
      supportsReasoning: true,
    },
    {
      id: 'claude-opus-4-6',
      label: 'Claude Opus 4.6',
      contextWindow: 1000000,
      supportsReasoning: true,
    },
  ],
  azure: [
    // Azure 部署名可能不同，此处给官方模型 id 供参考
    { id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272000 },
    { id: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 272000 },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 272000 },
    { id: 'o3', label: 'o3', contextWindow: 200000, supportsReasoning: true },
  ],
  deepseek: [
    // DeepSeek V4 系列（2026.04 发布，V3.2 的 deepseek-chat/reasoner 将于 2026.07 弃用）
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      contextWindow: 128000,
      supportsReasoning: true,
    },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindow: 128000 },
    // V3.2（兼容别名，即将弃用）
    { id: 'deepseek-chat', label: 'DeepSeek Chat (V3.2)', contextWindow: 128000 },
    {
      id: 'deepseek-reasoner',
      label: 'DeepSeek Reasoner (R1)',
      contextWindow: 128000,
      supportsReasoning: true,
    },
  ],
  moonshot: [
    // Kimi K2.7 / K2.6（2026.06 最新，256K context）
    {
      id: 'kimi-k2.7-code',
      label: 'Kimi K2.7 Code',
      contextWindow: 256000,
      supportsReasoning: true,
    },
    { id: 'kimi-k2.6', label: 'Kimi K2.6', contextWindow: 256000, supportsReasoning: true },
    // Moonshot V1（前代，多 context 长度）
    { id: 'moonshot-v1-128k', label: 'Moonshot v1 128K', contextWindow: 128000 },
    { id: 'moonshot-v1-32k', label: 'Moonshot v1 32K', contextWindow: 32000 },
    { id: 'moonshot-v1-8k', label: 'Moonshot v1 8K', contextWindow: 8000 },
  ],
  qwen: [
    // Qwen3.7 / 3.5 系列（2026.06 最新，262K context）
    { id: 'qwen3.7-max', label: 'Qwen3.7 Max', contextWindow: 262144, supportsReasoning: true },
    {
      id: 'qwen3.7-max-preview',
      label: 'Qwen3.7 Max Preview',
      contextWindow: 262144,
      supportsReasoning: true,
    },
    { id: 'qwen3.5-plus', label: 'Qwen3.5 Plus', contextWindow: 262144, supportsReasoning: true },
    { id: 'qwen3.5-flash', label: 'Qwen3.5 Flash', contextWindow: 262144 },
    // Qwen-Max / Plus（别名）
    { id: 'qwen3-max', label: 'Qwen3 Max', contextWindow: 262144, supportsReasoning: true },
    { id: 'qwen-plus', label: 'Qwen Plus', contextWindow: 262144 },
    { id: 'qwen-flash', label: 'Qwen Flash', contextWindow: 262144 },
  ],
  custom: [], // 自定义 provider：无预设，纯手输。
};

/** 生图专用预设模型（OpenAI 系，中转会走 /images/generations）。 */
export const PRESET_IMAGE_MODELS: PresetModel[] = [
  { id: 'gpt-image-1', label: 'GPT Image 1', contextWindow: 0 },
  { id: 'dall-e-3', label: 'DALL·E 3', contextWindow: 0 },
  { id: 'dall-e-2', label: 'DALL·E 2', contextWindow: 0 },
];

/** 按 provider + kind 取预设模型列表。 */
export function getPresetModels(provider: string, kind: 'CHAT' | 'IMAGE'): PresetModel[] {
  if (kind === 'IMAGE') return PRESET_IMAGE_MODELS;
  // 用 own-property 判断：provider 来自表单/接口的任意字符串，裸下标会命中
  // Object.prototype 上的 'constructor'/'toString' 等，返回函数导致调用方 .map 崩溃。
  if (!Object.prototype.hasOwnProperty.call(PRESET_MODELS, provider)) return [];
  return PRESET_MODELS[provider];
}
