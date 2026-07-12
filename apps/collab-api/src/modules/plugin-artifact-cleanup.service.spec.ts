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
      await expect(cleanupStaging(root, -1)).resolves.toBe(2);
      await expect(readdir(root)).resolves.toEqual(['unrelated']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
