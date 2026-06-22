// skills.spec.ts — Task 12 Skill 系统拼装回归测试。
import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt, activeSkills, SKILLS, DEFAULT_ACTIVE_SKILLS } from './skills';

describe('Skill 系统 (Task 12)', () => {
  it('无激活 skill 时原样返回 base', () => {
    expect(assembleSystemPrompt('BASE', [])).toBe('BASE');
  });

  it('激活 skill 追加在 base 之后（分隔线隔开）', () => {
    const out = assembleSystemPrompt('BASE', ['output-minimize']);
    expect(out.startsWith('BASE')).toBe(true);
    expect(out).toContain('输出精简约束');
    expect(out).toContain('---');
  });

  it('多个 skill 按注册顺序拼接，各片段间分隔', () => {
    const out = assembleSystemPrompt('BASE', DEFAULT_ACTIVE_SKILLS);
    expect(out).toContain('输出精简约束');
    expect(out).toContain('增量重构');
    // output-minimize 在 plugin-refactor 之前（注册顺序）。
    expect(out.indexOf('输出精简约束')).toBeLessThan(out.indexOf('增量重构'));
  });

  it('未知 skill id 静默跳过（容错）', () => {
    const out = assembleSystemPrompt('BASE', ['nonexistent', 'output-minimize']);
    expect(out).toContain('输出精简约束');
    expect(out).not.toContain('nonexistent');
  });

  it('activeSkills 返回展示信息', () => {
    const list = activeSkills(DEFAULT_ACTIVE_SKILLS);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((s) => typeof s.name === 'string' && typeof s.prompt === 'string')).toBe(true);
  });

  it('默认激活集合非空且都是已注册 skill', () => {
    expect(DEFAULT_ACTIVE_SKILLS.length).toBeGreaterThan(0);
    const ids = new Set(SKILLS.map((s) => s.id));
    expect(DEFAULT_ACTIVE_SKILLS.every((id) => ids.has(id))).toBe(true);
  });
});
