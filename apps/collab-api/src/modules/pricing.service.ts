// PricingService —— 模型定价查询（灵石计费的「价目表」读取侧）。
//
// 资源池重构（2026-06-23）后：ModelTierConfig 已删除（版本=渠道标签，非固定模型映射）。
// 本服务只管 ModelPricing 价目表：按 (capability, model, tier?) 查单价。
//
// 定价单位（v0.0.6 调整）：PER_TOKEN_INPUT/OUTPUT = 每 1M token 多少灵石（取代旧的每1k）；
// PER_CALL = 每次；PER_IMAGE = 每张。computeCredits 据单位换算。
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class PricingService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 查某次调用的单价（灵石）。
   * @returns 单价 + 单位；无匹配定价 → null（relay 据此决定拒/放）。
   * 优先查 (capability, model, tier)，回退 (capability, model, null)。
   */
  async lookupPrice(args: {
    capability: 'chat' | 'image' | 'action';
    model: string;
    tier?: 'FAST' | 'PREMIUM' | null;
  }): Promise<{ unit: string; pricePerUnit: number } | null> {
    const whereTier = args.tier ? [{ tier: args.tier }, { tier: null }] : [{ tier: null }];
    for (const tierCond of whereTier) {
      const row = await this.prisma.modelPricing.findFirst({
        where: { capability: args.capability, model: args.model, tier: tierCond as never, enabled: true },
        select: { unit: true, pricePerUnit: true },
      });
      if (row) return { unit: row.unit, pricePerUnit: row.pricePerUnit };
    }
    return null;
  }

  /**
   * 把用量 + 单价换算成灵石。
   *  - PER_TOKEN_*：pricePerUnit = 每 1M token 的灵石数。actual = ceil(tokens × pricePerUnit / 1_000_000)，最少 1。
   *  - PER_CALL：固定 pricePerUnit。
   *  - PER_IMAGE：pricePerUnit × 张数。
   */
  computeCredits(
    unit: string,
    pricePerUnit: number,
    usage: { inputTokens?: number; outputTokens?: number; images?: number },
  ): number {
    switch (unit) {
      case 'PER_TOKEN_INPUT': {
        const tokens = usage.inputTokens ?? 0;
        if (tokens <= 0) return 0;
        return Math.max(1, Math.ceil((tokens * pricePerUnit) / 1_000_000));
      }
      case 'PER_TOKEN_OUTPUT': {
        const tokens = usage.outputTokens ?? 0;
        if (tokens <= 0) return 0;
        return Math.max(1, Math.ceil((tokens * pricePerUnit) / 1_000_000));
      }
      case 'PER_CALL':
        return pricePerUnit;
      case 'PER_IMAGE':
        return pricePerUnit * Math.max(1, usage.images ?? 1);
      default:
        return pricePerUnit;
    }
  }
}
