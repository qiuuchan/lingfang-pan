import { describe, expect, it } from 'vitest';
import {
  buildDraftFromSandboxFiles,
  buildLocalDraft,
  mergeFollowupDraft,
  mergeFollowupDraftWithSandbox,
  normalizeTurns,
} from '@/lib/plugin-draft';
import { probeWith } from './test-helpers';

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
    const draft = buildLocalDraft({ prompt: '做一个番茄钟', providerLabel: 'ClaudeCode', model: 'sonnet', result: probeWith(raw) });
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
    const draft = buildLocalDraft({ prompt: '做一个番茄钟', providerLabel: 'ClaudeCode', model: 'sonnet', result: probeWith(raw) });
    const manifest = JSON.parse(draft.files.find((f) => f.path === 'manifest.json')!.content);
    expect(manifest.visibility).toBe('private');
    expect(manifest.runtime_type).toBe('cloud');
  });

  it('完全失败（无输出）→ status invalid，不比现状差', () => {
    const draft = buildLocalDraft({ prompt: '做一个番茄钟', providerLabel: 'ClaudeCode', model: 'sonnet', result: probeWith('', false) });
    expect(draft.status).toBe('invalid');
  });

  // DRAFT-02 修复：字节超限（单文件 > 256KB）的 invalid 不再被静默升格为 partial。
  it('字节超限（manifest 合法但单文件 > 256KB）→ status invalid（不再静默升格 partial）', () => {
    const big = 'a'.repeat(260 * 1024);
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "big", "name": "Big", "entry": "ui/index.html" }',
      '```',
      '```file path="ui/index.html"',
      big,
      '```',
    ].join('\n');
    const draft = buildLocalDraft({ prompt: '做一个插件', providerLabel: 'ClaudeCode', model: 'sonnet', result: probeWith(raw) });
    // parse 层判 invalid，buildLocalDraft 不再折叠为 partial。
    expect(draft.status).toBe('invalid');
    // 诊断仍带字节超限 fail 文案。
    expect(draft.diagnostics.some((d) => d.stage === 'schema' && d.status === 'fail')).toBe(true);
  });
});

// === design §3.3.6 (e)：mergeFollowupDraft 追问草稿累积 ===

describe('mergeFollowupDraft', () => {
  // 构造一个首轮 draft（已含 manifest + entry 文件 + 2 turns）。
  function firstRoundDraft() {
    return buildLocalDraft({
      prompt: '做一个番茄钟',
      providerLabel: 'ClaudeCode',
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

  // DRAFT-01 修复：追问未重发完整 manifest（仅 file 块无 manifest 块）时 prevManifest.capabilities 保留。
  it('追问仅产出 file 块无 manifest 块 → prevManifest.capabilities 保留（不降级为单能力兜底）', () => {
    // 关键场景：多能力插件（如 fs.read + ui.view）在后续追问只改源码不重发 manifest 时，
    // 此前 normalizeCapabilities(undefined) 一律兜底为 [code-assistant.run]，已授权能力静默丢失。
    const prev = buildDraftFromSandboxFiles({
      prompt: '做一个多能力插件',
      providerLabel: 'ClaudeCode',
      model: 'sonnet',
      result: probeWith('已生成。'),
      files: [
        { path: 'manifest.json', content: '{ "id": "multi", "name": "多能力", "entry": "ui/index.html", "capabilities": [{ "kind": "fs.read", "reason": "读取" }, { "kind": "ui.view", "reason": "渲染" }] }' },
        { path: 'ui/index.html', content: '<div>v1</div>' },
      ],
    })!;
    // 追问仅出 file 块（改按钮颜色），无 manifest 块。
    const merged = mergeFollowupDraft(prev, probeWith([
      '```file path="ui/index.html"',
      '<div>v2 红色按钮</div>',
      '```',
    ].join('\n')), '把按钮改红');
    const manifestFile = merged.files.find((f) => f.path === 'manifest.json');
    const manifest = JSON.parse(manifestFile!.content);
    // prevManifest 的多能力必须保留，不降级为单 code-assistant.run。
    expect(Array.isArray(manifest.capabilities)).toBe(true);
    expect(manifest.capabilities.length).toBe(2);
    expect(manifest.capabilities.some((c: { kind: string }) => c.kind === 'fs.read')).toBe(true);
    expect(manifest.capabilities.some((c: { kind: string }) => c.kind === 'ui.view')).toBe(true);
    expect(manifest.capabilities.some((c: { kind: string }) => c.kind === 'code-assistant.run')).toBe(false);
  });

  it('追问重发完整 capabilities → 覆盖 prev（迭代而非保留旧能力）', () => {
    const prev = firstRoundDraft();
    const merged = mergeFollowupDraft(prev, probeWith([
      '```lingfang-manifest json',
      '{ "id": "pomodoro", "name": "番茄钟", "entry": "ui/index.html", "capabilities": [{ "kind": "fs.read", "reason": "新读" }] }',
      '```',
      '```file path="ui/index.html"',
      '<div>v2</div>',
      '```',
    ].join('\n')), '加个读取能力');
    const manifest = JSON.parse(merged.files.find((f) => f.path === 'manifest.json')!.content);
    // 合法非空 capabilities 覆盖 prev，迭代生效。
    expect(manifest.capabilities.some((c: { kind: string }) => c.kind === 'fs.read')).toBe(true);
  });

  // DRAFT-04 修复：prevManifest 含磁盘脏值（非法 visibility/runtime_type）时，
  // normalizeEnum 的 fallback 路径校验 fallback 是否在白名单，脏值不继续透传。
  it('prevManifest 含非法 visibility/runtime_type（磁盘脏值）→ fallback 校验白名单，脏值不透传', () => {
    // 构造一个磁盘脏 prev：manifest.json 字段为非法 'public' / 'edge'。
    const prev = buildDraftFromSandboxFiles({
      prompt: '做一个插件',
      providerLabel: 'ClaudeCode',
      model: 'sonnet',
      result: probeWith('已生成。'),
      files: [
        { path: 'manifest.json', content: '{ "id": "dirty", "name": "脏值", "entry": "ui/index.html", "visibility": "public", "runtime_type": "edge" }' },
        { path: 'ui/index.html', content: '<div>v1</div>' },
      ],
    })!;
    // 追问不重发 manifest → 走 prevManifest fallback 路径。
    const merged = mergeFollowupDraft(prev, probeWith([
      '```file path="ui/index.html"',
      '<div>v2</div>',
      '```',
    ].join('\n')), '改红');
    const manifest = JSON.parse(merged.files.find((f) => f.path === 'manifest.json')!.content);
    // 脏值 'public'/'edge' 不在白名单，fallback 校验退回白名单首个允许值，绝不透传到新 manifest.json。
    expect(manifest.visibility).not.toBe('public');
    expect(manifest.runtime_type).not.toBe('edge');
    // 落到合法白名单内（visibility: private|tenant；runtime_type: client|cloud|nodejs|python）。
    expect(['private', 'tenant']).toContain(manifest.visibility);
    expect(['client', 'cloud', 'nodejs', 'python']).toContain(manifest.runtime_type);
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
      providerLabel: 'ClaudeCode',
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
      providerLabel: 'ClaudeCode',
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
      providerLabel: 'ClaudeCode',
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
      providerLabel: 'ClaudeCode',
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
      providerLabel: 'ClaudeCode',
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
      providerLabel: 'ClaudeCode',
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

  // DRAFT-01 修复（sandbox 路径同款根因）：追问 sandbox 的 manifest.json 不含 capabilities 时，
  // 保留 prevManifest.capabilities，不降级为单能力兜底。
  it('追问 sandbox manifest.json 缺 capabilities 字段 → prevManifest.capabilities 保留', () => {
    const prev = buildDraftFromSandboxFiles({
      prompt: '做一个多能力插件',
      providerLabel: 'ClaudeCode',
      model: 'sonnet',
      result: probeWith('已生成。'),
      files: [
        { path: 'manifest.json', content: '{ "id": "multi", "name": "多能力", "entry": "ui/index.html", "capabilities": [{ "kind": "fs.read", "reason": "读取" }, { "kind": "ui.view", "reason": "渲染" }] }' },
        { path: 'ui/index.html', content: '<div>v1</div>' },
      ],
    })!;
    // 追问 sandbox 重写 manifest.json 但漏了 capabilities 字段。
    const merged = mergeFollowupDraftWithSandbox(prev, probeWith('已改'), '把按钮改红', [
      { path: 'manifest.json', content: '{ "id": "multi", "name": "多能力", "entry": "ui/index.html" }' },
      { path: 'ui/index.html', content: '<div>v2</div>' },
    ]);
    const manifest = JSON.parse(merged.files.find((f) => f.path === 'manifest.json')!.content);
    expect(manifest.capabilities.length).toBe(2);
    expect(manifest.capabilities.some((c: { kind: string }) => c.kind === 'fs.read')).toBe(true);
    expect(manifest.capabilities.some((c: { kind: string }) => c.kind === 'code-assistant.run')).toBe(false);
  });
});

