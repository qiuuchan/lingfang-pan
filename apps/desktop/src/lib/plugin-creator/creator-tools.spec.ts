// creator-tools.spec.ts —— 完整性校验单测（validateStagedCompleteness / validateStagedFiles）。
//
// 重点回归：AI 生成插件常漏文件（缺入口/依赖清单），校验须按 runtime 拦截并给可执行报错。
import { describe, it, expect } from 'vitest';
import { validateStagedFiles, validateStagedCompleteness } from '@/lib/plugin-creator/creator-tools';
import type { DraftFile } from '@/lib/types';

const f = (path: string, content = ''): DraftFile => ({ path, content });

describe('validateStagedFiles', () => {
  it('空文件集合报错', () => {
    expect(validateStagedFiles('main.py', [])).toBe('插件至少要包含一个文件');
  });

  it('非法路径（绝对/../）报错', () => {
    expect(validateStagedFiles('main.py', [f('/etc/passwd')])).toContain('文件路径非法');
    expect(validateStagedFiles('main.py', [f('../x.py')])).toContain('文件路径非法');
  });

  it('入口不在 files 报错', () => {
    expect(validateStagedFiles('main.py', [f('other.py')])).toBe('入口文件 main.py 不在 files 中');
  });

  it('入口存在且路径合法返回 null', () => {
    expect(validateStagedFiles('main.py', [f('main.py')])).toBeNull();
  });
});

describe('validateStagedCompleteness', () => {
  describe('python', () => {
    it('入口非 main.py 报错', () => {
      const err = validateStagedCompleteness('python', 'run.py', [f('run.py'), f('requirements.txt')]);
      expect(err).toContain('main.py');
    });

    it('缺 requirements.txt 报错', () => {
      const err = validateStagedCompleteness('python', 'main.py', [f('main.py')]);
      expect(err).toContain('requirements.txt');
    });

    it('齐备返回 null', () => {
      expect(validateStagedCompleteness('python', 'main.py', [f('main.py'), f('requirements.txt')])).toBeNull();
    });
  });

  describe('nodejs', () => {
    it('入口非 index.js 报错', () => {
      const err = validateStagedCompleteness('nodejs', 'app.js', [f('app.js'), f('package.json')]);
      expect(err).toContain('index.js');
    });

    it('缺 package.json 报错', () => {
      const err = validateStagedCompleteness('nodejs', 'index.js', [f('index.js')]);
      expect(err).toContain('package.json');
    });

    it('齐备返回 null', () => {
      expect(validateStagedCompleteness('nodejs', 'index.js', [f('index.js'), f('package.json')])).toBeNull();
    });
  });

  describe('client', () => {
    it('入口非 HTML 报错', () => {
      const err = validateStagedCompleteness('client', 'app.js', [f('app.js')]);
      expect(err).toContain('HTML');
    });

    it('HTML 入口存在返回 null', () => {
      expect(validateStagedCompleteness('client', 'ui/index.html', [f('ui/index.html')])).toBeNull();
    });
  });

  it('基础校验失败优先返回（入口不在 files）', () => {
    const err = validateStagedCompleteness('python', 'main.py', [f('requirements.txt')]);
    expect(err).toBe('入口文件 main.py 不在 files 中');
  });
});
