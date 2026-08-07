import { describe, expect, it } from 'vitest';
import type { DraftFile } from '@/lib/types';
import {
  buildFallbackEntryFile,
  buildFallbackEntryHtml,
  cleanPathFrontend,
  defaultEntryForRuntime,
  normalizeCapabilities,
  validatePluginStructure,
} from '@/lib/plugin-draft';

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
    expect(cleanPathFrontend('C:/Windows/system32')).toEqual({
      ok: false,
      reason: expect.any(String),
    });
  });

  it('拒绝包含 .. 的路径穿越', () => {
    expect(cleanPathFrontend('../../../etc/passwd')).toEqual({
      ok: false,
      reason: expect.any(String),
    });
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
    const out = normalizeCapabilities([{ kind: 'ui.view', reason: '展示', requires_admin: false }]);
    expect(out).toEqual([{ kind: 'ui.view', reason: '展示', risk: 'low', requires_admin: false }]);
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
    expect(out[0].kind).toBe('ui.view');
  });

  it('含非法 kind 的数组整体兜底', () => {
    const out = normalizeCapabilities([{ kind: 'code-assistant' }, { kind: 'ui.view' }]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('ui.view');
  });

  it('空数组兜底（无能力时不影响后端接受空数组，但产出端给一个默认能力）', () => {
    const out = normalizeCapabilities([]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('ui.view');
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
      expect(kinds.every((k) => k === 'ui.view')).toBe(true);
    }
  });

  it('保留合法 scope 字段', () => {
    const out = normalizeCapabilities([{ kind: 'fs.read', scope: { paths: ['/tmp'] } }]);
    expect(out[0].scope).toEqual({ paths: ['/tmp'] });
  });

  it('AI 能力忽略旧 requires_admin=true，非 AI 能力保持通用语义', () => {
    const out = normalizeCapabilities([
      { kind: 'llm.chat', requires_admin: true },
      { kind: 'image.generate', requires_admin: true },
      { kind: 'fs.read', requires_admin: true },
    ]);
    expect(out.map((capability) => [capability.kind, capability.requires_admin])).toEqual([
      ['llm.chat', false],
      ['image.generate', false],
      ['fs.read', true],
    ]);
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

// === 入口按 runtime_type 分流（修复 Python/Node 入口误判为 ui/index.html） ===

describe('defaultEntryForRuntime', () => {
  it('python → main.py', () => {
    expect(defaultEntryForRuntime('python')).toBe('main.py');
  });
  it('nodejs → index.js', () => {
    expect(defaultEntryForRuntime('nodejs')).toBe('index.js');
  });
  it('client → ui/index.html', () => {
    expect(defaultEntryForRuntime('client')).toBe('ui/index.html');
  });
  it('未知/缺失 → 回退 ui/index.html', () => {
    expect(defaultEntryForRuntime(undefined)).toBe('ui/index.html');
    expect(defaultEntryForRuntime('cloud')).toBe('ui/index.html');
    expect(defaultEntryForRuntime('')).toBe('ui/index.html');
  });
});

describe('buildFallbackEntryFile', () => {
  it('python 生成 main.py 可运行骨架（含 if __name__ guard）', () => {
    const file = buildFallbackEntryFile('python', { manifestName: '番茄钟' });
    expect(file.language).toBe('python');
    expect(file.content).toContain('main');
    expect(file.content).toContain("if __name__ == '__main__'");
  });
  it('nodejs 生成 index.js 骨架', () => {
    const file = buildFallbackEntryFile('nodejs', { manifestName: 'my-tool' });
    expect(file.language).toBe('javascript');
    expect(file.content).toContain('console.log');
  });
  it('client 生成 HTML 兜底页', () => {
    const file = buildFallbackEntryFile('client', { manifestName: '网页插件' });
    expect(file.language).toBe('html');
    expect(file.content).toContain('<!doctype html>');
  });
  it('兜底骨架含 manifestName（便于用户识别）', () => {
    const py = buildFallbackEntryFile('python', { manifestName: '番茄钟' });
    expect(py.content).toContain('番茄钟');
  });
});

// === 插件结构校验（validatePluginStructure） ===

describe('validatePluginStructure', () => {
  function file(path: string, content = ''): DraftFile {
    return { path, content };
  }

  it('files 为空时不校验（纯对话态）', () => {
    expect(validatePluginStructure([])).toEqual([]);
  });

  it('有 files 但缺 manifest.json → fail 诊断', () => {
    const diags = validatePluginStructure([file('run.py'), file('main.py')]);
    expect(diags).toHaveLength(1);
    expect(diags[0].status).toBe('fail');
    expect(diags[0].message).toContain('manifest.json');
  });

  it('有 manifest + 入口存在 + 入口名规范 → 无诊断', () => {
    const manifest = file(
      'manifest.json',
      JSON.stringify({
        id: 'x',
        name: 'x',
        runtime_type: 'python',
        entry: 'main.py',
      })
    );
    const diags = validatePluginStructure([manifest, file('main.py')]);
    expect(diags).toEqual([]);
  });

  it('有 manifest 但 entry 文件缺失 → warn', () => {
    const manifest = file(
      'manifest.json',
      JSON.stringify({
        id: 'x',
        name: 'x',
        runtime_type: 'python',
        entry: 'main.py',
      })
    );
    const diags = validatePluginStructure([manifest]); // 无 main.py
    expect(diags.some((d) => d.status === 'warn' && d.message.includes('main.py 不存在'))).toBe(
      true
    );
  });

  it('Python 入口非 main.py → warn 规范提示', () => {
    const manifest = file(
      'manifest.json',
      JSON.stringify({
        id: 'x',
        name: 'x',
        runtime_type: 'python',
        entry: 'run.py',
      })
    );
    const diags = validatePluginStructure([manifest, file('run.py')]);
    expect(diags.some((d) => d.status === 'warn' && d.message.includes('main.py'))).toBe(true);
  });
});
