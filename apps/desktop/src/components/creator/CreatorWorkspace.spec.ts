import { describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '@/lib/types';
import {
  normalizeLoadedRuntime,
  referencedPluginPrompt,
  stagedPluginFromLoadedPlugin,
} from './CreatorWorkspace';

function plugin(overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    id: 'demo-plugin',
    name: 'Demo plugin',
    version: '1.0.0',
    entry: 'ui/index.html',
    runtime_type: 'client',
    ...overrides,
  };
}

describe('CreatorWorkspace draft projections', () => {
  it('preserves the cloud runtime', () => {
    expect(normalizeLoadedRuntime('cloud')).toBe('cloud');
  });

  it('ignores a binary manifest while preserving other tagged binary files', () => {
    const files = [
      {
        path: 'manifest.json',
        content: JSON.stringify({ name: 'Wrong name', runtime_type: 'python' }),
        binary: true,
      },
      { path: 'assets/logo.png', content: 'AP8DBA==', binary: true },
      { path: 'ui/index.html', content: '<main>demo</main>' },
    ];

    const staged = stagedPluginFromLoadedPlugin(
      plugin({
        name: 'Cloud plugin',
        runtime_type: 'cloud',
        files,
        _meta: {
          createdAt: '2026-07-12T00:00:00.000Z',
          updatedAt: '2026-07-12T00:00:00.000Z',
          source: 'workspace',
          sourceKind: 'EXTERNAL_TOOL',
          sourceLabel: 'External IDE',
        },
      }),
      files
    );

    expect(staged.name).toBe('Cloud plugin');
    expect(staged.runtime_type).toBe('cloud');
    expect(staged.sourceKind).toBe('EXTERNAL_TOOL');
    expect(staged.sourceLabel).toBe('External IDE');
    expect(staged.files).toContainEqual({
      path: 'assets/logo.png',
      content: 'AP8DBA==',
      binary: true,
    });
  });

  it('includes only text files in referenced plugin model context', () => {
    const prompt = referencedPluginPrompt(
      plugin({
        files: [
          { path: 'ui/index.html', content: '<main>demo</main>' },
          { path: 'assets/logo.png', content: 'SENSITIVE_BASE64', binary: true },
        ],
      })
    );

    expect(prompt).toContain('--- ui/index.html ---');
    expect(prompt).toContain('<main>demo</main>');
    expect(prompt).not.toContain('assets/logo.png');
    expect(prompt).not.toContain('SENSITIVE_BASE64');
  });
});
