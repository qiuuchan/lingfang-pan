// adapt 引擎单测：聚焦确定性校验 + 改造（A1-A5）的纯逻辑，以及编排器闭环。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptWorkspace } from '../workspace.ts';
import { validateWorkspace } from '../validate.ts';
import { applyTransforms, transformMissingFields, transformEntry, transformCapabilities, transformAiBoundary } from '../transform.ts';
import { runAdaptation, validateOnly } from '../index.ts';

let root: string;
function makePlugin(files: Record<string, string>): string {
  const dir = mkdtempSync(join(root, 'p-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'adapt-test-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('validateWorkspace', () => {
  it('缺 manifest 时返回 needs_human 问题且不抛错', () => {
    const dir = makePlugin({ 'index.js': 'console.log(1)' });
    const ws = new AdaptWorkspace(dir);
    const issues = validateWorkspace(ws);
    expect(issues.some((i) => i.code === 'manifest_not_found')).toBe(true);
  });

  it('entry 缺失标记为可自动修复', () => {
    const dir = makePlugin({
      'manifest.json': JSON.stringify({ id: 'demo', name: 'demo', version: '0.1.0', runtime_type: 'nodejs', entry: 'missing.js', capabilities: [] }),
    });
    const ws = new AdaptWorkspace(dir);
    const issues = validateWorkspace(ws);
    const e = issues.find((i) => i.code === 'entry_not_found');
    expect(e).toBeDefined();
    expect(e?.fixable).toBe(true);
  });

  it('检测到硬编码 base URL 标为 ai_boundary 可修复', () => {
    const dir = makePlugin({
      'manifest.json': JSON.stringify({ id: 'demo', name: 'demo', version: '0.1.0', runtime_type: 'nodejs', entry: 'index.js', capabilities: [] }),
      'index.js': "const c = new OpenAI({ baseURL: 'https://api.openai.com/v1' });",
    });
    const ws = new AdaptWorkspace(dir);
    const issues = validateWorkspace(ws);
    expect(issues.some((i) => i.code === 'hardcoded_base_url')).toBe(true);
  });
});

describe('transform A1 缺字段补齐', () => {
  it('从 name 生成 id，缺 runtime/entry/version 给默认值', () => {
    const dir = makePlugin({ 'manifest.json': JSON.stringify({ name: 'My Cool Plugin', capabilities: [] }) });
    const ws = new AdaptWorkspace(dir);
    const manifest = ws.readManifest();
    const fixes = transformMissingFields(ws, manifest);
    ws.writeManifest(manifest);
    expect(manifest.id).toMatch(/^[a-z]/);
    expect(manifest.runtime_type).toBe('client');
    expect(manifest.entry).toBe('ui/index.html');
    expect(manifest.version).toBe('0.1.0');
    expect(fixes.length).toBeGreaterThanOrEqual(4);
  });
});

describe('transform A2 entry/runtime', () => {
  it('entry 文件不存在但默认 ui/index.html 存在时指向它', () => {
    const dir = makePlugin({
      'manifest.json': JSON.stringify({ id: 'demo', name: 'demo', version: '0.1.0', runtime_type: 'client', entry: 'wrong.html', capabilities: [] }),
      'ui/index.html': '<!doctype html><html></html>',
    });
    const ws = new AdaptWorkspace(dir);
    const manifest = ws.readManifest();
    transformEntry(ws, manifest);
    ws.writeManifest(manifest);
    expect(manifest.entry).toBe('ui/index.html');
  });
});

describe('transform A3 能力自动探测', () => {
  it('扫描到 fetch 与桥接 → 补 net.fetch / llm.chat', () => {
    const dir = makePlugin({
      'manifest.json': JSON.stringify({ id: 'demo', name: 'demo', version: '0.1.0', runtime_type: 'nodejs', entry: 'index.js', capabilities: [] }),
      'index.js': "fetch('https://x'); const u = process.env.LINGFANG_PLUGIN_BRIDGE_URL;",
    });
    const ws = new AdaptWorkspace(dir);
    const manifest = ws.readManifest();
    transformCapabilities(ws, manifest);
    const kinds = (manifest.capabilities as Array<{ kind: string }>).map((c) => c.kind);
    expect(kinds).toContain('net.fetch');
    expect(kinds).toContain('llm.chat');
  });
});

describe('transform A4 AI 边界归一化', () => {
  it('把硬编码 base URL 改写为桥接模式，保留 diff', () => {
    const dir = makePlugin({
      'manifest.json': JSON.stringify({ id: 'demo', name: 'demo', version: '0.1.0', runtime_type: 'nodejs', entry: 'index.js', capabilities: [] }),
      'index.js': "const c = new OpenAI({ baseURL: 'https://api.openai.com/v1' });",
    });
    const ws = new AdaptWorkspace(dir);
    const manifest = ws.readManifest();
    const fixes = transformAiBoundary(ws, manifest);
    const next = ws.readFile('index.js') ?? '';
    expect(next).toContain("process.env.LINGFANG_PLUGIN_BRIDGE_URL + '/v1'");
    expect(next).not.toContain('api.openai.com');
    expect(fixes.some((f) => f.code === 'A4_base_url' && f.diff)).toBe(true);
  });
});

describe('runAdaptation 闭环（不执行）', () => {
  it('对问题插件应用自动改造并产生 fixesApplied', async () => {
    const dir = makePlugin({
      'manifest.json': JSON.stringify({ name: 'My Plugin', version: '0.1.0', runtime_type: 'nodejs', entry: 'index.js', capabilities: [] }),
      'index.js': "fetch('https://x'); const c = new OpenAI({ baseURL: 'https://api.openai.com/v1' });",
    });
    const result = await runAdaptation({ pluginDir: dir });
    expect(result.fixesApplied.length).toBeGreaterThan(0);
    // A1 补齐 id，A3/A4 应有改造
    expect(result.fixesApplied.some((f) => f.code === 'A1_id')).toBe(true);
    expect(result.fixesApplied.some((f) => f.code === 'A4_base_url')).toBe(true);
    // 用户源码未被改动（id 不应被写回原 manifest）
    const orig = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
    expect(orig.id).toBeUndefined();
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
  });

  it('validateOnly 不改造，仅报告', async () => {
    const dir = makePlugin({
      'manifest.json': JSON.stringify({ name: 'My Plugin', runtime_type: 'nodejs', entry: 'index.js', capabilities: [] }),
    });
    const report = await validateOnly(dir);
    expect(report.fixesApplied.length).toBe(0);
    expect(report.issues.length).toBeGreaterThan(0);
  });
});
