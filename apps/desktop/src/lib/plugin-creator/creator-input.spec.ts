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
      ['image.png（二进制，已跳过）']
    );

    expect(context).toContain('# 本轮上传附件');
    expect(context).toContain('--- main.py ---');
    expect(context).toContain('print("hi")');
    expect(context).toContain('已跳过 1 个文件');
  });

  it('chunks oversized attachments to fit Write tool safe length', () => {
    // 12000 字符文件：超过 WRITE_SAFE_CHARS(5500)，应分 3 块（每块 5000）。
    const big = 'x'.repeat(12_000);
    const context = formatAttachmentContext([{ path: 'big.py', content: big }]);

    // 头部声明：分块说明 + 原文字符数。
    expect(context).toContain('--- big.py（共 12000 字符，已分 3 块以适配 Write 工具）---');
    // 三块标记齐全。
    expect(context).toContain('# ===== 块 1/3 =====');
    expect(context).toContain('# ===== 块 2/3 =====');
    expect(context).toContain('# ===== 块 3/3 =====');
    // 分块指引：Write 块 1 + Edit 追加后续块 + 安全长度提示。
    expect(context).toContain('用 Write 写「块 1」到 big.py');
    expect(context).toContain('Edit');
    expect(context).toMatch(/new_string ≤ 5500 字符/);
    // 不应回退到老的「已截断」占位（那是短文件分支的兜底）。
    expect(context).not.toContain('...(已截断');
  });

  it('leaves short attachments unchunked (no behavior change below safe length)', () => {
    const short = 'x'.repeat(5_000); // ≤ WRITE_SAFE_CHARS(5500)，走原逻辑
    const context = formatAttachmentContext([{ path: 'short.py', content: short }]);

    expect(context).toContain('--- short.py ---');
    expect(context).not.toContain('已分 ');
    expect(context).not.toContain('块 1/');
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
