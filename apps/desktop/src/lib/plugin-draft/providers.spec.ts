import { describe, expect, it } from 'vitest';
import { buildAssistantProviderCatalog } from './providers';

const tools = [
  { tool: 'claude', display_name: 'Claude Code', available: true },
  { tool: 'codex', display_name: 'Codex', available: true },
  { tool: 'opencode', display_name: 'OpenCode', available: true },
];

describe('buildAssistantProviderCatalog', () => {
  it('does not offer OpenAI-compatible custom models through Claude Code', () => {
    const catalog = buildAssistantProviderCatalog({
      tools,
      activeProvider: { provider: 'custom', defaultModels: ['minimax-m3'] },
      binding: { modelOverride: ['minimax-m3'] },
    });

    expect(catalog.providers).toEqual([
      { id: 'opencode', label: 'OpenCode', models: ['minimax-m3'] },
    ]);
    expect(catalog.hasAvailableCli).toBe(true);
  });

  it('routes Anthropic active-provider models only to Claude Code', () => {
    const catalog = buildAssistantProviderCatalog({
      tools,
      activeProvider: { provider: 'anthropic', defaultModels: ['claude-sonnet-4-5'] },
      binding: { modelOverride: null },
    });

    expect(catalog.providers).toEqual([
      { id: 'claude', label: 'Claude Code', models: ['claude-sonnet-4-5'] },
    ]);
  });

  it('routes OpenAI official models to Responses-capable and OpenAI-compatible CLIs', () => {
    const catalog = buildAssistantProviderCatalog({
      tools,
      activeProvider: { provider: 'openai', defaultModels: ['gpt-5.1'] },
      binding: { modelOverride: null },
    });

    expect(catalog.providers.map((provider) => provider.id)).toEqual(['codex', 'opencode']);
    expect(catalog.providers.every((provider) => provider.models.includes('gpt-5.1'))).toBe(true);
  });
});
