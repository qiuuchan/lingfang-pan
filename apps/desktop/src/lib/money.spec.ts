import { describe, expect, it } from 'vitest';
import { centsToYuan, fmtYuan, formatCreditAmount, normalizeCents, roundToCents } from './money';

describe('money helpers', () => {
  it('rounds noisy cent values before yuan formatting', () => {
    expect(normalizeCents(123.6)).toBe(124);
    expect(centsToYuan(123.6)).toBe('¥1.24');
    expect(fmtYuan(0.4)).toBe('免费');
  });

  it('rounds credit amounts to two decimals and removes negative zero', () => {
    expect(roundToCents(1.235)).toBe(1.24);
    expect(roundToCents(-0.0005636999999999999)).toBe(0);
    expect(formatCreditAmount(-0.0005636999999999999)).toBe('0.00');
  });
});
