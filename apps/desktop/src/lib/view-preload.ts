import type { View } from '@/lib/types';

const loaders: Partial<Record<View, () => Promise<unknown>>> = {
  'run-plugins': () => import('@/pages/plugins/PluginCenterBody'),
  'develop-plugins': () => import('@/components/creator/CreatorWorkspace'),
  'draft-plugins': () => import('@/pages/DraftPlugins'),
  'team-wallet': () => import('@/pages/TeamWallet'),
  'team-admin': () => import('@/pages/TeamAdmin'),
  review: () => import('@/pages/Review'),
  settings: () => import('@/pages/Settings'),
};

const loaded = new Set<View>();

export function preloadView(view: View): void {
  const loader = loaders[view];
  if (!loader || loaded.has(view)) return;
  loaded.add(view);
  void loader().catch(() => loaded.delete(view));
}
