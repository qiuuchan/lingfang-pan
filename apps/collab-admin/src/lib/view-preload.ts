import type { View } from '@/lib/types';

const loaders: Record<View, () => Promise<unknown>> = {
  dashboard: () => import('@/components/dashboard'),
  users: () => import('@/components/users-view'),
  platformAdmins: () => import('@/components/admins-view'),
  teams: () => import('@/components/teams-view'),
  governance: () => import('@/components/governance-view'),
  tickets: () => import('@/components/tickets-view'),
  audit: () => import('@/components/audit-view'),
  releases: () => import('@/components/releases-view'),
  roles: () => import('@/components/roles-view'),
  settings: () => import('@/components/settings-view'),
  pools: () => import('@/components/billing/pools-view'),
  channels: () => import('@/components/billing/channels-view'),
  billing: () => import('@/components/billing/billing-view'),
  credits: () => import('@/components/billing/credits-view'),
  callLogs: () => import('@/components/billing/call-logs-view'),
  apiKeys: () => import('@/components/billing/api-keys-view'),
};

const loaded = new Set<View>();

export function preloadView(view: View): void {
  if (loaded.has(view)) return;
  loaded.add(view);
  void loaders[view]?.().catch(() => loaded.delete(view));
}
