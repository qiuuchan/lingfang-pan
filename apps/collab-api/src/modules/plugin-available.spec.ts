import { describe, expect, it } from 'vitest';
import { publicAvailablePlugin } from './plugin-package';

const now = new Date('2026-06-12T00:00:00.000Z');
const files = [
  { path: 'manifest.json', content: '{}' },
  { path: 'ui/index.html', content: '<div>timer</div>' },
];
const manifest = {
  id: 'timer',
  name: '番茄钟',
  version: '0.1.0',
  description: '可配置时长的计时器',
  runtime_type: 'client',
  entry: 'ui/index.html',
  visibility: 'tenant',
  capabilities: [{ kind: 'ui.view', reason: '展示界面', risk: 'low' }],
};

function marketplacePlugin(overrides: Record<string, unknown> = {}) {
  return {
    id: 'market-plugin',
    name: '番茄钟',
    description: '可配置时长的计时器',
    version: '0.1.0',
    entry: 'ui/index.html',
    runtimeType: 'CLIENT',
    status: 'ENABLED',
    visibility: 'PUBLIC',
    teamId: 'author-team',
    authorUserId: 'author-user',
    files,
    manifest,
    capabilities: manifest.capabilities,
    contentHash: 'a'.repeat(64),
    reviewStatus: 'APPROVED',
    reviewReason: 'internal note',
    reviewedById: 'admin-1',
    reviewedAt: now,
    marketplace: true,
    priceCents: 0,
    installCount: 0,
    ratingCount: 0,
    ratingSum: 0,
    createdAt: now,
    updatedAt: now,
    installations: [],
    ...overrides,
  };
}

describe('publicAvailablePlugin marketplace package access', () => {
  it('keeps package files hidden before the current team installs a marketplace plugin', () => {
    const plugin = publicAvailablePlugin(marketplacePlugin(), 'team-1');

    expect(plugin.source).toBe('marketplace');
    expect(plugin.files).toBeUndefined();
    expect(plugin.manifest).toBeUndefined();
  });

  it('returns package files after the current team installs a marketplace plugin', () => {
    const plugin = publicAvailablePlugin(
      marketplacePlugin({ installations: [{ id: 'install-1' }] }),
      'team-1',
    );

    expect(plugin.source).toBe('marketplace');
    expect(plugin.files).toEqual(files);
    expect(plugin.manifest).toEqual(manifest);
    expect(plugin.reviewReason).toBeUndefined();
    expect(plugin.reviewedById).toBeUndefined();
  });
});
