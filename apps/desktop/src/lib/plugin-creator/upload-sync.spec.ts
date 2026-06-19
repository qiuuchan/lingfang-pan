import { describe, expect, it } from 'vitest';
import { draftWithPluginId, pluginWorkspaceDir, requireRenamedDraft } from './upload-sync';
import type { PluginDraft } from '@/lib/types';

function draft(pluginId: string): PluginDraft {
  return {
    id: 'draft-1',
    status: 'ready',
    files: [{ path: 'manifest.json', content: '{}' }],
    turns: [],
    diagnostics: [],
    plugin_id: pluginId,
  };
}

describe('upload sync helpers', () => {
  it('updates persisted draft plugin_id after local directory rename', () => {
    const updated = draftWithPluginId(draft('temp-1'), 'final-plugin');

    expect(updated?.plugin_id).toBe('final-plugin');
    expect(updated?.files[0].path).toBe('manifest.json');
  });

  it('keeps null draft null when rename happens before a draft exists', () => {
    expect(draftWithPluginId(null, 'final-plugin')).toBeNull();
  });

  it('throws when renamed directory cannot be reflected into a draft', () => {
    expect(() => requireRenamedDraft(null, 'final-plugin')).toThrow('当前草稿不存在');
  });

  it('builds workspace dir from plugins root and renamed plugin id', () => {
    expect(pluginWorkspaceDir('O:/LingFang/plugins/', 'final-plugin')).toBe('O:/LingFang/plugins/final-plugin');
    expect(pluginWorkspaceDir('O:\\LingFang\\plugins\\', 'final-plugin')).toBe('O:\\LingFang\\plugins/final-plugin');
  });
});
