import { describe, expect, it } from 'vitest';
import {
  buildFallbackEntryHtml,
  buildLocalDraft,
  cleanPathFrontend,
  normalizeCapabilities,
  parseStructuredPackage,
} from './plugin-draft';

// === cleanPathFrontend：与后端 plugin-package.ts:61-69 cleanPath 对齐 ===

describe('cleanPathFrontend', () => {
  it('合法相对路径通过', () => {
    expect(cleanPathFrontend('ui/index.html')).toEqual({ ok: true, value: 'ui/index.html' });
  });

  it('把反斜杠归一为正斜杠', () => {
    expect(cleanPathFrontend('ui\\index.html')).toEqual({ ok: true, value: 'ui/index.html' });
  });

  it('拒绝绝对路径（前导 /）', () => {
    expect(cleanPathFrontend('/etc/passwd')).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('拒绝 home 前缀（~）', () => {
    expect(cleanPathFrontend('~/secret')).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('拒绝 Windows 盘符绝对路径', () => {
    expect(cleanPathFrontend('C:/Windows/system32')).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('拒绝包含 .. 的路径穿越', () => {
    expect(cleanPathFrontend('../../../etc/passwd')).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('拒绝空段', () => {
    expect(cleanPathFrontend('ui//index.html')).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('拒绝 . 当前目录段', () => {
    expect(cleanPathFrontend('./ui/index.html')).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('拒绝隐藏段（以 . 开头）', () => {
    expect(cleanPathFrontend('.env')).toEqual({ ok: false, reason: expect.any(String) });
    expect(cleanPathFrontend('ui/.hidden')).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('拒绝空字符串', () => {
    expect(cleanPathFrontend('')).toEqual({ ok: false, reason: expect.any(String) });
    expect(cleanPathFrontend('   ')).toEqual({ ok: false, reason: expect.any(String) });
  });
});

// === normalizeCapabilities：契约收敛 ===

describe('normalizeCapabilities', () => {
  it('合法对象数组：原样规范化（risk 缺省补 low）', () => {
    const out = normalizeCapabilities([{ kind: 'code-assistant.run', reason: '执行', requires_admin: false }]);
    expect(out).toEqual([
      { kind: 'code-assistant.run', reason: '执行', risk: 'low', requires_admin: false },
    ]);
  });

  it('保留合法 risk 取值', () => {
    const out = normalizeCapabilities([{ kind: 'ui.view', risk: 'high' }]);
    expect(out[0].risk).toBe('high');
  });

  it('非法 risk 兜底为 low', () => {
    const out = normalizeCapabilities([{ kind: 'ui.view', risk: 'extreme' }]);
    expect(out[0].risk).toBe('low');
  });

  it('字符串数组形态（旧 bug）整体兜底', () => {
    // 关键回归点：绝不保留裸 code-assistant。
    const out = normalizeCapabilities(['code-assistant']);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('code-assistant.run');
  });

  it('含非法 kind 的数组整体兜底', () => {
    const out = normalizeCapabilities([{ kind: 'code-assistant' }, { kind: 'ui.view' }]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('code-assistant.run');
  });

  it('空数组兜底（无能力时不影响后端接受空数组，但产出端给一个默认能力）', () => {
    const out = normalizeCapabilities([]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('code-assistant.run');
  });

  it('非数组兜底', () => {
    expect(normalizeCapabilities(null)).toHaveLength(1);
    expect(normalizeCapabilities(undefined)).toHaveLength(1);
    expect(normalizeCapabilities('code-assistant')).toHaveLength(1);
    expect(normalizeCapabilities({})).toHaveLength(1);
  });

  it('兜底 kind 始终命中白名单，绝不为裸 code-assistant', () => {
    for (const input of [null, undefined, [], ['code-assistant'], [{}], [{ kind: 'bogus' }]]) {
      const out = normalizeCapabilities(input);
      // 转为 string 比较，规避 TS 对 CapabilityKind 字面量类型的过度收窄。
      const kinds = out.map((c) => String(c.kind));
      expect(kinds.every((k) => k !== 'code-assistant')).toBe(true);
      expect(kinds.every((k) => k === 'code-assistant.run')).toBe(true);
    }
  });

  it('保留合法 scope 字段', () => {
    const out = normalizeCapabilities([{ kind: 'fs.read', scope: { paths: ['/tmp'] } }]);
    expect(out[0].scope).toEqual({ paths: ['/tmp'] });
  });
});

// === parseStructuredPackage：design §7.1 五类必测 ===

describe('parseStructuredPackage', () => {
  it('正常：manifest + file(entry) + notes 三块齐全 → status ready', () => {
    const raw = [
      '这是说明文字。',
      '```lingfang-manifest json',
      '{ "id": "pomodoro", "name": "番茄钟", "version": "0.1.0", "description": "计时器",',
      '  "runtime_type": "client", "entry": "ui/index.html", "visibility": "tenant",',
      '  "capabilities": [{ "kind": "code-assistant.run", "reason": "本地执行", "risk": "medium" }] }',
      '```',
      '```file path="ui/index.html"',
      '<!doctype html><div>番茄钟</div>',
      '```',
      '```lingfang-notes',
      '已为你生成番茄钟插件，可在 25/45 分钟间切换。',
      '```',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    expect(parsed.status).toBe('ready');
    expect(parsed.manifest?.id).toBe('pomodoro');
    expect(parsed.manifest?.name).toBe('番茄钟');
    expect(parsed.files.find((f) => f.path === 'ui/index.html')?.content).toContain('番茄钟');
    expect(parsed.notes).toContain('番茄钟插件');
    // capabilities 经契约 zod 校验后保留为合法对象。
    expect(parsed.manifest?.capabilities?.[0]?.kind).toBe('code-assistant.run');
  });

  it('部分缺失：只有 manifest 缺 entry 文件 → status partial', () => {
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "x", "name": "X", "entry": "ui/index.html" }',
      '```',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    expect(parsed.status).toBe('partial');
    expect(parsed.manifest?.id).toBe('x');
    // entry 文件不存在（buildLocalDraft 会补兜底页，parse 层仅判定 partial）。
    expect(parsed.files.find((f) => f.path === 'ui/index.html')).toBeUndefined();
  });

  it('完全失败：纯自然语言无围栏块 → status invalid，manifest null', () => {
    const raw = '我只是写了一段说明，没有任何结构化输出。';
    const parsed = parseStructuredPackage(raw);
    expect(parsed.status).toBe('invalid');
    expect(parsed.manifest).toBeNull();
    expect(parsed.files).toEqual([]);
  });

  it('注入路径：file 块 path 含 .. → 块丢弃 + diagnostics fail', () => {
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "evil", "name": "Evil", "entry": "ui/index.html" }',
      '```',
      '```file path="../../../etc/passwd"',
      'root:x:0:0',
      '```',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    expect(parsed.files.find((f) => f.path.includes('etc') || f.path.includes('passwd'))).toBeUndefined();
    expect(parsed.diagnostics.some((d) => d.stage === 'schema' && d.status === 'fail')).toBe(true);
  });

  it('字符串化 capabilities：manifest 内 capabilities 为字符串数组 → zod 拒绝并记 fail（收敛由 normalizeCapabilities 负责）', () => {
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "y", "name": "Y", "entry": "ui/index.html", "capabilities": ["code-assistant"] }',
      '```',
      '```file path="ui/index.html"',
      '<div></div>',
      '```',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    // 契约 zod 拒绝字符串数组形态 → schema stage 记 fail。
    // 保留原始对象供 buildLocalDraft 的 normalizeCapabilities 兜底（绝不在产出端保留裸 code-assistant）。
    const caps = parsed.manifest?.capabilities as unknown;
    const capsAreObjects = Array.isArray(caps) && caps.every((c) => typeof c === 'object' && c !== null);
    if (!capsAreObjects) {
      // zod 校验失败：必须有 schema fail 诊断。
      expect(parsed.diagnostics.some((d) => d.stage === 'schema' && d.status === 'fail')).toBe(true);
    } else {
      // 若 zod 容忍（理论上不会），capabilities 必为对象数组且 kind 非裸 code-assistant。
      expect(caps.every((c: { kind: string }) => c.kind !== 'code-assistant')).toBe(true);
    }
    // 关键：normalizeCapabilities 独立兜底，绝不保留裸 code-assistant。
    const normalized = normalizeCapabilities(parsed.manifest?.capabilities);
    expect(normalized.every((c) => c.kind === 'code-assistant.run')).toBe(true);
  });

  it('多个 manifest 块取最后一个 + warning', () => {
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "first", "name": "First", "entry": "ui/index.html" }',
      '```',
      '```lingfang-manifest json',
      '{ "id": "second", "name": "Second", "entry": "ui/index.html" }',
      '```',
      '```file path="ui/index.html"',
      '<div></div>',
      '```',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    expect(parsed.manifest?.id).toBe('second');
    expect(parsed.diagnostics.some((d) => d.stage === 'schema' && d.status === 'warn')).toBe(true);
  });

  it('unknown 块候选归类：裸 ```html 块推断为 ui/index.html', () => {
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "z", "name": "Z", "entry": "ui/index.html" }',
      '```',
      '```html',
      '<!doctype html><div>z</div>',
      '```',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    expect(parsed.status).toBe('ready');
    expect(parsed.files.find((f) => f.path === 'ui/index.html')?.content).toContain('doctype');
  });

  it('unknown 块无语言标识且非 html → 命名为 snippet-N', () => {
    const raw = [
      '```',
      'console.log("hi")',
      '```',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    expect(parsed.files.length).toBeGreaterThanOrEqual(1);
    expect(parsed.files.some((f) => f.path.startsWith('snippet-'))).toBe(true);
  });

  it('同 path 的 file 块后者覆盖前者', () => {
    const raw = [
      '```file path="ui/index.html"',
      'version-1',
      '```',
      '```file path="ui/index.html"',
      'version-2',
      '```',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    expect(parsed.files.find((f) => f.path === 'ui/index.html')?.content).toBe('version-2');
  });

  it('围栏嵌套截断：块内含 ``` 时兜底继续解析', () => {
    // 块内出现 ``` 会导致提前结束围栏，剩余文本兜底归入 unknown 继续。
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "n", "name": "N", "entry": "ui/index.html" }',
      '```',
      '```file path="ui/index.html"',
      '<pre>```',
      'nested fence inside',
      '```',
      'trailing text',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    // 不应抛错，应完成解析（可能 partial，取决于截断）。
    expect(parsed.status === 'ready' || parsed.status === 'partial').toBe(true);
  });

  it('未闭合围栏截断：缺结束围栏 → 标记 schema fail 截断诊断', () => {
    // design §3.2.2 步骤1：块未找到结束围栏时标记 schema/fail: 围栏可能被截断。
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "unclosed", "name": "U", "entry": "ui/index.html" }',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    expect(parsed.rawBlocks.some((b) => b.truncated)).toBe(true);
    expect(parsed.diagnostics.some((d) => d.stage === 'schema' && d.status === 'fail' && d.message.includes('截断'))).toBe(true);
  });

  it('字节预算超限：单文件 > 256KB → status invalid', () => {
    const big = 'a'.repeat(260 * 1024);
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "big", "name": "Big", "entry": "ui/index.html" }',
      '```',
      '```file path="ui/index.html"',
      big,
      '```',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    expect(parsed.status).toBe('invalid');
    expect(parsed.diagnostics.some((d) => d.stage === 'schema' && d.status === 'fail')).toBe(true);
  });

  it('manifest 块 JSON 畸形 → manifest null + fail', () => {
    const raw = [
      '```lingfang-manifest json',
      '{ this is not json',
      '```',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    expect(parsed.manifest).toBeNull();
    expect(parsed.status).toBe('invalid');
  });
});

// === buildFallbackEntryHtml ===

describe('buildFallbackEntryHtml', () => {
  it('生成合法 HTML 且包含 notes 片段', () => {
    const html = buildFallbackEntryHtml({ notes: '这是一个番茄钟', manifestName: '番茄钟' });
    expect(html).toContain('<!doctype html>');
    // notes 经 HTML 转义后仍保留可见文本。
    expect(html).toContain('番茄钟');
  });

  it('对 notes 中的 HTML 特殊字符做转义（防注入）', () => {
    const html = buildFallbackEntryHtml({ notes: '<script>alert(1)</script>', manifestName: 'X' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// === buildLocalDraft：端到端产出收敛 ===

// 构造最小 CliProbeResult，stdout 承载协议文本。
function probeWith(stdout: string, success = true) {
  return {
    tool: 'claude' as const,
    model: 'sonnet',
    success,
    stdoutTail: stdout,
    commandPreview: ['claude', '--print'],
    transcriptPath: '/tmp/t.jsonl',
    sessionId: 's1',
    diagnostics: [],
  };
}

describe('buildLocalDraft 产出收敛', () => {
  it('非法 visibility/runtime_type 被收敛为合法默认，不再穿透到 manifest.json', () => {
    // 关键跨层回归：模型产出非法枚举值（public/edge），buildLocalDraft 必须收敛，
    // 否则 manifest.json 写入非法值 → uploadCloud → 后端 normalizePluginPackage 400。
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "v", "name": "V", "entry": "ui/index.html", "visibility": "public", "runtime_type": "edge" }',
      '```',
      '```file path="ui/index.html"',
      '<div></div>',
      '```',
    ].join('\n');
    const draft = buildLocalDraft({ prompt: '做一个番茄钟', providerLabel: 'Claude Code', model: 'sonnet', result: probeWith(raw) });
    const manifestFile = draft.files.find((f) => f.path === 'manifest.json');
    const manifest = JSON.parse(manifestFile!.content);
    expect(manifest.visibility).toBe('tenant'); // 非法 public → tenant
    expect(manifest.runtime_type).toBe('client'); // 非法 edge → client
    expect(manifest.capabilities[0].kind).toBe('code-assistant.run');
  });

  it('合法 visibility/runtime_type 原样保留', () => {
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "ok", "name": "OK", "entry": "ui/index.html", "visibility": "private", "runtime_type": "cloud" }',
      '```',
      '```file path="ui/index.html"',
      '<div></div>',
      '```',
    ].join('\n');
    const draft = buildLocalDraft({ prompt: '做一个番茄钟', providerLabel: 'Claude Code', model: 'sonnet', result: probeWith(raw) });
    const manifest = JSON.parse(draft.files.find((f) => f.path === 'manifest.json')!.content);
    expect(manifest.visibility).toBe('private');
    expect(manifest.runtime_type).toBe('cloud');
  });

  it('完全失败（无输出）→ status invalid，不比现状差', () => {
    const draft = buildLocalDraft({ prompt: '做一个番茄钟', providerLabel: 'Claude Code', model: 'sonnet', result: probeWith('', false) });
    expect(draft.status).toBe('invalid');
  });
});
