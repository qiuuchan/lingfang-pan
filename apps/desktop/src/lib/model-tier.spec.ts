import { describe, expect, it } from 'vitest';
import {
  modelTierFromRecord,
  modelTierLabel,
  modelTierRequestLabel,
  normalizeModelTier,
  pluginModelTier,
} from './model-tier';

describe('model tier helpers', () => {
  it('normalizes common tier wire values', () => {
    expect(normalizeModelTier('FAST')).toBe('fast');
    expect(normalizeModelTier('tier:premium')).toBe('premium');
    expect(normalizeModelTier('unknown')).toBeNull();
  });

  it('reads tier data from direct and metadata fields', () => {
    expect(modelTierFromRecord({ tier: 'FAST' })).toBe('fast');
    expect(modelTierFromRecord({ model_tier: 'PREMIUM' })).toBe('premium');
    expect(modelTierFromRecord({ metadata: { modelTier: 'fast' } })).toBe('fast');
  });

  it('uses consistent labels', () => {
    expect(modelTierLabel('fast')).toBe('快速版');
    expect(modelTierRequestLabel('premium')).toBe('高级请求');
  });

  it('defaults an omitted plugin model and rejects unknown upstream names', () => {
    expect(pluginModelTier(undefined)).toBe('fast');
    expect(pluginModelTier('premium')).toBe('premium');
    expect(() => pluginModelTier('gpt-4o')).toThrow(
      expect.objectContaining({ code: 'unsupported_model' })
    );
    expect(() => pluginModelTier(null)).toThrow(
      expect.objectContaining({ code: 'unsupported_model' })
    );
  });
});
