import { describe, expect, it } from 'vitest';
import {
  buildDraftFromSandboxFiles,
  buildFallbackEntryHtml,
  buildLocalDraft,
  cleanPathFrontend,
  deriveTitle,
  hasStructuredBlocks,
  makeConversationDraft,
  makeConversationTurn,
  mergeConversationTurn,
  mergeFollowupDraft,
  mergeFollowupDraftWithSandbox,
  normalizeCapabilities,
  normalizeTurns,
  parseStructuredPackage,
  parseTranscript,
  summarizeTitleLocally,
  transcriptText,
  transcriptTextSinceLastInput,
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

// === design §3.3.6 (e)：mergeFollowupDraft 追问草稿累积 ===

describe('mergeFollowupDraft', () => {
  // 构造一个首轮 draft（已含 manifest + entry 文件 + 2 turns）。
  function firstRoundDraft() {
    return buildLocalDraft({
      prompt: '做一个番茄钟',
      providerLabel: 'Claude Code',
      model: 'sonnet',
      result: probeWith([
        '```lingfang-manifest json',
        '{ "id": "pomodoro", "name": "番茄钟", "entry": "ui/index.html" }',
        '```',
        '```file path="ui/index.html"',
        '<div>番茄钟 v1</div>',
        '```',
      ].join('\n')),
    });
  }

  it('完全失败（追问无产出）→ status partial，保留上轮文件', () => {
    // design §3.3.6 RISK8：追问无结构化产出时兜底保留 prev.files，不丢草稿。
    const prev = firstRoundDraft();
    const merged = mergeFollowupDraft(prev, probeWith('', false), '把按钮改成红色');
    // 追问无产出：保留上轮 entry 文件，status partial（不判 invalid，保留可用态）。
    expect(merged.files.find((f) => f.path === 'ui/index.html')?.content).toContain('v1');
    expect(merged.status).toBe('partial');
    // turns 仍累积 +2（user 追问 + assistant 兜底文案）。
    expect(merged.turns.length).toBe(prev.turns.length + 2);
  });

  it('追问在既有 draft 上累积 turns（+2）', () => {
    const prev = firstRoundDraft();
    const baseTurns = prev.turns.length;
    const merged = mergeFollowupDraft(
      prev,
      probeWith([
        '```lingfang-notes',
        '已把按钮改成红色',
        '```',
      ].join('\n')),
      '把按钮改成红色',
    );
    expect(merged.turns.length).toBe(baseTurns + 2);
    expect(merged.turns.some((t) => t.role === 'user' && t.content === '把按钮改成红色')).toBe(true);
    expect(merged.turns.some((t) => t.role === 'assistant' && t.content.includes('按钮改成红色'))).toBe(true);
  });

  it('追问产出新文件覆盖 prev.files（迭代）', () => {
    const prev = firstRoundDraft();
    const merged = mergeFollowupDraft(
      prev,
      probeWith([
        '```lingfang-manifest json',
        '{ "id": "pomodoro", "name": "番茄钟", "entry": "ui/index.html" }',
        '```',
        '```file path="ui/index.html"',
        '<div>番茄钟 v2 红色按钮</div>',
        '```',
      ].join('\n')),
      '把按钮改成红色',
    );
    // entry 文件被追问产出覆盖为 v2。
    expect(merged.files.find((f) => f.path === 'ui/index.html')?.content).toContain('v2 红色按钮');
    expect(merged.files.find((f) => f.path === 'ui/index.html')?.content).not.toContain('v1');
  });

  it('prev.id 保持稳定（同一插件跨轮迭代，不新开草稿）', () => {
    const prev = firstRoundDraft();
    const prevId = prev.id;
    const merged = mergeFollowupDraft(prev, probeWith('```\nwhatever\n```'), '追问');
    expect(merged.id).toBe(prevId);
  });

  it('追问空 assistant 输出经 normalizeTurns 不产生相邻重复', () => {
    // CLI 无输出时 assistant 兜底文案可能与策略相关；这里验证追问追加后 normalizeTurns 兜底去重生效。
    const prev = firstRoundDraft();
    const merged = mergeFollowupDraft(prev, probeWith('', true), '追问1');
    const turns = normalizeTurns(merged.turns);
    // 不应出现相邻同 role 同 content 的重复。
    for (let i = 1; i < turns.length; i++) {
      if (turns[i].role === turns[i - 1].role) {
        expect(turns[i].content).not.toBe(turns[i - 1].content);
      }
    }
  });

  it('diagnostics 合并（prev 诊断保留 + 追问新增）', () => {
    const prev = firstRoundDraft();
    const baseDiag = prev.diagnostics.length;
    const merged = mergeFollowupDraft(prev, probeWith([
      '```lingfang-notes',
      'done',
      '```',
    ].join('\n')), '追问');
    expect(merged.diagnostics.length).toBeGreaterThan(baseDiag);
  });
});

// === 方案A：sandbox 扫描结果构建草稿（claude 用 Write 工具写文件到 workspace） ===
//
// buildDraftFromSandboxFiles / mergeFollowupDraftWithSandbox：
// files 数据源是 Rust scan_workspace_files 扫描磁盘的结果（非 stdout 围栏块）。
// 覆盖：正常扫描（manifest.json + ui/index.html）、无 manifest.json 返回 null、entry 缺失兜底、
// 追问迭代（sandbox 新产出覆盖）、追问空产出保留上轮文件。

describe('buildDraftFromSandboxFiles', () => {
  it('扫描到 manifest.json + entry → status ready，files 来自磁盘', () => {
    // claude 典型产出：manifest.json + ui/index.html，扫描结果直接构造成草稿。
    const draft = buildDraftFromSandboxFiles({
      prompt: '做一个番茄钟',
      providerLabel: 'Claude Code',
      model: 'sonnet',
      result: probeWith('插件已生成。'),
      files: [
        { path: 'manifest.json', content: '{ "id": "pomodoro", "name": "番茄钟", "entry": "ui/index.html" }' },
        { path: 'ui/index.html', content: '<div>番茄钟</div>' },
      ],
    });
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe('ready');
    // manifest.json 收敛后放首位。
    expect(draft!.files[0].path).toBe('manifest.json');
    // entry 文件保留扫描原文。
    expect(draft!.files.find((f) => f.path === 'ui/index.html')?.content).toContain('番茄钟');
  });

  it('扫描无 manifest.json → 返回 null（调用方回退对话 / 围栏块）', () => {
    // 纯对话或 claude 未写 manifest.json：无法识别为插件包，返回 null。
    const draft = buildDraftFromSandboxFiles({
      prompt: '你好',
      providerLabel: 'Claude Code',
      model: 'sonnet',
      result: probeWith('你好！'),
      files: [{ path: 'readme.txt', content: 'hi' }],
    });
    expect(draft).toBeNull();
  });

  it('扫描仅有 manifest.json 无 entry → 补兜底预览页 + status partial', () => {
    // claude 偶尔只写 manifest.json 漏 entry 文件：补兜底页保证可预览。
    const draft = buildDraftFromSandboxFiles({
      prompt: '做一个番茄钟',
      providerLabel: 'Claude Code',
      model: 'sonnet',
      result: probeWith(''),
      files: [{ path: 'manifest.json', content: '{ "id": "p", "name": "番茄钟", "entry": "ui/index.html" }' }],
    });
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe('partial');
    // 兜底页被注入到 entry 路径。
    expect(draft!.files.find((f) => f.path === 'ui/index.html')?.content).toContain('番茄钟');
  });

  it('manifest.json 非法 JSON → 补 schema 诊断，仍兜底构造（不丢产出）', () => {
    // manifest.json 内容非 JSON：解析失败但仍构造草稿（兜底补全字段），status partial。
    const draft = buildDraftFromSandboxFiles({
      prompt: '做一个番茄钟',
      providerLabel: 'Claude Code',
      model: 'sonnet',
      result: probeWith(''),
      files: [
        { path: 'manifest.json', content: 'not json' },
        { path: 'ui/index.html', content: '<div></div>' },
      ],
    });
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe('partial');
    expect(draft!.diagnostics.some((d) => d.stage === 'schema' && d.message.includes('manifest'))).toBe(true);
  });

  it('capabilities 收敛为合法对象数组（不漏裸 code-assistant）', () => {
    // manifest 写了裸 code-assistant 字符串数组：normalizeCapabilities 兜底为合法对象数组。
    const draft = buildDraftFromSandboxFiles({
      prompt: '做一个插件',
      providerLabel: 'Claude Code',
      model: 'sonnet',
      result: probeWith(''),
      files: [
        { path: 'manifest.json', content: '{ "id": "p", "name": "P", "capabilities": ["code-assistant"] }' },
        { path: 'ui/index.html', content: '<div></div>' },
      ],
    });
    expect(draft).not.toBeNull();
    const manifestFile = draft!.files.find((f) => f.path === 'manifest.json');
    const manifest = JSON.parse(manifestFile!.content);
    // 收敛后 capabilities 是合法对象数组，kind 在白名单（绝不裸 code-assistant）。
    expect(Array.isArray(manifest.capabilities)).toBe(true);
    expect(manifest.capabilities.length).toBeGreaterThan(0);
    expect(manifest.capabilities[0].kind).not.toBe('code-assistant');
  });
});

describe('mergeFollowupDraftWithSandbox', () => {
  // 构造一个首轮 draft（已含 manifest + entry 文件 + 2 turns）。
  function firstRoundDraft() {
    return buildDraftFromSandboxFiles({
      prompt: '做一个番茄钟',
      providerLabel: 'Claude Code',
      model: 'sonnet',
      result: probeWith('已生成。'),
      files: [
        { path: 'manifest.json', content: '{ "id": "pomodoro", "name": "番茄钟", "entry": "ui/index.html" }' },
        { path: 'ui/index.html', content: '<div>番茄钟 v1</div>' },
      ],
    })!;
  }

  it('追问 sandbox 新产出覆盖 prev.files（迭代）', () => {
    const prev = firstRoundDraft();
    const merged = mergeFollowupDraftWithSandbox(prev, probeWith('已更新'), '把按钮改红', [
      { path: 'manifest.json', content: '{ "id": "pomodoro", "name": "番茄钟", "entry": "ui/index.html" }' },
      { path: 'ui/index.html', content: '<div>番茄钟 v2 红色按钮</div>' },
    ]);
    // entry 文件被追问产出覆盖为 v2。
    expect(merged.files.find((f) => f.path === 'ui/index.html')?.content).toContain('v2 红色按钮');
    expect(merged.status).toBe('ready');
  });

  it('追问 sandbox 空（仅 manifest.json 无源码）→ 保留上轮文件 + partial', () => {
    // 追问未改文件（sandbox 仅 manifest.json）：保留上轮 entry 文件，status partial。
    const prev = firstRoundDraft();
    const merged = mergeFollowupDraftWithSandbox(prev, probeWith('已确认'), '确认', [
      { path: 'manifest.json', content: '{ "id": "pomodoro", "name": "番茄钟" }' },
    ]);
    expect(merged.files.find((f) => f.path === 'ui/index.html')?.content).toContain('v1');
    expect(merged.status).toBe('partial');
  });

  it('追问在既有 draft 上累积 turns（+2）', () => {
    const prev = firstRoundDraft();
    const baseTurns = prev.turns.length;
    const merged = mergeFollowupDraftWithSandbox(prev, probeWith('已更新'), '把按钮改红', [
      { path: 'manifest.json', content: '{ "id": "pomodoro", "name": "番茄钟", "entry": "ui/index.html" }' },
      { path: 'ui/index.html', content: '<div>v2</div>' },
    ]);
    expect(merged.turns.length).toBe(baseTurns + 2);
  });

  it('prev.id 保持稳定（同一插件跨轮迭代）', () => {
    const prev = firstRoundDraft();
    const prevId = prev.id;
    const merged = mergeFollowupDraftWithSandbox(prev, probeWith(''), '追问', [
      { path: 'manifest.json', content: '{}' },
    ]);
    expect(merged.id).toBe(prevId);
  });
});

// === normalizeTurns：相邻同 role 同 content 去重（design §3.3.6 风险点 RISK5） ===

describe('normalizeTurns', () => {
  it('相邻同 role 同 content 去重', () => {
    const turns = [
      { role: 'assistant' as const, content: 'a', at: '1' },
      { role: 'assistant' as const, content: 'a', at: '2' },
    ];
    expect(normalizeTurns(turns)).toHaveLength(1);
  });

  it('不同 content 不去重', () => {
    const turns = [
      { role: 'user' as const, content: 'q1', at: '1' },
      { role: 'assistant' as const, content: 'a1', at: '2' },
      { role: 'user' as const, content: 'q2', at: '3' },
    ];
    expect(normalizeTurns(turns)).toHaveLength(3);
  });

  it('空数组 / undefined 安全', () => {
    expect(normalizeTurns([])).toEqual([]);
    expect(normalizeTurns(undefined)).toEqual([]);
  });
});

// === design §3.1.2 / §8.2：对话优先 gate 与纯对话态草稿（AC1 核心） ===

describe('hasStructuredBlocks', () => {
  it('纯自然语言无围栏块 → false（「你好」不触发结构化解析）', () => {
    expect(hasStructuredBlocks('你好！我是助手，有什么可以帮你的吗？')).toBe(false);
  });

  it('纯文本含普通段落 → false', () => {
    expect(hasStructuredBlocks('这是说明。\n再一段说明。')).toBe(false);
  });

  it('含 manifest 块 → true（自动检测触发）', () => {
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "x", "name": "X" }',
      '```',
    ].join('\n');
    expect(hasStructuredBlocks(raw)).toBe(true);
  });

  it('含 file 块 → true（自动检测触发）', () => {
    const raw = [
      '```file path="ui/index.html"',
      '<div></div>',
      '```',
    ].join('\n');
    expect(hasStructuredBlocks(raw)).toBe(true);
  });

  it('只有 unknown 代码块（裸 ```js）→ false（gate 严格只认 manifest/file）', () => {
    const raw = [
      '```js',
      'console.log("hi")',
      '```',
    ].join('\n');
    expect(hasStructuredBlocks(raw)).toBe(false);
  });

  it('只有 notes 块 → false（notes 不算结构化触发）', () => {
    const raw = [
      '```lingfang-notes',
      '这是一段说明',
      '```',
    ].join('\n');
    expect(hasStructuredBlocks(raw)).toBe(false);
  });

  it('空字符串 / undefined 安全 → false', () => {
    expect(hasStructuredBlocks('')).toBe(false);
  });
});

describe('makeConversationTurn', () => {
  it('产出 user + assistant 一对 turn', () => {
    const turns = makeConversationTurn('你好', '你好！有什么可以帮你？');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user', content: '你好' });
    expect(turns[1]).toMatchObject({ role: 'assistant', content: '你好！有什么可以帮你？' });
  });

  it('assistant 文本为空时兜底占位文案', () => {
    const turns = makeConversationTurn('你好', '');
    expect(turns[1].content).not.toBe('');
    expect(turns[1].role).toBe('assistant');
  });

  it('每个 turn 带时间戳', () => {
    const turns = makeConversationTurn('q', 'a');
    expect(typeof turns[0].at).toBe('string');
    expect(typeof turns[1].at).toBe('string');
  });
});

describe('makeConversationDraft', () => {
  it('产出纯对话态草稿：turns=[u,a] / files=[] / status=generating', () => {
    const draft = makeConversationDraft('你好', '你好！');
    expect(draft.turns).toHaveLength(2);
    expect(draft.files).toEqual([]);
    // AC1 关键：纯对话态绝不取 'invalid'，否则触发 destructive Badge + 预览 disabled。
    expect(draft.status).toBe('chat');
    expect(draft.diagnostics).toEqual([]);
  });

  it('id 非 undefined（有稳定标识）', () => {
    const draft = makeConversationDraft('你好', '你好！');
    expect(typeof draft.id).toBe('string');
    expect(draft.id.length).toBeGreaterThan(0);
  });
});

describe('mergeConversationTurn', () => {
  it('在既有纯对话 draft 上累积 turns（+2）', () => {
    const prev = makeConversationDraft('你好', '你好！');
    const baseTurns = prev.turns.length;
    const merged = mergeConversationTurn(prev, '再问一句', '回答你');
    expect(merged.turns.length).toBe(baseTurns + 2);
    expect(merged.turns.some((t) => t.role === 'user' && t.content === '再问一句')).toBe(true);
    expect(merged.turns.some((t) => t.role === 'assistant' && t.content === '回答你')).toBe(true);
  });

  it('累积后 files 仍保持空（纯对话态不被污染）', () => {
    const prev = makeConversationDraft('你好', '你好！');
    const merged = mergeConversationTurn(prev, '再问', '再答');
    expect(merged.files).toEqual([]);
    expect(merged.status).toBe('chat');
  });

  it('prev.id 保持稳定（同一对话跨轮，不新开草稿）', () => {
    const prev = makeConversationDraft('你好', '你好！');
    const prevId = prev.id;
    const merged = mergeConversationTurn(prev, '再问', '再答');
    expect(merged.id).toBe(prevId);
  });

  it('经 normalizeTurns 去重（相邻同 role 同 content）', () => {
    const prev = makeConversationDraft('你好', '你好！');
    const merged = mergeConversationTurn(prev, '你好', '你好！');
    const turns = normalizeTurns(merged.turns);
    for (let i = 1; i < turns.length; i++) {
      if (turns[i].role === turns[i - 1].role) {
        expect(turns[i].content).not.toBe(turns[i - 1].content);
      }
    }
  });
});

// === design §3.3.6 / 问题5 修复：transcriptTextSinceLastInput 只取本轮输出 ===

describe('transcriptTextSinceLastInput', () => {
  // 构造一条 transcript 事件（与 Rust append_transcript 写入的 JSON 行对齐）。
  function ev(event: string, payload: Record<string, unknown> = {}) {
    return { at: '2026-06-13T00:00:00Z', event, payload };
  }

  it('单轮：input 后的 output 全部取到', () => {
    const events = [
      ev('input', { prompt: '你好' }),
      ev('output', { stream: 'stdout', text: '你好！' }),
      ev('output', { stream: 'stdout', text: '有什么可以帮你？' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('你好！有什么可以帮你？');
  });

  it('多轮：只取最后一个 input 之后的 output（不串历史轮次）', () => {
    // 问题5 复现场景：第1轮「你好」→输出 A1；第2轮「你能做什么」→输出 A2。
    // 旧 transcriptText 会拼成 A1+A2，本函数只返回 A2。
    const events = [
      ev('input', { prompt: '你好' }),
      ev('output', { stream: 'stdout', text: '你好！（第1轮输出）' }),
      ev('input', { prompt: '你能做什么', kind: 'followup' }),
      ev('output', { stream: 'stdout', text: '我能做很多事（第2轮输出）' }),
    ];
    const result = transcriptTextSinceLastInput(events, 'stdout');
    expect(result).toBe('我能做很多事（第2轮输出）');
    // 关键回归：绝不含第1轮输出。
    expect(result).not.toContain('第1轮输出');
  });

  it('无 input 事件 → 取全部 output（向后兼容首轮 / 旧数据）', () => {
    const events = [
      ev('output', { stream: 'stdout', text: 'a' }),
      ev('output', { stream: 'stdout', text: 'b' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('ab');
  });

  it('input 后无 output（本轮 CLI 尚未产出）→ 返回空串', () => {
    const events = [
      ev('input', { prompt: '你好' }),
      ev('output', { stream: 'stderr', text: 'some warn' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('');
  });

  it('按 stream 分流：stdout 不混入 stderr', () => {
    const events = [
      ev('input', { prompt: '你好' }),
      ev('output', { stream: 'stdout', text: 'out' }),
      ev('output', { stream: 'stderr', text: 'err' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('out');
    expect(transcriptTextSinceLastInput(events, 'stderr')).toBe('err');
  });

  it('空数组 → 返回空串', () => {
    expect(transcriptTextSinceLastInput([], 'stdout')).toBe('');
  });

  it('三轮场景：只取最后一轮（中间轮次与首轮都不串入）', () => {
    const events = [
      ev('input', { prompt: '问1' }),
      ev('output', { stream: 'stdout', text: '答1' }),
      ev('input', { prompt: '问2', kind: 'followup' }),
      ev('output', { stream: 'stdout', text: '答2' }),
      ev('input', { prompt: '问3', kind: 'followup' }),
      ev('output', { stream: 'stdout', text: '答3' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('答3');
  });

  it('问题5 回归对照：旧 transcriptText 会串轮，新函数只取本轮', () => {
    // 问题5 根因：transcriptText 用 .join('') 拼所有 output → 多轮串成一段。
    // transcriptTextSinceLastInput 切到最后一轮 → 一问一答。
    const events = [
      ev('input', { prompt: '你好' }),
      ev('output', { stream: 'stdout', text: '你好回复' }),
      ev('input', { prompt: '你能做什么', kind: 'followup' }),
      ev('output', { stream: 'stdout', text: '能力回复' }),
    ];
    expect(transcriptText(events, 'stdout')).toBe('你好回复能力回复'); // 旧行为（串轮）
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('能力回复'); // 新行为（本轮）
  });
});



describe('deriveTitle', () => {
  it('record 已有 title → 原样返回（去空白）', () => {
    expect(deriveTitle({ title: '番茄钟插件' })).toBe('番茄钟插件');
    expect(deriveTitle({ title: '  带空格  ' })).toBe('带空格');
  });

  it('title 为空 → 从 transcript 首 input prompt 截断 24 字', () => {
    const transcript = JSON.stringify({ event: 'input', payload: { prompt: '做一个番茄钟插件' } });
    expect(deriveTitle({}, transcript)).toBe('做一个番茄钟插件');
  });

  it('prompt 超过 24 字 → 截断加省略号', () => {
    const long = '请帮我做一个可以设置二十五分钟和四十五分钟的番茄钟计时器插件';
    const transcript = JSON.stringify({ event: 'input', payload: { prompt: long } });
    const title = deriveTitle({}, transcript);
    expect(title.length).toBeLessThanOrEqual(25); // 24 字 + …
    expect(title.endsWith('…')).toBe(true);
  });

  it('无 title 且无 transcript → 兜底「新对话」', () => {
    expect(deriveTitle({})).toBe('新对话');
    expect(deriveTitle({ title: null })).toBe('新对话');
  });

  it('transcript 无 input 事件 → 兜底「新对话」', () => {
    const transcript = JSON.stringify({ event: 'output', payload: { text: 'hi' } });
    expect(deriveTitle({}, transcript)).toBe('新对话');
  });
});

// === summarizeTitleLocally：本地启发式秒级标题（去祈使前缀，截断16字） ===
describe('summarizeTitleLocally', () => {
  it('去掉祈使前缀拿核心需求', () => {
    expect(summarizeTitleLocally('帮我做一个番茄钟插件', '好的')).toBe('番茄钟插件');
    expect(summarizeTitleLocally('请创建一个倒计时工具', '')).toBe('倒计时工具');
    expect(summarizeTitleLocally('我想实现 Markdown 编辑器', '')).toBe('Markdown 编辑器');
  });

  it('闲聊类（你好/hi）回退 assistant 首行', () => {
    // clean 会去掉标点，"你好！我是 Claude Code，很高兴..." → 首句"你好"+第二句"我是 Claude Code"
    const title = summarizeTitleLocally('你好', '你好！我是 Claude Code，很高兴为你服务。');
    expect(title).toBe('你好我是 Claude Code');
  });

  it('截断到 16 字', () => {
    const long = '做一个非常非常非常非常非常非常非常长的插件需求描述';
    expect(summarizeTitleLocally(long, '').length).toBeLessThanOrEqual(16);
  });

  it('空输入兜底新对话', () => {
    expect(summarizeTitleLocally('', '')).toBe('新对话');
  });
});
