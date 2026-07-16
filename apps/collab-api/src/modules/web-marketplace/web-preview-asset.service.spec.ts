import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plugin-artifact', async () => {
  const original = await vi.importActual<typeof import('../plugin-artifact')>('../plugin-artifact');
  return { ...original, readPluginArtifactEntry: vi.fn(async (_path: string, entry: string) => Buffer.from(`asset:${entry}`)) };
});

import { PLUGIN_AI_POLICY_VERSION } from '../plugin-ai-policy';
import { WebPreviewAssetService } from './web-preview-asset.service';

function row(overrides: Record<string, unknown> = {}) {
  const artifactSha256 = createHash('sha256').update('zip').digest('hex');
  return {
    id: '11111111-1111-4111-8111-111111111111',
    packageId: '22222222-2222-4222-8222-222222222222',
    releaseSha256: artifactSha256,
    mode: 'CLIENT_SANDBOX',
    expiresAt: new Date(Date.now() + 60_000),
    release: {
      id: '33333333-3333-4333-8333-333333333333',
      packageId: '22222222-2222-4222-8222-222222222222',
      sha256: artifactSha256,
      artifactKey: 'pkg/1.0.0/hash.lfplugin',
      manifest: { runtime_type: 'client', entry: 'ui/index.html' },
      fileManifest: [{ path: 'ui/index.html', sizeBytes: 'asset:ui/index.html'.length }, { path: 'ui/app.js', sizeBytes: 'asset:ui/app.js'.length }],
      status: 'PUBLISHED',
      marketReviewStatus: 'APPROVED',
      aiPolicyVersion: PLUGIN_AI_POLICY_VERSION,
      aiPolicyStatus: 'PASSED',
      package: {
        governanceStatus: 'ACTIVE',
        listing: { status: 'ACTIVE', currentReleaseId: '33333333-3333-4333-8333-333333333333' },
      },
    },
    ...overrides,
  };
}

describe('WebPreviewAssetService', () => {
  beforeEach(() => { delete process.env.CLIENT_PLUGIN_PREVIEW_ENABLED; });

  it('reads only a session-bound file from the exact current approved client release', async () => {
    const download = vi.fn(async () => ({ kind: 'stream' as const, stream: Readable.from('zip'), sizeBytes: 3 }));
    const service = new WebPreviewAssetService(
      { webPreviewSession: { findFirst: vi.fn(async () => row()) } } as never,
      { download } as never,
    );
    await expect(service.read(row().id, 'ui/app.js')).resolves.toMatchObject({
      body: Buffer.from('asset:ui/app.js'),
      contentType: 'text/javascript; charset=utf-8',
      isEntry: false,
      entryPath: 'ui/index.html',
    });
    expect(download).toHaveBeenCalledWith('pkg/1.0.0/hash.lfplugin');
  });

  it('rejects files outside the reviewed file manifest without reading the artifact', async () => {
    const download = vi.fn();
    const service = new WebPreviewAssetService(
      { webPreviewSession: { findFirst: vi.fn(async () => row()) } } as never,
      { download } as never,
    );
    await expect(service.read(row().id, '../secret')).rejects.toMatchObject({ status: 404 });
    expect(download).not.toHaveBeenCalled();
  });

  it('revokes resource access when the listing no longer points at the session release', async () => {
    const stale = row();
    stale.release.package.listing.currentReleaseId = '44444444-4444-4444-8444-444444444444';
    const service = new WebPreviewAssetService(
      { webPreviewSession: { findFirst: vi.fn(async () => stale) } } as never,
      { download: vi.fn() } as never,
    );
    await expect(service.read(stale.id, undefined)).rejects.toMatchObject({ status: 410, code: 'web_preview_release_unavailable' });
  });

  it('fails closed when stored artifact bytes no longer match the reviewed release sha256', async () => {
    const corrupted = row();
    corrupted.releaseSha256 = 'f'.repeat(64);
    corrupted.release.sha256 = 'f'.repeat(64);
    const service = new WebPreviewAssetService(
      { webPreviewSession: { findFirst: vi.fn(async () => corrupted) } } as never,
      { download: vi.fn(async () => ({ kind: 'stream' as const, stream: Readable.from('zip'), sizeBytes: 3 })) } as never,
    );
    await expect(service.read(corrupted.id, undefined)).rejects.toMatchObject({ status: 410, code: 'web_preview_artifact_mismatch' });
  });
});
