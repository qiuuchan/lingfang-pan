// adapt 引擎单测：聚焦确定性校验 + 改造（A1-A5）的纯逻辑，以及编排器闭环。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptWorkspace } from '../workspace.ts';
import { validateWorkspace } from '../validate.ts';
import { applyTransforms, transformMissingFields, transformEntry, transformCapabilities, transformAiBoundary } from '../transform.ts';
import { runAdaptation, validateOnly } from '../index.ts';
import { buildReport } from '../report.ts';

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
    // readManifest 对损坏 JSON 返回 null；正常解析后非空（A1 的目标就是这种缺字段 manifest）。
    const manifest = ws.readManifest();
    expect(manifest).not.toBeNull();
    if (!manifest) return;
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
    expect(manifest).not.toBeNull();
    if (!manifest) return;
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
    expect(manifest).not.toBeNull();
    if (!manifest) return;
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
    expect(manifest).not.toBeNull();
    if (!manifest) return;
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

  it('纯静态校验即使零问题也只报 NOT_RUN', async () => {
    // status 会随发布落库成为审核依据，dry-run 不能冒充跑过流水线。
    const clean = makePlugin({
      'manifest.json': JSON.stringify({ id: 'demo', name: 'demo', version: '0.1.0', runtime_type: 'client', entry: 'ui/index.html', capabilities: [], visibility: 'private' }),
      'ui/index.html': '<!doctype html><html></html>',
    });
    const report = await validateOnly(clean);
    expect(report.status).toBe('NOT_RUN');
    expect(report.summary).toContain('未执行改造');
  });

  it('改造后无残留问题时报 ADAPTED_PASSED', async () => {
    const dir = makePlugin({
      'manifest.json': JSON.stringify({ name: 'My Plugin', version: '0.1.0', runtime_type: 'nodejs', entry: 'index.js', capabilities: [] }),
      'index.js': "fetch('https://x');",
    });
    const result = await runAdaptation({ pluginDir: dir });
    expect(result.remaining).toHaveLength(0);
    expect(result.status).toBe('ADAPTED_PASSED');
  });

  it('每次改造都落在独立的临时工作区，不撞名也不复用', async () => {
    const files = {
      'manifest.json': JSON.stringify({ name: 'Same Plugin', version: '0.1.0', runtime_type: 'nodejs', entry: 'index.js', capabilities: [] }),
      'index.js': 'export default 1;',
    };
    const [a, b] = await Promise.all([
      runAdaptation({ pluginDir: makePlugin(files) }),
      runAdaptation({ pluginDir: makePlugin(files) }),
    ]);
    expect(a.workspaceDir).not.toBe(b.workspaceDir);
  });

  it('源目录不存在时明确报错而不是产出空报告', async () => {
    await expect(runAdaptation({ pluginDir: join(root, 'definitely-missing') })).rejects.toThrow(
      /插件目录不存在/
    );
  });
});

describe('buildReport 状态判定', () => {
  const issue = (severity: 'needs_human' | 'auto_fixable' | 'fixed') => ({
    code: 'X',
    category: 'manifest' as const,
    severity,
    message: 'm',
    fixable: severity === 'auto_fixable',
  });

  it('跑过流水线但残留需人工项 → NEEDS_HUMAN', () => {
    expect(
      buildReport({ issues: [issue('needs_human')], fixesApplied: [], adapted: true }).status
    ).toBe('NEEDS_HUMAN');
  });

  it('跑过流水线但仍有没修掉的可修项 → ADAPTED_FAILED', () => {
    expect(
      buildReport({ issues: [issue('auto_fixable')], fixesApplied: [], adapted: true }).status
    ).toBe('ADAPTED_FAILED');
  });

  it('执行了运行时确证却没跑起来 → ADAPTED_FAILED', () => {
    expect(
      buildReport({
        issues: [issue('fixed')],
        fixesApplied: [],
        adapted: true,
        executed: true,
        canRun: false,
      }).status
    ).toBe('ADAPTED_FAILED');
  });

  it('执行确证且跑起来了 → ADAPTED_PASSED', () => {
    expect(
      buildReport({
        issues: [],
        fixesApplied: [],
        adapted: true,
        executed: true,
        canRun: true,
      }).status
    ).toBe('ADAPTED_PASSED');
  });
});

describe('P1 GitHub 导入清单合成（覆盖而非沿用）', () => {
  it('无 manifest 的 python 仓库 → 合成 runtime=python 且 name 取目录名', async () => {
    const dir = makePlugin({ 'main.py': 'print("hi")' });
    const result = await runAdaptation({ pluginDir: dir });
    const syn = JSON.parse(readFileSync(join(result.workspaceDir, 'manifest.json'), 'utf-8'));
    expect(syn.runtime_type).toBe('python');
    // name 缺省取工作区目录名（无 package.json.name 时）；此处工作区即临时拷贝目录。
    expect(syn.name).toBe(result.workspaceDir.split(/[\\/]/).pop());
    expect(syn.version).toBe('0.1.0');
    expect(typeof syn.id).toBe('string');
  });

  it('有 package.json(scripts.start) 的仓库 + forceReDerive → 合成 runtime=nodejs', async () => {
    const dir = makePlugin({
      'package.json': JSON.stringify({ name: 'demo-app', scripts: { start: 'node index.js' } }),
      'index.js': 'console.log(1)',
    });
    const result = await runAdaptation({ pluginDir: dir, forceReDerive: true });
    const syn = JSON.parse(readFileSync(join(result.workspaceDir, 'manifest.json'), 'utf-8'));
    expect(syn.runtime_type).toBe('nodejs');
    expect(syn.name).toBe('demo-app');
  });

  it('forceReDerive 覆盖仓库自带的错误 manifest 运行时', async () => {
    const dir = makePlugin({
      'manifest.json': JSON.stringify({ id: 'x', name: 'x', version: '0.1.0', runtime_type: 'python', entry: 'main.py', capabilities: [] }),
      'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node' } }),
      'index.js': '1',
    });
    const result = await runAdaptation({ pluginDir: dir, forceReDerive: true });
    const syn = JSON.parse(readFileSync(join(result.workspaceDir, 'manifest.json'), 'utf-8'));
    expect(syn.runtime_type).toBe('nodejs');
    expect(syn.entry).toBe('index.js');
  });

  it('非 forceReDerive 时沿用仓库自带 manifest 的运行时（不破坏既有插件）', async () => {
    const dir = makePlugin({
      'manifest.json': JSON.stringify({ id: 'x', name: 'x', version: '0.1.0', runtime_type: 'python', entry: 'main.py', capabilities: [] }),
      'main.py': 'print(1)',
    });
    const result = await runAdaptation({ pluginDir: dir });
    const syn = JSON.parse(readFileSync(join(result.workspaceDir, 'manifest.json'), 'utf-8'));
    expect(syn.runtime_type).toBe('python');
  });
});

describe('validateWorkspace manifest 缺失', () => {
  it('缺 manifest 时 manifest_not_found 标记为可自动修复', () => {
    const dir = makePlugin({ 'index.js': 'console.log(1)' });
    const ws = new AdaptWorkspace(dir);
    const issues = validateWorkspace(ws);
    const m = issues.find((i) => i.code === 'manifest_not_found');
    expect(m).toBeDefined();
    expect(m?.fixable).toBe(true);
    expect(m?.severity).toBe('auto_fixable');
  });

  it('缺 manifest 时仍执行 AI 边界扫描（不漏报硬编码凭据）', () => {
    const dir = makePlugin({
      'index.js': "const k = 'sk-abcdefghijklmnopqrstuvwx';",
    });
    const ws = new AdaptWorkspace(dir);
    const issues = validateWorkspace(ws);
    expect(issues.some((i) => i.code === 'manifest_not_found')).toBe(true);
    expect(issues.some((i) => i.code === 'leaked_openai_key')).toBe(true);
  });
});
