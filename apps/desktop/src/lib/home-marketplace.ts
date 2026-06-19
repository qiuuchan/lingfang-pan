import { fmtYuan } from './money';

export interface HomeMarketPlugin {
  price_cents?: number;
  is_free?: boolean;
  purchased?: boolean;
}

export function marketplaceSearchPath(query: string): string {
  const q = query.trim();
  return `/api/marketplace/search?q=${encodeURIComponent(q)}&sort=installs`;
}

export function pluginNeedsPurchase(plugin: HomeMarketPlugin): boolean {
  const free = plugin.is_free ?? (plugin.price_cents ?? 0) === 0;
  return !free && !plugin.purchased;
}

export function pluginActionLabel(plugin: HomeMarketPlugin): string {
  if (!pluginNeedsPurchase(plugin)) return '使用';
  return `购买并使用 ${fmtYuan(plugin.price_cents)}`;
}
