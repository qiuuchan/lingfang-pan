import { describe, expect, it } from 'vitest';
import { buildAssistantProviderCatalog } from './providers';

describe('buildAssistantProviderCatalog', () => {
  it('routes custom provider models to both ClaudeCode and Codex', () => {
    const catalog = buildAssistantProviderCatalog({
      activeProvider: { provider: 'custom', defaultModels: ['minimax-m3'] },
      binding: { modelOverride: ['minimax-m3'] },
    });

    // 修复 CLAUDE-OPTION：custom 端点协议不确定，同时给 claude + codex 两项供用户自选。
    expect(catalog.providers).toEqual([
      { id: 'claude', label: 'ClaudeCode', models: ['minimax-m3'] },
      { id: 'codex', label: 'Codex', models: ['minimax-m3'] },
    ]);
    expect(catalog.hasSdkRuntime).toBe(true);
  });

  it('routes Anthropic active-provider models only to ClaudeCode', () => {
    const catalog = buildAssistantProviderCatalog({
      activeProvider: { provider: 'anthropic', defaultModels: ['claude-sonnet-4-5'] },
      binding: { modelOverride: null },
    });

    expect(catalog.providers).toEqual([
      { id: 'claude', label: 'ClaudeCode', models: ['claude-sonnet-4-5'] },
    ]);
  });

  it('routes OpenAI official models only to Codex', () => {
    const catalog = buildAssistantProviderCatalog({
      activeProvider: { provider: 'openai', defaultModels: ['gpt-5.1'] },
      binding: { modelOverride: null },
    });

    expect(catalog.providers.map((provider) => provider.id)).toEqual(['codex']);
    expect(catalog.providers.every((provider) => provider.models.includes('gpt-5.1'))).toBe(true);
  });

  it('routes OpenAI-compatible platform models only to Codex', () => {
    const catalog = buildAssistantProviderCatalog({
      activeProvider: { provider: 'minimax', defaultModels: ['minimax-m3'] },
      binding: { modelOverride: ['minimax-m3'] },
    });

    expect(catalog.providers).toEqual([
      { id: 'codex', label: 'Codex', models: ['minimax-m3'] },
    ]);
  });

  it('ignores legacy tool availability input', () => {
    const catalog = buildAssistantProviderCatalog({
      tools: [{ tool: 'legacy', available: true }],
      activeProvider: { provider: 'openai', defaultModels: ['gpt-5.1'] },
      binding: null,
    });

    expect(catalog.providers).toEqual([
      { id: 'codex', label: 'Codex', models: ['gpt-5.1'] },
    ]);
  });
});
