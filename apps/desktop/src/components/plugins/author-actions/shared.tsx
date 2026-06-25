import type { LoadedPlugin } from '@/lib/types';

export function isAuthorManaged(plugin: LoadedPlugin): boolean {
  return plugin.source === 'team';
}

// 注：插件图标已从所有列表/侧栏/编辑器移除展示（任务 06-25），保留 readPluginIcon 仅用于
// 编辑时原样回写 manifest.icon，不破坏既有数据。PluginIcon 渲染组件已废弃删除。
export function readPluginIcon(plugin: LoadedPlugin): string | undefined {
  const manifest = plugin.manifest;
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    const icon = (manifest as Record<string, unknown>).icon;
    if (typeof icon === 'string' && icon.trim()) return icon.trim();
  }
  return undefined;
}
