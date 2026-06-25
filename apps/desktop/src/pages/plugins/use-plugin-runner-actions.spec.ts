import { describe, expect, it } from 'vitest';
import { autoFixPrompt } from './use-plugin-runner-actions';
import type { LoadedPlugin } from '@/lib/types';

function plugin(overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    id: 'demo',
    name: '番茄钟',
    version: '1.0.0',
    entry: 'main.py',
    runtime_type: 'python',
    source: 'team',
    ...overrides,
  };
}

describe('autoFixPrompt', () => {
  it('包含插件名称与运行时中文标签', () => {
    const prompt = autoFixPrompt('Traceback: boom', plugin());
    expect(prompt).toContain('插件「番茄钟」');
    expect(prompt).toContain('(Python)');
  });

  it('用代码块包裹报错原文', () => {
    const prompt = autoFixPrompt('Traceback: boom', plugin());
    expect(prompt).toContain('```\nTraceback: boom\n```');
  });

  it('指引 AI 基于现有源码修复并写出完整文件', () => {
    const prompt = autoFixPrompt('err', plugin());
    expect(prompt).toContain('基于当前插件源码');
    expect(prompt).toContain('重新写出完整文件');
  });

  it('空 stderr 用占位文案避免空代码块', () => {
    const prompt = autoFixPrompt('   ', plugin());
    expect(prompt).toContain('(无错误输出)');
  });

  it('runtime_type 缺失时标注未知', () => {
    const prompt = autoFixPrompt('err', plugin({ runtime_type: undefined }));
    expect(prompt).toContain('(未知)');
  });

  it('各运行时映射到对应中文标签', () => {
    expect(autoFixPrompt('e', plugin({ runtime_type: 'client' }))).toContain('(网页)');
    expect(autoFixPrompt('e', plugin({ runtime_type: 'nodejs' }))).toContain('(Node.js)');
    expect(autoFixPrompt('e', plugin({ runtime_type: 'cloud' }))).toContain('(云端)');
  });
});
