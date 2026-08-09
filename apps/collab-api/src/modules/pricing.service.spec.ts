// PricingService.computeCredits 单测：聚焦「整数分」换算语义（P2-1 / M-4）。
// 灵石以整数分存储（1 灵石=100 分）；computeCredits 全程整数运算，结果必须是整型分。
// 用 {} as never 注入 prisma（computeCredits 不依赖 prisma）。
import { describe, expect, it } from 'vitest';
import { PricingService } from './pricing.service';

function make() {
  // @ts-expect-error 仅测 computeCredits，无需真实 Prisma。
  return new PricingService({} as never);
}

describe('PricingService.computeCredits（整数分换算）', () => {
  const svc = make();

  it('PER_TOKEN_INPUT：每 1M token × 单价分，四舍五入取整', () => {
    expect(svc.computeCredits('PER_TOKEN_INPUT', 100, { inputTokens: 1_000_000 })).toBe(100);
    expect(svc.computeCredits('PER_TOKEN_INPUT', 100, { inputTokens: 1_500_000 })).toBe(150);
    // 浮点尾数被四舍五入到整数分，不残留小数灵石。
    expect(svc.computeCredits('PER_TOKEN_INPUT', 33, { inputTokens: 1_000_000 })).toBe(33);
    expect(svc.computeCredits('PER_TOKEN_INPUT', 7, { inputTokens: 1_000_000 })).toBe(7);
  });

  it('PER_TOKEN_INPUT：0 / 负 token 不计费', () => {
    expect(svc.computeCredits('PER_TOKEN_INPUT', 100, { inputTokens: 0 })).toBe(0);
    expect(svc.computeCredits('PER_TOKEN_INPUT', 100, { inputTokens: -10 })).toBe(0);
  });

  it('PER_TOKEN_OUTPUT：与 INPUT 同公式', () => {
    expect(svc.computeCredits('PER_TOKEN_OUTPUT', 100, { outputTokens: 1_000_000 })).toBe(100);
    expect(svc.computeCredits('PER_TOKEN_OUTPUT', 50, { outputTokens: 2_000_000 })).toBe(100);
  });

  it('PER_CALL：固定单价分', () => {
    expect(svc.computeCredits('PER_CALL', 500, {})).toBe(500);
  });

  it('PER_IMAGE：单价分 × 张数（至少 1 张）', () => {
    expect(svc.computeCredits('PER_IMAGE', 50, { images: 3 })).toBe(150);
    expect(svc.computeCredits('PER_IMAGE', 50, { images: 1 })).toBe(50);
    expect(svc.computeCredits('PER_IMAGE', 50, { images: 0 })).toBe(50); // 至少 1 张
    expect(svc.computeCredits('PER_IMAGE', 50, {})).toBe(50); // 缺省 1 张
  });

  it('PER_SECOND：单价分 × 秒数（向上取整、至少 1 秒，防白嫖）', () => {
    expect(svc.computeCredits('PER_SECOND', 50, { seconds: 30 })).toBe(1500);
    expect(svc.computeCredits('PER_SECOND', 50, { seconds: 45.2 })).toBe(2300); // 46 秒
    expect(svc.computeCredits('PER_SECOND', 50, { seconds: 0 })).toBe(50); // clamp 到 1 秒
    expect(svc.computeCredits('PER_SECOND', 50, { seconds: -5 })).toBe(50); // clamp 到 1 秒
  });

  it('未知单位：回退固定单价分（与 production default 分支一致）', () => {
    expect(svc.computeCredits('UNKNOWN_UNIT', 80, {})).toBe(80);
  });

  it('所有结果均为整数（无浮点灵石）', () => {
    const cases: Array<[string, number, Record<string, number>]> = [
      ['PER_TOKEN_INPUT', 13, { inputTokens: 1_234_567 }],
      ['PER_TOKEN_OUTPUT', 17, { outputTokens: 9_876_543 }],
      ['PER_CALL', 250, {}],
      ['PER_IMAGE', 40, { images: 7 }],
      ['PER_SECOND', 50, { seconds: 12.9 }],
    ];
    for (const [unit, ppu, usage] of cases) {
      const r = svc.computeCredits(unit, ppu, usage);
      expect(Number.isInteger(r)).toBe(true);
    }
  });
});
