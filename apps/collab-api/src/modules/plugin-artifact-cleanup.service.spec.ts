import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupStaging } from './plugin-artifact-cleanup.service';

describe('cleanupStaging', () => {
  it('removes expired upload and legacy migration temp directories only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-staging-cleanup-'));
    await mkdir(join(root, 'upload-expired'));
    await mkdir(join(root, 'legacy-plugin-v4-expired'));
    await mkdir(join(root, 'unrelated'));
    try {
      // 阈值不能贴着 0 取（原来是 -1）：Windows 上 Date.now() 的粒度比 NTFS 时间戳粗，
      // 刚 mkdir 出来的目录 mtimeMs 可能比 Date.now() 大 1~2ms，导致「已过期」判据偶发失败、
      // 清理数从 2 掉到 0。留出秒级余量，语义仍是「全部视为过期」。
      await expect(cleanupStaging(root, -60_000)).resolves.toBe(2);
      await expect(readdir(root)).resolves.toEqual(['unrelated']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
