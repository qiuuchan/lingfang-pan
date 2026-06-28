export type ModelTier = 'fast' | 'premium';

export function normalizeModelTier(value: unknown): ModelTier | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/^tier:/, '');
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
