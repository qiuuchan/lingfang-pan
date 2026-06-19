import { describe, expect, it } from 'vitest';
import { pluginCenterTabFromView, pluginCenterViewForTab } from './plugin-center';

describe('pluginCenterTabFromView', () => {
  it('routes the plugin page to local plugins by default', () => {
    expect(pluginCenterTabFromView('plugins')).toBe('local');
  });

  it('keeps legacy marketplace links inside the unified plugin page', () => {
    expect(pluginCenterTabFromView('market')).toBe('market');
  });

  it('keeps legacy author-center links inside team plugins', () => {
    expect(pluginCenterTabFromView('author-center')).toBe('team');
  });

  it('maps plugin tabs back to their route views', () => {
    expect(pluginCenterViewForTab('local')).toBe('plugins');
    expect(pluginCenterViewForTab('team')).toBe('author-center');
    expect(pluginCenterViewForTab('market')).toBe('market');
  });
});
