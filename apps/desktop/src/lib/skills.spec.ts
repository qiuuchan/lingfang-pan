import { describe, it, expect } from 'vitest';

import { SKILLS, DEFAULT_ACTIVE_SKILLS, assembleSystemPrompt, activeSkills } from './skills';

const BASE = '你是灵坊插件创建器。';

describe('SKILLS 注册表', () => {
  it('是非空数组', () => {
    expect(Array.isArray(SKILLS)).toBe(true);
    expect(SKILLS.length).toBeGreaterThan(0);
  });

  it('每个元素都有非空的 id/name/description/prompt 字符串字段', () => {
    for (const skill of SKILLS) {
      expect(typeof skill.id).toBe('string');
      expect(skill.id.length).toBeGreaterThan(0);
      expect(typeof skill.name).toBe('string');
      expect(skill.name.length).toBeGreaterThan(0);
      expect(typeof skill.description).toBe('string');
      expect(skill.description.length).toBeGreaterThan(0);
      expect(typeof skill.prompt).toBe('string');
      expect(skill.prompt.length).toBeGreaterThan(0);
    }
  });

  it('id 全局唯一', () => {
    const ids = SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('DEFAULT_ACTIVE_SKILLS', () => {
  it('是字符串数组', () => {
    expect(Array.isArray(DEFAULT_ACTIVE_SKILLS)).toBe(true);
    for (const id of DEFAULT_ACTIVE_SKILLS) {
      expect(typeof id).toBe('string');
    }
  });

  it('恰好等于 defaultActive===true 的 skill id 集合', () => {
    const expected = SKILLS.filter((s) => s.defaultActive === true).map((s) => s.id);
    expect(DEFAULT_ACTIVE_SKILLS).toHaveLength(expected.length);
    for (const id of expected) {
      expect(DEFAULT_ACTIVE_SKILLS).toContain(id);
    }
    for (const id of DEFAULT_ACTIVE_SKILLS) {
      expect(expected).toContain(id);
    }
  });

  it('不包含未标记 defaultActive 的 skill（如 ui-polish）', () => {
    const notDefault = SKILLS.filter((s) => s.defaultActive !== true).map((s) => s.id);
    expect(notDefault).toContain('ui-polish');
    for (const id of notDefault) {
      expect(DEFAULT_ACTIVE_SKILLS).not.toContain(id);
    }
  });
});

describe('assembleSystemPrompt', () => {
  it('activeIds 为空数组时原样返回 base', () => {
    expect(assembleSystemPrompt(BASE, [])).toBe(BASE);
  });

  it('全部为未知 id 时静默忽略并原样返回 base', () => {
    expect(assembleSystemPrompt(BASE, ['nonexistent'])).toBe(BASE);
    expect(assembleSystemPrompt(BASE, ['nonexistent', 'also-missing'])).toBe(BASE);
  });

  it('单个有效 id 时输出 base + 分隔符 + 该 skill 的 prompt', () => {
    const skill = SKILLS[0];
    const result = assembleSystemPrompt(BASE, [skill.id]);

    expect(result).toBe(`${BASE}\n\n---\n\n${skill.prompt}`);
    expect(result).toContain(BASE);
    expect(result).toContain(skill.prompt);
    expect(result).toContain('---');
  });

  it('混入未知 id 时只追加有效片段', () => {
    const skill = SKILLS[0];
    const result = assembleSystemPrompt(BASE, ['nonexistent', skill.id, 'also-missing']);

    expect(result).toBe(`${BASE}\n\n---\n\n${skill.prompt}`);
    expect(result).not.toContain('nonexistent');
  });

  it('多个有效 id 时逐个用分隔线拼接，且都包含各自 prompt 片段', () => {
    const [first, second, third] = SKILLS;
    const result = assembleSystemPrompt(BASE, [first.id, second.id, third.id]);

    expect(result).toBe(
      `${BASE}\n\n---\n\n${first.prompt}\n\n---\n\n${second.prompt}\n\n---\n\n${third.prompt}`
    );
    expect(result).toContain(first.prompt);
    expect(result).toContain(second.prompt);
    expect(result).toContain(third.prompt);
    // base + 3 个片段之间共 3 条分隔线
    expect(result.split('\n\n---\n\n')).toHaveLength(4);
  });

  it('按注册顺序追加，与传入 id 的顺序无关', () => {
    const [first, second] = SKILLS;
    const result = assembleSystemPrompt(BASE, [second.id, first.id]);

    expect(result.indexOf(first.prompt)).toBeGreaterThan(-1);
    expect(result.indexOf(second.prompt)).toBeGreaterThan(-1);
    expect(result.indexOf(first.prompt)).toBeLessThan(result.indexOf(second.prompt));
  });

  it('用 DEFAULT_ACTIVE_SKILLS 拼装时包含全部默认 skill 的 prompt', () => {
    const result = assembleSystemPrompt(BASE, DEFAULT_ACTIVE_SKILLS);
    const defaults = SKILLS.filter((s) => s.defaultActive === true);

    expect(result.startsWith(BASE)).toBe(true);
    for (const skill of defaults) {
      expect(result).toContain(skill.prompt);
    }
    expect(result).toContain('# 输出精简约束');
    // 未激活的 skill 不应出现
    expect(result).not.toContain('# 界面美化');
  });
});

describe('activeSkills', () => {
  it('空数组返回空数组', () => {
    expect(activeSkills([])).toEqual([]);
  });

  it('有效 id 返回对应的 Skill 对象（同一引用）', () => {
    const [first, second] = SKILLS;
    const result = activeSkills([first.id, second.id]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
    expect(result.map((s) => s.id)).toEqual([first.id, second.id]);
  });

  it('未知 id 被过滤掉，结果不含 undefined', () => {
    const [first] = SKILLS;
    const result = activeSkills(['nonexistent', first.id, 'also-missing']);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(first.id);
    expect(result.every((s) => s !== undefined && s !== null)).toBe(true);
  });

  it('长度等于有效 id 的数量', () => {
    const ids = [...SKILLS.map((s) => s.id), 'nonexistent'];
    expect(activeSkills(ids)).toHaveLength(SKILLS.length);
  });

  it('DEFAULT_ACTIVE_SKILLS 全部可解析为已注册 skill', () => {
    const result = activeSkills(DEFAULT_ACTIVE_SKILLS);

    expect(result).toHaveLength(DEFAULT_ACTIVE_SKILLS.length);
    expect(result.every((s) => s.defaultActive === true)).toBe(true);
  });
});
