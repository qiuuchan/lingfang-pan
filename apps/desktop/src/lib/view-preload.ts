import type { View } from '@/lib/types';

const loaders: Partial<Record<View, () => Promise<unknown>>> = {
  team: () => import('@/pages/TeamHome'),
  'team-admin': () => import('@/pages/TeamAdmin'),
  wallet: () => import('@/pages/Wallet'),
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
