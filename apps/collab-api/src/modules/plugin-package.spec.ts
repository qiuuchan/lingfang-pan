// plugin-package.spec.ts — normalizePluginPackage 单元测试。
// 重点覆盖 R3 头号陷阱（design §4.1）：runtime_type 映射必须把
// nodejs/python 映射为 NODEJS/PYTHON，绝不可误落 CLOUD。
// 契约四值：client/cloud/nodejs/python（见 packages/contract RuntimeType）。
import { describe, expect, it } from 'vitest';
import { normalizePluginPackage } from './plugin-package';
import { AppError } from '../common';

// 最小合法包：含 manifest + entry 文件，runtime_type 由各用例覆盖。
function makePackage(runtime_type: string, entry = 'main.py') {
  return {
    manifest: {
      id: 'script-plugin',
      name: '脚本插件',
      version: '0.1.0',
      description: '脚本型插件',
      runtime_type,
      entry,
      visibility: 'tenant',
      capabilities: [{ kind: 'ui.view', reason: '展示界面', risk: 'low' }],
    },
    files: [
      { path: 'main.py', content: 'print("hello")' },
    ],
  };
}

function packageWithManifest(overrides: Record<string, unknown>, files?: Array<{ path: string; content: string }>) {
  const base = makePackage('python');
  return {
    ...base,
    manifest: { ...base.manifest, ...overrides },
    ...(files ? { files } : {}),
  } as unknown as Parameters<typeof normalizePluginPackage>[0];
}

describe('normalizePluginPackage runtime_type 映射', () => {
  it('client → CLIENT（回归保护）', () => {
    const pkg = normalizePluginPackage(makePackage('client', 'main.py'));
    expect(pkg.runtimeType).toBe('CLIENT');
    expect(pkg.manifest.runtime_type).toBe('client');
  });

  it('cloud → CLOUD（回归保护）', () => {
    const pkg = normalizePluginPackage(makePackage('cloud', 'main.py'));
    expect(pkg.runtimeType).toBe('CLOUD');
    expect(pkg.manifest.runtime_type).toBe('cloud');
  });

  it('nodejs → NODEJS（头号陷阱：不落 CLOUD）', () => {
    const pkg = normalizePluginPackage(makePackage('nodejs', 'main.py'));
    expect(pkg.runtimeType).toBe('NODEJS');
    expect(pkg.runtimeType).not.toBe('CLOUD');
    expect(pkg.manifest.runtime_type).toBe('nodejs');
  });

  it('python → PYTHON（头号陷阱：不落 CLOUD）', () => {
    const pkg = normalizePluginPackage(makePackage('python', 'main.py'));
    expect(pkg.runtimeType).toBe('PYTHON');
    expect(pkg.runtimeType).not.toBe('CLOUD');
    expect(pkg.manifest.runtime_type).toBe('python');
  });

  it('大写 runtimeType 输入也能正确归一（容错）', () => {
    // 后端兼容 manifest.runtimeType（驼峰）与 manifest.runtime_type 两种字段。
    const pkg = normalizePluginPackage({
      manifest: {
        id: 'x', name: 'x', version: '0.1.0', runtimeType: 'NODEJS', entry: 'main.py',
        visibility: 'PRIVATE', capabilities: [],
      },
      files: [{ path: 'main.py', content: 'console.log(1)' }],
    });
    expect(pkg.runtimeType).toBe('NODEJS');
    expect(pkg.visibility).toBe('PRIVATE');
  });

  it('空 runtime_type/visibility 保留旧入口的别名和默认容错', () => {
    const pkg = normalizePluginPackage(packageWithManifest({
      runtime_type: '',
      runtimeType: 'PYTHON',
      visibility: '',
    }));
    expect(pkg.runtimeType).toBe('PYTHON');
    expect(pkg.visibility).toBe('TEAM');
  });

  it('非法 runtime（如 rust）抛 badRequest', () => {
    expect(() => normalizePluginPackage(makePackage('rust', 'main.py'))).toThrow(AppError);
    try {
      normalizePluginPackage(makePackage('rust', 'main.py'));
      throw new Error('应抛错但未抛');
    } catch (err) {
      expect((err as AppError).status).toBe(400);
      expect((err as AppError).message).toContain('nodejs');
    }
  });

  it('缺失 runtime_type 默认 client → CLIENT', () => {
    const pkg = normalizePluginPackage({
      manifest: {
        id: 'x', name: 'x', version: '0.1.0', entry: 'main.py', capabilities: [],
      },
      files: [{ path: 'main.py', content: 'print(1)' }],
    });
    expect(pkg.runtimeType).toBe('CLIENT');
  });

  it('nodejs 包 entry 指向 .js 文件亦合法', () => {
    const pkg = normalizePluginPackage({
      manifest: {
        id: 'js', name: 'js', version: '0.1.0', runtime_type: 'nodejs', entry: 'src/index.js',
        capabilities: [],
      },
      files: [{ path: 'src/index.js', content: 'console.log("ok")' }],
    });
    expect(pkg.runtimeType).toBe('NODEJS');
    expect(pkg.manifest.entry).toBe('src/index.js');
  });
});

describe('normalizePluginPackage manifest 核心约束', () => {
  it('trim 后接受字段、能力数量和能力内容恰好位于上限', () => {
    const entry = `src/${'e'.repeat(508)}`;
    const pkg = normalizePluginPackage(packageWithManifest({
      id: ` ${'i'.repeat(128)} `,
      name: ` ${'n'.repeat(128)} `,
      version: ' 1.2.3-beta.1+build.5 ',
      description: 'd'.repeat(4096),
      entry: ` ${entry} `,
      capabilities: Array.from({ length: 64 }, () => ({
        kind: 'ui.view',
        reason: 'r'.repeat(500),
        risk: 'high',
        requires_admin: true,
        scope: { surface: 'desktop' },
      })),
    }, [{ path: entry, content: 'ok' }]));

    expect(pkg.manifest.id).toHaveLength(128);
    expect(pkg.manifest.name).toHaveLength(128);
    expect(pkg.manifest.version).toBe('1.2.3-beta.1+build.5');
    expect(pkg.manifest.description).toHaveLength(4096);
    expect(pkg.manifest.entry).toHaveLength(512);
    expect(pkg.manifest.capabilities).toHaveLength(64);
    expect(pkg.manifest.capabilities[0]).toMatchObject({
      reason: 'r'.repeat(500),
      requires_admin: true,
      scope: { surface: 'desktop' },
    });
  });

  it.each([
    ['id', { id: 'i'.repeat(129) }, /manifest\.id 长度不能超过 128/],
    ['name', { name: 'n'.repeat(129) }, /manifest\.name 长度不能超过 128/],
    ['description', { description: 'd'.repeat(4097) }, /manifest\.description 长度不能超过 4096/],
    ['entry', { entry: 'e'.repeat(513) }, /manifest\.entry 长度不能超过 512/],
  ])('拒绝超过上限的 manifest.%s', (_field, overrides, message) => {
    expect(() => normalizePluginPackage(packageWithManifest(overrides))).toThrow(message);
  });

  it.each([
    ['id', { id: 123 }],
    ['name', { name: false }],
    ['version', { version: 100 }],
    ['description', { description: null }],
    ['entry', { entry: { path: 'main.py' } }],
  ])('拒绝非字符串 manifest.%s', (_field, overrides) => {
    expect(() => normalizePluginPackage(packageWithManifest(overrides))).toThrow(/必须是字符串/);
  });

  it.each([
    ['id', { id: '   ' }],
    ['name', { name: '\n\t' }],
  ])('拒绝 trim 后为空的 manifest.%s', (_field, overrides) => {
    expect(() => normalizePluginPackage(packageWithManifest(overrides))).toThrow(/不能为空/);
  });

  it.each(['1.0', '01.0.0', 'v1.0.0', '1.0.0-', '1.0.0+'])('拒绝非严格 SemVer：%s', (version) => {
    expect(() => normalizePluginPackage(packageWithManifest({ version }))).toThrow(/严格 SemVer/);
  });

  it('entry 先 trim 再按既有安全路径规则校验', () => {
    const pkg = normalizePluginPackage(packageWithManifest({ entry: ' main.py ' }));
    expect(pkg.manifest.entry).toBe('main.py');
    expect(() => normalizePluginPackage(packageWithManifest({ entry: '../main.py' }))).toThrow(/空段|\.\./);
  });

  it('缺失 capabilities 默认空数组', () => {
    const pkg = normalizePluginPackage(packageWithManifest({ capabilities: undefined }));
    expect(pkg.manifest.capabilities).toEqual([]);
  });

  it('拒绝超过 64 项的 capabilities', () => {
    expect(() => normalizePluginPackage(packageWithManifest({
      capabilities: Array.from({ length: 65 }, () => ({ kind: 'ui.view' })),
    }))).toThrow(/不能超过 64 项/);
  });

  it.each([
    ['array shape', {}, /capabilities 必须是数组/],
    ['entry shape', [null], /条目必须是对象/],
    ['kind type', [{ kind: 1 }], /能力不在允许范围内/],
    ['kind whitelist', [{ kind: ' shell.exec ' }], /能力不在允许范围内/],
    ['reason type', [{ kind: 'ui.view', reason: 1 }], /reason 必须是字符串/],
    ['reason length', [{ kind: 'ui.view', reason: 'r'.repeat(501) }], /reason 长度不能超过 500/],
    ['risk type', [{ kind: 'ui.view', risk: false }], /risk 不合法/],
    ['risk whitelist', [{ kind: 'ui.view', risk: 'critical' }], /risk 不合法/],
    ['requires_admin', [{ kind: 'ui.view', requires_admin: 'false' }], /requires_admin 必须是布尔值/],
    ['scope array', [{ kind: 'ui.view', scope: [] }], /scope 必须是对象/],
    ['scope null', [{ kind: 'ui.view', scope: null }], /scope 必须是对象/],
  ])('拒绝非法 capability %s', (_field, capabilities, message) => {
    expect(() => normalizePluginPackage(packageWithManifest({ capabilities }))).toThrow(message);
  });

  it('requires_admin 仅在缺失时默认 false', () => {
    const pkg = normalizePluginPackage(packageWithManifest({ capabilities: [{ kind: 'ui.view' }] }));
    expect(pkg.manifest.capabilities).toEqual([
      { kind: 'ui.view', reason: '', risk: 'low', requires_admin: false },
    ]);
  });

  it.each([
    ['runtime_type', { runtime_type: false }, /runtime_type 必须是字符串/],
    ['runtimeType', { runtime_type: undefined, runtimeType: {} }, /runtime_type 必须是字符串/],
    ['visibility', { visibility: [] }, /visibility 必须是字符串/],
  ])('拒绝用 String 隐式转换非法 manifest.%s 结构', (_field, overrides, message) => {
    expect(() => normalizePluginPackage(packageWithManifest(overrides))).toThrow(message);
  });
});

describe('normalizePluginPackage 二进制 + 路径放行（v3）', () => {
  it('binary:true 文件按 base64 解码后字节数计量（非 UTF-8 字符串长度）', () => {
    // 3 字节 → base64 "AAAA"（4 字符）。若按 utf8 字符串长度会算 4，按解码应算 3。
    const b64 = Buffer.from('abc').toString('base64'); // "YWJj"
    const pkg = normalizePluginPackage({
      manifest: { id: 'b', name: 'b', version: '0.1.0', runtime_type: 'python', entry: 'main.py', capabilities: [] },
      files: [
        { path: 'main.py', content: 'print(1)' },
        { path: 'icon.png', content: b64, binary: true },
      ],
    });
    // 不抛错即说明未超单文件限（base64 4 字符 < 60MiB）；二进制标记透传。
    expect(pkg.files.some((f) => f.path === 'icon.png' && f.binary === true)).toBe(true);
  });

  it('binary 文件超 60MiB 解码字节 → 报单个文件过大', () => {
    // 构造一个解码后 > 60MiB 的 base64 串（64MiB 全 0）。
    const big = Buffer.alloc(64 * 1024 * 1024, 0).toString('base64');
    expect(() => normalizePluginPackage({
      manifest: { id: 'big', name: 'big', version: '0.1.0', runtime_type: 'python', entry: 'main.py', capabilities: [] },
      files: [
        { path: 'main.py', content: 'print(1)' },
        { path: 'font.ttf', content: big, binary: true },
      ],
    })).toThrow(/单个插件文件过大/);
  });

  it('允许点开头的文件名（如 .gitignore/.npmrc，vendored 树常见）', () => {
    const pkg = normalizePluginPackage({
      manifest: { id: 'v', name: 'v', version: '0.1.0', runtime_type: 'python', entry: 'main.py', capabilities: [] },
      files: [
        { path: 'main.py', content: 'print(1)' },
        { path: '.gitignore', content: 'node_modules\n' },
        { path: 'vendor/x/.npmrc', content: 'registry=https://example.com\n' },
      ],
    });
    expect(pkg.files.some((f) => f.path === '.gitignore')).toBe(true);
    expect(pkg.files.some((f) => f.path === 'vendor/x/.npmrc')).toBe(true);
  });

  it('仍拒绝空段与 .. 穿越（即使放开了点开头）', () => {
    expect(() => normalizePluginPackage({
      manifest: { id: 't', name: 't', version: '0.1.0', runtime_type: 'python', entry: 'main.py', capabilities: [] },
      files: [
        { path: 'main.py', content: 'print(1)' },
        { path: '../escape.txt', content: 'x' },
      ],
    })).toThrow(/空段|\.\./);
  });
});
