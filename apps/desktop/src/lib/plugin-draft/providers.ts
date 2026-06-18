export const EXAMPLES = [
  '做一个番茄钟插件，可设置 25/45 分钟、暂停继续、完成后提醒',
  '我要一个视频脚本分镜表工具，输入脚本后输出镜头、画面、旁白和标签',
  '创建一个 Markdown 速记插件，左侧编辑右侧实时预览，支持复制导出',
];

export type ProviderId = 'claude' | 'codex';
export type ProviderCatalogItem = { id: ProviderId; label: string; models: string[] };

export const PROVIDERS: ProviderCatalogItem[] = [
  { id: 'claude', label: 'ClaudeCode', models: [] as string[] },
  { id: 'codex', label: 'Codex', models: [] as string[] },
];

type ActiveProviderCatalogInput = { provider?: string | null; defaultModels?: string[] | null } | null;
type BindingCatalogInput = { modelOverride?: string[] | null } | null;

const OPENAI_COMPATIBLE_PROVIDER_IDS = new Set(['openai', 'azure', 'deepseek', 'minimax', 'moonshot', 'qwen']);

export function buildAssistantProviderCatalog(input: {
  tools?: unknown;
  activeProvider?: ActiveProviderCatalogInput;
  binding?: BindingCatalogInput;
}): { providers: ProviderCatalogItem[]; hasSdkRuntime: boolean } {
  const upstreamModels = uniqueModels([
    ...((input.binding?.modelOverride) || []),
    ...((input.activeProvider?.defaultModels) || []),
  ]);
  const compatible = compatibleProviderIds(input.activeProvider?.provider);
  const providers = PROVIDERS
    .filter((provider) => compatible.includes(provider.id))
    .map((provider) => ({ ...provider, models: upstreamModels }));
  return { providers, hasSdkRuntime: providers.length > 0 };
}

function compatibleProviderIds(provider: string | null | undefined): ProviderId[] {
  const normalized = (provider || '').trim().toLowerCase();
  if (normalized === 'anthropic') return ['claude'];
  // 修复 CLAUDE-OPTION：custom 是用户自配端点，协议不确定（可能 Anthropic 兼容、也可能 OpenAI 兼容），
  // 故同时提供 ClaudeCode（/v1/messages）与 Codex（/v1/chat/completions）两项，由用户按自身端点协议选择。
  // 延续提交 0aa2fd8「custom 给两项」的意图，opencode CLI 下线后替换为 codex。
  if (normalized === 'custom') return ['claude', 'codex'];
  if (OPENAI_COMPATIBLE_PROVIDER_IDS.has(normalized) || !normalized) return ['codex'];
  return ['codex'];
}

function uniqueModels(models: string[]): string[] {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

// 保留思考强度控件类型，SDK runtime 当前不把它映射到 provider 私有参数。
export type EffortLevel = 'max' | 'high' | 'medium' | 'low' | 'none';

export const EFFORT_LEVELS: EffortLevel[] = ['max', 'high', 'medium', 'low', 'none'];

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  max: '极致思考',
  high: '深度思考',
  medium: '标准思考',
  low: '轻量思考',
  none: '不思考',
};

// R1 模型名首字母大写：UI 显示层把小写 id（sonnet/opus/haiku/fable…）转为首字母大写。
// 仅做首字符大写、其余保持原样（适配 gpt-5.1-codex 这类带连字符的复合 id 不误伤）。
// default 等占位值原样返回（由调用方另显示「默认模型」）。
export function capitalizeModel(id: string | null | undefined): string {
  if (!id) return '';
  if (id === 'default') return '默认模型';
  const trimmed = id.trim();
  if (!trimmed) return '';
  const first = trimmed.charAt(0);
  const rest = trimmed.slice(1);
  // 仅对 ASCII 字母首字符做 toUpperCase（中文/数字首字符保持原样）。
  return (first >= 'a' && first <= 'z' ? first.toUpperCase() : first) + rest;
}

// R6 自定义模型哨兵：Composer 的 Select「自定义…」项 value。
// 选中后展开 Input 手输任意 model id。send 时须把哨兵视为「未选模型」回退 provider 默认（与 default 同语义）。
// 双下划线前缀避免与真实模型 id 冲突。
export const CUSTOM_MODEL_SENTINEL = '__custom__';

// R6 发送前模型清理：把占位值（default / 自定义哨兵 / 空白）归一为 undefined，
// 与 Rust SDK runtime 的模型清理语义一致（None 或非空且非占位）。
// 父组件 send 时调用，避免把哨兵当真模型传给 Rust 写进配置文件。
export function resolveSendModel(model: string | null | undefined): string | undefined {
  const trimmed = (model ?? '').trim();
  if (!trimmed || trimmed === 'default' || trimmed === CUSTOM_MODEL_SENTINEL) return undefined;
  return trimmed;
}

// === R3/R4 流式分类渲染：工具卡片 / AskUserQuestion 解析 ===
//
export function providerLabel(provider: ProviderId) {
  return PROVIDERS.find((item) => item.id === provider)?.label || provider;
}
