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
        capabilities: [],
      },
      files: [{ path: 'main.py', content: 'console.log(1)' }],
    });
    expect(pkg.runtimeType).toBe('NODEJS');
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
