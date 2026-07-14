import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactUnavailableError, FilesystemArtifactStore } from './artifact-store';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe('FilesystemArtifactStore', () => {
  it('promotes a staged artifact and streams it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const staged = join(root, 'staged');
    await writeFile(staged, 'artifact');
    const store = new FilesystemArtifactStore(join(root, 'permanent'));
    await store.promote(staged, 'package/1.0.0/hash.lfplugin', 'unused');
    const download = await store.download('package/1.0.0/hash.lfplugin');
    expect(download.kind).toBe('stream');
    expect(await readFile(join(root, 'permanent/package/1.0.0/hash.lfplugin'), 'utf8')).toBe('artifact');
    await rm(root, { recursive: true, force: true });
  });

  it('copies to a target-side staging file when the initial rename crosses filesystems', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const staged = join(root, 'staged');
    await writeFile(staged, 'artifact');
    const store = new FilesystemArtifactStore(join(root, 'permanent'));
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));

    await store.promote(staged, 'package/1.0.0/hash.lfplugin', 'unused');

    expect(await readFile(join(root, 'permanent/package/1.0.0/hash.lfplugin'), 'utf8')).toBe('artifact');
    await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(root, { recursive: true, force: true });
  });

  it('rejects artifact keys that escape the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const store = new FilesystemArtifactStore(root);
    await expect(store.download('../escape')).rejects.toThrow(/Invalid artifact key/);
    await rm(root, { recursive: true, force: true });
  });

  it('throws ArtifactUnavailableError when the artifact file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const store = new FilesystemArtifactStore(root);
    await expect(store.download('pkg/1.0.0/missing.lfplugin')).rejects.toBeInstanceOf(ArtifactUnavailableError);
    await rm(root, { recursive: true, force: true });
  });

  it('removes old unreferenced artifacts while retaining referenced keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const store = new FilesystemArtifactStore(root);
    const first = join(root, 'first');
    const second = join(root, 'second');
    await writeFile(first, 'one'); await writeFile(second, 'two');
    await store.promote(first, 'pkg/1/a.lfplugin', 'unused');
    await store.promote(second, 'pkg/2/b.lfplugin', 'unused');
    expect(await store.cleanupOrphans(new Set(['pkg/2/b.lfplugin']), -1)).toBe(1);
    expect(await readFile(join(root, 'pkg/2/b.lfplugin'), 'utf8')).toBe('two');
    await rm(root, { recursive: true, force: true });
  });
});
