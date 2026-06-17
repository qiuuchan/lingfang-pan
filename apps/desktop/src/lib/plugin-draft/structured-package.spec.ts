import { describe, expect, it } from 'vitest';
import { normalizeCapabilities, parseStructuredPackage } from '@/lib/plugin-draft';

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

  // CREATOR-06 修复验证：parseStructuredPackage 直接处理完整 stdout（不受 tailText 截断），
  // 超过 12k 字符的产出只要结构完整即可正确解析。
  it('大产出（> 12000 字符）仍能完整解析结构化块（CREATOR-06）', () => {
    // 构造一个 > 12k 的 manifest+file 包：file 内容 padding 到 > 12000 字符。
    const padding = 'x'.repeat(13_000);
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "big-ok", "name": "BigOk", "entry": "ui/index.html" }',
      '```',
      '```file path="ui/index.html"',
      `<div>${padding}</div>`,
      '```',
    ].join('\n');
    const parsed = parseStructuredPackage(raw);
    expect(parsed.status).toBe('ready');
    expect(parsed.manifest?.id).toBe('big-ok');
    expect(parsed.files.find((f) => f.path === 'ui/index.html')?.content).toContain(padding);
  });
});

