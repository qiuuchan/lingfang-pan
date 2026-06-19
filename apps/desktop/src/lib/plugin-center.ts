import type { View } from './types';

export type PluginCenterTab = 'local' | 'team' | 'market';

export function pluginCenterTabFromView(view: View): PluginCenterTab {
  if (view === 'market') return 'market';
  if (view === 'author-center') return 'team';
  return 'local';
}

export function pluginCenterViewForTab(tab: PluginCenterTab): View {
  if (tab === 'market') return 'market';
  if (tab === 'team') return 'author-center';
  return 'plugins';
}

export function isPluginCenterView(view: View): boolean {
  return view === 'plugins' || view === 'market' || view === 'author-center';
}
