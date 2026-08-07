export type ModelTier = 'fast' | 'premium';

export class UnsupportedModelTierError extends Error {
  readonly code = 'unsupported_model';
  readonly status = 400;

  constructor() {
    super('仅支持平台模型档位 fast 或 premium');
    this.name = 'UnsupportedModelTierError';
  }
}

export function pluginModelTier(value: unknown): ModelTier {
  if (value === undefined) return 'fast';
  if (value === 'fast' || value === 'premium') return value;
  throw new UnsupportedModelTierError();
}

export function normalizeModelTier(value: unknown): ModelTier | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^tier:/, '');
  if (normalized === 'fast') return 'fast';
  if (normalized === 'premium') return 'premium';
  return null;
}

export function modelTierLabel(tier: ModelTier): string {
  return tier === 'fast' ? '快速版' : '高级版';
}

export function modelTierShortLabel(tier: ModelTier): string {
  return tier === 'fast' ? '快速' : '高级';
}

export function modelTierRequestLabel(tier: ModelTier): string {
  return tier === 'fast' ? '快速请求' : '高级请求';
}

export function modelTierFromRecord(record: unknown): ModelTier | null {
  if (!record || typeof record !== 'object') return null;
  const obj = record as Record<string, unknown>;
  return (
    normalizeModelTier(obj.tier) ??
    normalizeModelTier(obj.modelTier) ??
    normalizeModelTier(obj.model_tier) ??
    normalizeModelTier((obj.metadata as Record<string, unknown> | undefined)?.tier) ??
    normalizeModelTier((obj.metadata as Record<string, unknown> | undefined)?.modelTier) ??
    normalizeModelTier((obj.metadata as Record<string, unknown> | undefined)?.model_tier)
  );
}
