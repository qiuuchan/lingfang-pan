import { describe, expect, it } from 'vitest';
import { centsToYuan, fmtYuan, formatCreditAmount, normalizeCents } from './money';

describe('money helpers', () => {
  it('rounds noisy cent values before yuan formatting', () => {
    expect(normalizeCents(123.6)).toBe(124);
    expect(centsToYuan(123.6)).toBe('¥1.24');
    expect(fmtYuan(0.4)).toBe('免费');
  });

  it('formats 灵石 integer cents (÷100) with thousands separator', () => {
    // 灵石以整数分存储：1000 分 = 10.00 灵石。
    expect(formatCreditAmount(1000)).toBe('10.00');
    expect(formatCreditAmount(123500)).toBe('1,235.00');
    expect(formatCreditAmount(0)).toBe('0.00');
    expect(formatCreditAmount(-0.4)).toBe('0.00'); // 极小噪声兜底为 0
    expect(formatCreditAmount(null)).toBe('0.00');
    expect(formatCreditAmount(undefined)).toBe('0.00');
  });
});
