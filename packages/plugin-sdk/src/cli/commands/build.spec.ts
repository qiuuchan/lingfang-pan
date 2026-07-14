// build 命令测试（见 implement.md §6）。
// 覆盖：summarizer 构建成功、--out 指定输出、不存在目录、非法 manifest。
import { describe, it, expect, afterEach } from 'vitest';
import { buildCommand, type BuildResult } from './build.ts';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

// ── helpers ──────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const summarizerPath = path.join(repoRoot, 'plugins', 'summarizer');

const CLEANUP_DIRS: string[] = [];

afterEach(async () => {
  for (const dir of CLEANUP_DIRS.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'plugin-sdk-build-'));
  CLEANUP_DIRS.push(dir);
  return dir;
}

async function runBuild(dir: string, opts?: { out?: string; json?: boolean }): Promise<{ exitCode: number; result?: BuildResult }> {
  const originalStdout = process.stdout.write;
  let captured = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;

  let exitCode: number;
  try {
    exitCode = await buildCommand([], { path: dir, json: true, ...opts });
  } finally {
    process.stdout.write = originalStdout;
  }

  try {
    const result = JSON.parse(captured) as BuildResult;
    return { exitCode, result };
  } catch {
    return { exitCode };
  }
}

// ── 合法插件构建成功 ─────────────────────────────────────────────────

describe('buildCommand — summarizer 打包成功', () => {
  it('summarizer 插件打包为 .lfplugin', async () => {
    const outDir = await tempDir();
    const outFile = path.join(outDir, 'summarizer.lfplugin');

    const { exitCode, result } = await runBuild(summarizerPath, { out: outFile });

    expect(exitCode).toBe(0);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(true);
    expect(result!.outputPath).toBe(path.resolve(outFile));
    expect(result!.sizeBytes).toBeGreaterThan(0);
    expect(result!.fileCount).toBeGreaterThanOrEqual(3); // _meta.json + manifest.json + at least 1 source
    expect(result!.sha256Prefix).toHaveLength(16);
    expect(result!.errors).toHaveLength(0);

    // 验证输出文件是合法 ZIP
    const zipData = await readFile(outFile);
    const zip = await JSZip.loadAsync(zipData);

    // _meta.json 内容校验
    const metaFile = zip.file('_meta.json');
    expect(metaFile).not.toBeNull();
    const metaContent = await metaFile!.async('string');
    expect(metaContent).toBe('{"format":"lingfang-plugin","formatVersion":4}');

    // manifest.json 存在
    const manifestFile = zip.file('manifest.json');
    expect(manifestFile).not.toBeNull();
    const manifestContent = await manifestFile!.async('string');
    const manifestParsed = JSON.parse(manifestContent);
    expect(manifestParsed.id).toBe('com.lingfang.summarizer');
  });
});

// ── --out 指定输出文件名 ─────────────────────────────────────────────

describe('buildCommand — --out 自定义输出', () => {
  it('--out 自定义输出路径生效', async () => {
    const outDir = await tempDir();
    const customOut = path.join(outDir, 'custom.lfplugin');

    const { exitCode, result } = await runBuild(summarizerPath, { out: customOut });

    expect(exitCode).toBe(0);
    expect(result!.ok).toBe(true);
    expect(result!.outputPath).toBe(path.resolve(customOut));
  });
});

// ── 不存在的目录 ─────────────────────────────────────────────────────

describe('buildCommand — manifest_not_found', () => {
  it('空目录 / 不存在目录 → 错误', async () => {
    const dir = await tempDir();

    const { exitCode, result } = await runBuild(dir);

    expect(exitCode).toBe(1);
    expect(result!.ok).toBe(false);
    expect(result!.errors).toHaveLength(1);
    expect(result!.errors[0].code).toBe('manifest_not_found');
  });
});

// ── 非法 manifest ────────────────────────────────────────────────────

describe('buildCommand — manifest_invalid_json', () => {
  it('manifest.json 包含非法 JSON → 错误', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'manifest.json'), '{ bad json }');

    const { exitCode, result } = await runBuild(dir);

    expect(exitCode).toBe(1);
    expect(result!.ok).toBe(false);
    expect(result!.errors[0].code).toBe('manifest_invalid_json');
  });
});

// ── 入口文件缺失 ─────────────────────────────────────────────────────

describe('buildCommand — entry_not_found', () => {
  it('manifest 合法但入口文件缺失 → 错误', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'com.test.plugin',
        name: 'Test',
        version: '1.0.0',
        description: '',
        runtime_type: 'client',
        entry: 'ui/missing.html',
        visibility: 'tenant',
        capabilities: [],
      }),
    );

    const { exitCode, result } = await runBuild(dir);

    expect(exitCode).toBe(1);
    expect(result!.ok).toBe(false);
    expect(result!.errors[0].code).toBe('entry_not_found');
  });
});

// ── manifest 校验失败 ────────────────────────────────────────────────

describe('buildCommand — manifest_validation_failed', () => {
  it('version 不是合法 semver → 拒绝', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'com.test.plugin',
        name: 'Test',
        version: '0.1', // 非法 semver
        description: '',
        runtime_type: 'client',
        entry: 'index.html',
        visibility: 'tenant',
        capabilities: [],
      }),
    );

    const { exitCode, result } = await runBuild(dir);

    expect(exitCode).toBe(1);
    expect(result!.ok).toBe(false);
    expect(result!.errors[0].code).toBe('manifest_validation_failed');
  });
});
