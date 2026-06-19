import type { PluginDraft } from '@/lib/types';

export function draftWithPluginId(draft: PluginDraft | null, pluginId: string): PluginDraft | null {
  if (!draft) return null;
  return { ...draft, plugin_id: pluginId };
}

export function requireRenamedDraft(draft: PluginDraft | null, pluginId: string): PluginDraft {
  const updated = draftWithPluginId(draft, pluginId);
  if (!updated) throw new Error('插件目录已重命名，但当前草稿不存在，无法同步插件路径。');
  return updated;
}

export function pluginWorkspaceDir(pluginsRoot: string, pluginId: string): string {
  return `${pluginsRoot.replace(/[\\/]+$/, '')}/${pluginId}`;
}
