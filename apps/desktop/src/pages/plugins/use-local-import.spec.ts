// use-local-import.spec.ts —— dedupeImportId 纯函数单测（ID 去重防覆盖现有插件目录）。
//
// useLocalImport hook 本身涉及 React 状态 + Tauri IO，全流程靠手测；这里只单测纯函数兜底。
import { describe, it, expect } from 'vitest';
import { dedupeImportId } from './use-local-import';

describe('dedupeImportId', () => {
  it('不冲突时原样返回', () => {
    expect(dedupeImportId('my-plugin', ['other', 'foo'])).toBe('my-plugin');
  });

  it('冲突时追加 -2，再次冲突递增', () => {
    expect(dedupeImportId('my-plugin', ['my-plugin'])).toBe('my-plugin-2');
    expect(dedupeImportId('my-plugin', ['my-plugin', 'my-plugin-2'])).toBe('my-plugin-3');
    expect(dedupeImportId('my-plugin', ['my-plugin', 'my-plugin-2', 'my-plugin-3'])).toBe('my-plugin-4');
  });

  it('跳过中间已被占用的编号', () => {
    expect(dedupeImportId('x', ['x', 'x-3'])).toBe('x-2');
    expect(dedupeImportId('x', ['x', 'x-2', 'x-3'])).toBe('x-4');
  });
});
