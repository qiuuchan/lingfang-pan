import { describe, expect, it } from 'vitest';
import { classifyBlockInfo, DEFAULT_CONVERSATION_SYSTEM_PROMPT, PLUGIN_CREATOR_SYSTEM_PROMPT } from './plugin-creator-protocol';

describe('classifyBlockInfo', () => {
  it('识别 manifest 块（带语言标识）', () => {
    expect(classifyBlockInfo('lingfang-manifest json')).toBe('manifest');
  });

  it('识别裸 manifest 块', () => {
    expect(classifyBlockInfo('lingfang-manifest')).toBe('manifest');
  });

  it('识别 notes 块', () => {
    expect(classifyBlockInfo('lingfang-notes')).toBe('notes');
  });

  it('识别 file 块（双引号 path）', () => {
    expect(classifyBlockInfo('file path="ui/index.html"')).toBe('file');
  });

  it('识别 file 块（单引号 path）', () => {
    expect(classifyBlockInfo("file path='ui/index.html'")).toBe('file');
  });

  it('识别 file 块（裸 token path）', () => {
    expect(classifyBlockInfo('file ui/index.html')).toBe('file');
  });

  it('空 info 归类为 unknown', () => {
    expect(classifyBlockInfo('')).toBe('unknown');
  });

  it('已知语言标识归类为 unknown（候选归类由上层处理）', () => {
    expect(classifyBlockInfo('html')).toBe('unknown');
    expect(classifyBlockInfo('python')).toBe('unknown');
    expect(classifyBlockInfo('ts')).toBe('unknown');
  });

  it('未知前缀归类为 unknown', () => {
    expect(classifyBlockInfo('random text')).toBe('unknown');
  });
});

describe('PLUGIN_CREATOR_SYSTEM_PROMPT', () => {
  it('为非空字符串且包含三类围栏块协议标记', () => {
    expect(typeof PLUGIN_CREATOR_SYSTEM_PROMPT).toBe('string');
    expect(PLUGIN_CREATOR_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(PLUGIN_CREATOR_SYSTEM_PROMPT).toContain('lingfang-manifest');
    expect(PLUGIN_CREATOR_SYSTEM_PROMPT).toContain('file path=');
    expect(PLUGIN_CREATOR_SYSTEM_PROMPT).toContain('lingfang-notes');
  });

  it('提示中明确禁止使用裸 code-assistant 能力', () => {
    // 白名单使用 code-assistant.run / code-assistant.session，绝不裸 code-assistant。
    expect(PLUGIN_CREATOR_SYSTEM_PROMPT).toContain('code-assistant.run');
    expect(PLUGIN_CREATOR_SYSTEM_PROMPT).toContain('不要用裸 "code-assistant"');
  });
});

describe('DEFAULT_CONVERSATION_SYSTEM_PROMPT', () => {
  it('介绍多个插件类型时引导使用卡片/列表，不鼓励 Markdown 表格', () => {
    expect(DEFAULT_CONVERSATION_SYSTEM_PROMPT).toContain('不要使用 Markdown 表格');
    expect(DEFAULT_CONVERSATION_SYSTEM_PROMPT).toContain('卡片式');
    expect(DEFAULT_CONVERSATION_SYSTEM_PROMPT).not.toContain('用标准 GFM Markdown 表格');
    expect(DEFAULT_CONVERSATION_SYSTEM_PROMPT).not.toContain('| 类型 | 适用场景 |');
  });
});
