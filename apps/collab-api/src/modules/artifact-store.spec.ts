import { Logger } from '@nestjs/common';
import { mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactUnavailableError, FilesystemArtifactStore } from './artifact-store';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    readdir: vi.fn(actual.readdir),
    stat: vi.fn(actual.stat),
  };
});

/** 构造带 errno code 的 I/O 故障，模拟 EACCES/EBUSY 这类「读不动」而非「不存在」的错误。 */
function ioError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

afterEach(() => {
  // mockReset 会把实现还原成 vi.fn(actual.x) 传入的原始实现，并清空未被消费的 *Once 队列，
  // 防止某条用例注入的故障泄漏到下一条用例。
  vi.mocked(rename).mockReset();
  vi.mocked(readdir).mockReset();
  vi.mocked(stat).mockReset();
  vi.restoreAllMocks();
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
    expect(await readFile(join(root, 'permanent/package/1.0.0/hash.lfplugin'), 'utf8')).toBe(
      'artifact'
    );
    await rm(root, { recursive: true, force: true });
  });

  it('copies to a target-side staging file when the initial rename crosses filesystems', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const staged = join(root, 'staged');
    await writeFile(staged, 'artifact');
    const store = new FilesystemArtifactStore(join(root, 'permanent'));
    vi.mocked(rename).mockRejectedValueOnce(ioError('EXDEV', 'cross-device link'));

    await store.promote(staged, 'package/1.0.0/hash.lfplugin', 'unused');

    expect(await readFile(join(root, 'permanent/package/1.0.0/hash.lfplugin'), 'utf8')).toBe(
      'artifact'
    );
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
    await expect(store.download('pkg/1.0.0/missing.lfplugin')).rejects.toBeInstanceOf(
      ArtifactUnavailableError
    );
    await rm(root, { recursive: true, force: true });
  });

  // 反向用例：download 的 stat 兜底只允许把 ENOENT 翻译成「制品不存在」。
  // 若 isMissingPathError 被放宽（例如兜底改回 return null / 认所有 error），
  // EACCES 会被当成「文件已被清理」映射成 HTTP 410，制品被误判为永久丢失。
  it('rethrows non-ENOENT stat failures on download instead of reporting the artifact as missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const store = new FilesystemArtifactStore(root);
    const blocked = 'pkg/1.0.0/blocked.lfplugin';
    await writeFile(join(root, 'staged'), 'artifact');
    await store.promote(join(root, 'staged'), blocked, 'unused');
    vi.mocked(stat).mockRejectedValueOnce(ioError('EACCES', 'permission denied'));

    const error = await store.download(blocked).then(
      () => null,
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ArtifactUnavailableError);
    expect((error as Error).message).toMatch(/读取制品失败/);
    expect((error as Error).cause).toMatchObject({ code: 'EACCES' });
    await rm(root, { recursive: true, force: true });
  });

  // 反向用例：扫描目录失败必须炸出来，不能被伪装成「清理了 0 个」。
  it('propagates non-ENOENT readdir failures during cleanup instead of reporting zero orphans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const store = new FilesystemArtifactStore(root);
    const loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.mocked(readdir).mockRejectedValueOnce(ioError('EBUSY', 'resource busy or locked'));

    const error = await store.cleanupOrphans(new Set(), 60_000).then(
      (removed) => ({ removed }),
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/扫描制品目录失败/);
    expect((error as Error).cause).toMatchObject({ code: 'EBUSY' });
    expect(loggerError).toHaveBeenCalled();
    await rm(root, { recursive: true, force: true });
  });

  // 反向用例：单个制品 stat 失败（非 ENOENT）同样必须上抛，且不得把该制品当成「已不存在」跳过。
  it('propagates non-ENOENT stat failures for a scanned artifact and leaves the file untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const store = new FilesystemArtifactStore(root);
    const staged = join(root, 'staged');
    await writeFile(staged, 'one');
    await store.promote(staged, 'pkg/1/a.lfplugin', 'unused');
    const loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.mocked(stat).mockRejectedValueOnce(ioError('EACCES', 'permission denied'));

    const error = await store.cleanupOrphans(new Set(), 60_000).then(
      (removed) => ({ removed }),
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/读取制品状态失败/);
    expect((error as Error).cause).toMatchObject({ code: 'EACCES' });
    expect(loggerError).toHaveBeenCalled();
    expect(await readFile(join(root, 'pkg/1/a.lfplugin'), 'utf8')).toBe('one');
    await rm(root, { recursive: true, force: true });
  });

  // 正向兜底：ENOENT 仍必须保持宽容，否则首次部署（制品根目录尚未创建）就会把清理任务打挂。
  it('treats a missing artifact root as zero orphans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    await rm(root, { recursive: true, force: true });
    const store = new FilesystemArtifactStore(root);
    await expect(store.cleanupOrphans(new Set(), 60_000)).resolves.toBe(0);
  });

  // 正向兜底：并发清理抢先删掉文件（stat 报 ENOENT）属正常竞态，跳过而非抛错。
  it('skips artifacts that vanish between listing and stat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const store = new FilesystemArtifactStore(root);
    const staged = join(root, 'staged');
    await writeFile(staged, 'one');
    await store.promote(staged, 'pkg/1/a.lfplugin', 'unused');
    vi.mocked(stat).mockRejectedValueOnce(ioError('ENOENT', 'no such file or directory'));

    await expect(store.cleanupOrphans(new Set(), 60_000)).resolves.toBe(0);
    await rm(root, { recursive: true, force: true });
  });

  it('removes old unreferenced artifacts while retaining referenced keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const store = new FilesystemArtifactStore(root);
    const first = join(root, 'first');
    const second = join(root, 'second');
    await writeFile(first, 'one');
    await writeFile(second, 'two');
    await store.promote(first, 'pkg/1/a.lfplugin', 'unused');
    await store.promote(second, 'pkg/2/b.lfplugin', 'unused');
    // 显式把两个制品的 mtime 推到一小时前，再配正阈值 60s；
    // 不再用负阈值贴 0 边界（负数写法会让「时间窗口」这条语义完全不受测，且贴阈值易 flake）。
    const stale = new Date(Date.now() - 3_600_000);
    await utimes(join(root, 'pkg/1/a.lfplugin'), stale, stale);
    await utimes(join(root, 'pkg/2/b.lfplugin'), stale, stale);

    expect(await store.cleanupOrphans(new Set(['pkg/2/b.lfplugin']), 60_000)).toBe(1);
    expect(await readFile(join(root, 'pkg/2/b.lfplugin'), 'utf8')).toBe('two');
    await rm(root, { recursive: true, force: true });
  });

  it('keeps unreferenced artifacts that are younger than the age threshold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-store-'));
    const store = new FilesystemArtifactStore(root);
    const staged = join(root, 'staged');
    await writeFile(staged, 'fresh');
    await store.promote(staged, 'pkg/3/c.lfplugin', 'unused');

    expect(await store.cleanupOrphans(new Set(), 3_600_000)).toBe(0);
    expect(await readFile(join(root, 'pkg/3/c.lfplugin'), 'utf8')).toBe('fresh');
    await rm(root, { recursive: true, force: true });
  });
});
