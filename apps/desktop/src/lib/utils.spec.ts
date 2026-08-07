import { describe, it, expect } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('拼接普通字符串', () => {
    const result = cn('a', 'b');
    expect(result).toContain('a');
    expect(result).toContain('b');
  });

  it('忽略条件为 false 的类', () => {
    const result = cn('a', false && 'b', 'c');
    expect(result).not.toContain('b');
    expect(result).toContain('a');
    expect(result).toContain('c');
  });

  it('支持对象语法', () => {
    const result = cn('a', { b: true, c: false });
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).not.toContain('c');
  });

  it('解决 tailwind 冲突只保留后者', () => {
    const result = cn('px-2', 'px-4');
    expect(result).toContain('px-4');
    expect(result).not.toContain('px-2');
  });

  it('空输入返回字符串', () => {
    const result = cn();
    expect(typeof result).toBe('string');
  });
});
