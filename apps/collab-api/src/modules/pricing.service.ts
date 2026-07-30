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
    capability: 'chat' | 'image' | 'action' | 'video' | 'audio';
    model: string;
    tier?: 'FAST' | 'PREMIUM' | null;
  }): Promise<{ unit: string; pricePerUnit: number } | null> {
    // tier 候选：有 tier 先精确匹配，再回退 null（不限版本）。直接用值，不包对象。
    const tierValues: (('FAST' | 'PREMIUM') | null)[] = args.tier ? [args.tier, null] : [null];
    for (const tv of tierValues) {
      const row = await this.prisma.modelPricing.findFirst({
        where: { capability: args.capability, model: args.model, tier: tv, enabled: true },
        select: { unit: true, pricePerUnit: true },
      });
      if (row) return { unit: row.unit, pricePerUnit: row.pricePerUnit };
    }
    return null;
  }

  /**
   * 查某 tier 下所有候选模型的最小 contextWindow（保守上下文预算）。
   *
   * 用途：relay /models 端点暴露给前端，让 agent 循环知道当前 tier 的真实上下文窗口，
   * 据此做上下文压缩阈值（取代桌面端硬编码的 5000 字符）。
   *
   * 实现：按 (capability='chat', tier) 查全部启用定价行的 contextWindow，过滤 null 取最小值。
   * 不复用 ChannelRouterService.selectCandidates —— 那会做 round-robin 打乱且只返回单个候选模型，
   * 这里需要"该 tier 下所有可能命中的模型"的交集下界（最保守）。
   *
   * @returns 最小 contextWindow（token）；无任何带 contextWindow 的定价行 → null（前端走保守默认）。
   */
  async lookupMinContextWindow(args: {
    tier: 'FAST' | 'PREMIUM';
  }): Promise<number | null> {
    // tier 候选：精确匹配 tier 或不限版本（null）。nullable enum 用 OR 处理。
    const rows = await this.prisma.modelPricing.findMany({
      where: {
        capability: 'chat',
        enabled: true,
        contextWindow: { not: null },
        OR: [{ tier: args.tier }, { tier: null }],
      },
      select: { contextWindow: true },
    });
    const windows = rows
      .map((r) => r.contextWindow)
      .filter((v): v is number => typeof v === 'number' && v > 0);
    if (windows.length === 0) return null;
    return Math.min(...windows);
  }

  /**
   * 把用量 + 单价换算成灵石。
   *  - PER_TOKEN_*：pricePerUnit = 每 1M token 的灵石数。actual = tokens × pricePerUnit / 1_000_000（浮点，保留精度）。
   *  - PER_CALL：固定 pricePerUnit。
   *  - PER_IMAGE：pricePerUnit × 张数。
   *  - PER_SECOND：pricePerUnit × 秒数（视频生成按时长计费）。秒数向上取整，至少 1 秒（防 0 秒白嫖）。
   * 灵石为 Float（支持小数单价），不再 ceil 强制整数——按真实用量精确计费。
   */
  computeCredits(
    unit: string,
    pricePerUnit: number,
    usage: { inputTokens?: number; outputTokens?: number; images?: number; seconds?: number },
  ): number {
    switch (unit) {
      case 'PER_TOKEN_INPUT': {
        const tokens = usage.inputTokens ?? 0;
        if (tokens <= 0) return 0;
        return (tokens * pricePerUnit) / 1_000_000;
      }
      case 'PER_TOKEN_OUTPUT': {
        const tokens = usage.outputTokens ?? 0;
        if (tokens <= 0) return 0;
        return (tokens * pricePerUnit) / 1_000_000;
      }
      case 'PER_CALL':
        return pricePerUnit;
      case 'PER_IMAGE':
        return pricePerUnit * Math.max(1, usage.images ?? 1);
      case 'PER_SECOND':
        // 秒数向上取整（部分秒按整秒计），至少 1 秒——防 0 秒或负值白嫖。
        return pricePerUnit * Math.max(1, Math.ceil(usage.seconds ?? 0));
      default:
        return pricePerUnit;
    }
  }
}
