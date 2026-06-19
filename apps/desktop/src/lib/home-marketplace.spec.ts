import { describe, expect, it } from 'vitest';
import { marketplaceSearchPath, pluginActionLabel, pluginNeedsPurchase } from './home-marketplace';

describe('home marketplace helpers', () => {
  it('builds a marketplace search path with encoded query', () => {
    expect(marketplaceSearchPath('日报 插件')).toBe('/api/marketplace/search?q=%E6%97%A5%E6%8A%A5%20%E6%8F%92%E4%BB%B6&sort=installs');
  });

  it('uses the recommended marketplace query when the search is empty', () => {
    expect(marketplaceSearchPath('   ')).toBe('/api/marketplace/search?q=&sort=installs');
  });

  it('detects paid plugins that still need purchase', () => {
    expect(pluginNeedsPurchase({ price_cents: 900, is_free: false, purchased: false })).toBe(true);
    expect(pluginNeedsPurchase({ price_cents: 900, purchased: true })).toBe(false);
    expect(pluginNeedsPurchase({ price_cents: 0, is_free: true })).toBe(false);
  });

  it('labels the primary action by purchase state', () => {
    expect(pluginActionLabel({ price_cents: 900, is_free: false, purchased: false })).toBe('购买并使用 ¥9.00');
    expect(pluginActionLabel({ price_cents: 900, purchased: true })).toBe('使用');
    expect(pluginActionLabel({ price_cents: 0, is_free: true })).toBe('使用');
  });
});
