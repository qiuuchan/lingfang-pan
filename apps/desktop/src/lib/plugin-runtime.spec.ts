import { describe, expect, it } from 'vitest';
import { resolvePluginRuntime } from './plugin-runtime';
import type { LoadedPlugin } from './types';

function plugin(overrides: Partial<LoadedPlugin>): LoadedPlugin {
  return {
    id: 'p1',
    name: 'Plugin',
    version: '1.0.0',
    entry: 'ui/index.html',
    ...overrides,
  };
}

describe('resolvePluginRuntime', () => {
  it('优先使用 manifest 对象里的运行时，避免旧列表字段把脚本误判为 client', () => {
    expect(resolvePluginRuntime(plugin({
      runtime_type: 'client',
      manifest: { runtime_type: 'python' },
    }))).toBe('python');
  });

  it('files 中 manifest.json 可覆盖默认 runtime_type', () => {
    expect(resolvePluginRuntime(plugin({
      runtime_type: 'client',
      files: [
        { path: 'manifest.json', content: '{"runtime_type":"nodejs"}' },
        { path: 'index.js', content: 'console.log("ok")' },
      ],
    }))).toBe('nodejs');
  });

  it('缺少 manifest 时回退列表字段，再缺失时为 client', () => {
    expect(resolvePluginRuntime(plugin({ runtime_type: 'cloud' }))).toBe('cloud');
    expect(resolvePluginRuntime(plugin({ runtime_type: undefined }))).toBe('client');
  });
});
