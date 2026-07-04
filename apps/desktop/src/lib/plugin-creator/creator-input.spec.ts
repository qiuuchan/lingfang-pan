import { describe, expect, it } from 'vitest';
import {
  buildPromptOptimizerMessages,
  composeModelInput,
  creatorModePrompt,
  formatAttachmentContext,
  summarizeAttachmentDisplay,
} from './creator-input';

describe('creator input helpers', () => {
  it('builds prompt optimizer messages around original prompt evidence', () => {
    const messages = buildPromptOptimizerMessages('Write a story');

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toContain('"originalPrompt":"Write a story"');
    expect(messages[1].content).toContain('优化提示词文本本身');
  });

  it('formats uploaded text files as model context', () => {
    const context = formatAttachmentContext(
      [{ path: 'main.py', content: 'print("hi")' }],
      ['image.png（二进制，已跳过）'],
    );

    expect(context).toContain('# 本轮上传附件');
    expect(context).toContain('--- main.py ---');
    expect(context).toContain('print("hi")');
    expect(context).toContain('已跳过 1 个文件');
  });

  it('composes user input with attachments only when present', () => {
    expect(composeModelInput('做一个插件', '')).toBe('做一个插件');
    expect(composeModelInput('做一个插件', '# 附件')).toContain('做一个插件\n\n# 附件');
  });

  it('summarizes attachment display without leaking file contents', () => {
    expect(summarizeAttachmentDisplay(2, 1)).toBe('已附加 2 个文件，跳过 1 个文件');
    expect(summarizeAttachmentDisplay(0, 0)).toBe('');
  });

  it('emits distinct mode prompts', () => {
    expect(creatorModePrompt('plan')).toContain('Plan 模式');
    expect(creatorModePrompt('plan')).toContain('不要调用写入');
    expect(creatorModePrompt('agent')).toContain('Agent 模式');
    expect(creatorModePrompt('agent')).toContain('可验证的插件草稿');
  });
});
