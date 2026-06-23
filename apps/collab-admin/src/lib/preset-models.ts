// preset-models.ts —— 内置预设模型清单（参考 model.dev，按 provider 分组的主流 LLM）。
//
// 渠道创建/编辑时，provider 选定后可从对应预设勾选模型（也可手输自定义）。
// 数据为人工维护的经过验证的主流模型（非实时拉取——model.dev 无公开 JSON API，且人工清单更稳）。
// 每个模型带 contextWindow（供上下文用量管理）+ 是否支持思考（reasoning）。

export interface PresetModel {
  id: string;
  label: string;
  contextWindow: number; // 最大上下文 token
  supportsReasoning?: boolean; // 是否支持思考/推理输出
}

/** 按 provider 分组的预设模型（key = LLM_PROVIDER 白名单值）。 */
export const PRESET_MODELS: Record<string, PresetModel[]> = {
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128000 },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', contextWindow: 128000 },
    { id: 'gpt-4.1', label: 'GPT-4.1', contextWindow: 1047576 },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', contextWindow: 1047576 },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano', contextWindow: 1047576 },
    { id: 'o3', label: 'o3', contextWindow: 200000, supportsReasoning: true },
    { id: 'o4-mini', label: 'o4-mini', contextWindow: 200000, supportsReasoning: true },
    { id: 'gpt-5', label: 'GPT-5', contextWindow: 272000 },
    { id: 'gpt-5-mini', label: 'GPT-5 mini', contextWindow: 400000 },
    ],
  anthropic: [
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 200000, supportsReasoning: true },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000, supportsReasoning: true },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200000 },
    { id: 'claude-fable-5', label: 'Claude Fable 5', contextWindow: 200000, supportsReasoning: true },
  ],
  azure: [
    // Azure 模型名与 OpenAI 对齐（部署名可能不同，此处给官方模型 id 供参考）。
    { id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128000 },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', contextWindow: 128000 },
    { id: 'gpt-4.1', label: 'GPT-4.1', contextWindow: 1047576 },
    { id: 'o3', label: 'o3', contextWindow: 200000, supportsReasoning: true },
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'DeepSeek Chat (V3)', contextWindow: 128000 },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)', contextWindow: 128000, supportsReasoning: true },
  ],
  moonshot: [
    { id: 'moonshot-v1-8k', label: 'Moonshot v1 8K', contextWindow: 8000 },
    { id: 'moonshot-v1-32k', label: 'Moonshot v1 32K', contextWindow: 32000 },
    { id: 'moonshot-v1-128k', label: 'Moonshot v1 128K', contextWindow: 128000 },
    { id: 'kimi-k2', label: 'Kimi K2', contextWindow: 131072 },
  ],
  qwen: [
    { id: 'qwen-max', label: 'Qwen Max', contextWindow: 32768 },
    { id: 'qwen-plus', label: 'Qwen Plus', contextWindow: 131072 },
    { id: 'qwen-turbo', label: 'Qwen Turbo', contextWindow: 1000000 },
    { id: 'qwen3-235b-a22b', label: 'Qwen3 235B', contextWindow: 131072, supportsReasoning: true },
    { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', contextWindow: 1048576 },
  ],
  custom: [], // 自定义 provider：无预设，纯手输。
};

/** 生图专用预设模型（OpenAI 系，中转会走 /images/generations）。 */
export const PRESET_IMAGE_MODELS: PresetModel[] = [
  { id: 'dall-e-3', label: 'DALL·E 3', contextWindow: 0 },
  { id: 'dall-e-2', label: 'DALL·E 2', contextWindow: 0 },
  { id: 'gpt-image-1', label: 'GPT Image 1', contextWindow: 0 },
];

/** 按 provider + kind 取预设模型列表。 */
export function getPresetModels(provider: string, kind: 'CHAT' | 'IMAGE'): PresetModel[] {
  if (kind === 'IMAGE') return PRESET_IMAGE_MODELS;
  return PRESET_MODELS[provider] ?? [];
}
