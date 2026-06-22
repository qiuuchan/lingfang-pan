// PricingService —— 模型版本配置 + 定价查询（灵石计费的「价目表」读取侧）。
//
// 设计（见 docs/billing-and-relay-design.md §5）：
//  - ModelTierConfig：tier(FAST/PREMIUM) → 真实上游 chatModel/imageModel + 参数。
//    relay 据 tier 解析真实模型后再定价 + 选渠道。
//  - ModelPricing：按 (capability, model, tier?) 查单价。tier 可空（同模型全版本同价）。
//  - 读多写少，用 AppCacheService 缓存（admin 改定价/版本后失效，TTL 兜底）。
//  - 单价单位语义：PER_TOKEN_* = 每 1k token 多少灵石；PER_CALL/PER_IMAGE = 每次/每张固定灵石。
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AppError } from '../common';
import { AppCacheService, CACHE_DEFAULT_TTL_MS, createMemoryCacheStore } from '../cache.service';

const TIERS_CACHE_KEY = 'pricing:tier-configs';
const fallbackCache = new AppCacheService(createMemoryCacheStore());

@Injectable()
export class PricingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AppCacheService) private readonly cache: AppCacheService = fallbackCache,
  ) {}

  /** tier → ModelTierConfig（含真实上游 chatModel/imageModel + 参数）。无配置 → 503。 */
  async getTierConfig(tier: 'FAST' | 'PREMIUM') {
    const all = await this.getAllTierConfigs();
    const cfg = all.find((c) => c.tier === tier);
    if (!cfg) throw new AppError(503, 'no_tier_config', `版本未配置：${tier}`);
    return cfg;
  }

  /** 全部版本配置（relay /v1/models 用）。命中缓存零 DB。 */
  async getAllTierConfigs() {
    return this.cache.remember(TIERS_CACHE_KEY, CACHE_DEFAULT_TTL_MS, async () => {
      const rows = await this.prisma.modelTierConfig.findMany();
      return rows.map((r) => ({
        tier: r.tier,
        label: r.label,
        chatModel: r.chatModel,
        imageModel: r.imageModel,
        temperature: r.temperature,
        maxTokens: r.maxTokens,
        extraParams: r.extraParams as Record<string, unknown>,
      }));
    });
  }

  /**
   * 查某次调用的灵石单价（灵石）。
   * @returns 单价 + 单位；无匹配定价 → null（relay 据此决定拒/放，默认拒：无定价不服务）。
   * 优先查 (capability, model, tier)，回退 (capability, model, null)。
   */
  async lookupPrice(args: {
    capability: 'chat' | 'image' | 'action';
    model: string;
    tier?: 'FAST' | 'PREMIUM' | null;
  }): Promise<{ unit: string; pricePerUnit: number } | null> {
    const whereTier = args.tier ? [{ tier: args.tier }, { tier: null }] : [{ tier: null }];
    // 先精确匹配 tier，再回退 tier=null；enabled=true。
    for (const tierCond of whereTier) {
      const row = await this.prisma.modelPricing.findFirst({
        where: { capability: args.capability, model: args.model, tier: tierCond as never, enabled: true },
        select: { unit: true, pricePerUnit: true },
      });
      if (row) return { unit: row.unit, pricePerUnit: row.pricePerUnit };
    }
    return null;
  }

  /** 把 token 用量 + 单价换算成灵石（PER_TOKEN_* 按 1k token 计，向上取整）。固定单位原样返回。 */
  computeCredits(
    unit: string,
    pricePerUnit: number,
    usage: { inputTokens?: number; outputTokens?: number; images?: number },
  ): number {
    switch (unit) {
      case 'PER_TOKEN_INPUT': {
        const tokens = usage.inputTokens ?? 0;
        return Math.ceil(tokens / 1000) * pricePerUnit;
      }
      case 'PER_TOKEN_OUTPUT': {
        const tokens = usage.outputTokens ?? 0;
        return Math.ceil(tokens / 1000) * pricePerUnit;
      }
      case 'PER_CALL':
        return pricePerUnit;
      case 'PER_IMAGE':
        return pricePerUnit * Math.max(1, usage.images ?? 1);
      default:
        return pricePerUnit;
    }
  }

  /** admin 改定价/版本后调失效缓存。 */
  invalidate(): Promise<void> {
    return this.cache.delete(TIERS_CACHE_KEY).then(() => undefined);
  }
}
