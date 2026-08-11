/**
 * AI 内容审核钩子（P0-9 机制先行，不绑定具体供应商）。
 *
 * 设计契约：
 *  - 审核判定是「纯函数」+「可插拔供应商接口」两层。判定逻辑与供应商 IO 解耦，
 *    供应商 IO 在 RelayService 注入（便于单测 mock 供应商而不发真实网络）。
 *  - 语义 **fail-closed**（安全默认）：
 *      · 开关 OFF（未配置）→ 不审核，直接放行（默认行为；W0 决策挂点见下）；
 *      · 开关 ON 且**已配置供应商**但供应商抛错/超时 → **拒绝输出**（绝不静默放行）；
 *      · 命中敏感内容 → **拒绝输出 + 标记需写审计**（审计由调用方落库，本模块只产出判定）。
 *  - W0 决策挂点：**不得在代码里硬编码放行**。若决策 A（外部运营接管）落地，
 *    把 `aiModerationEnabled` 开关语义升为「无条件硬门禁」即可（调用方读取该 key 决定 isEnabled），
 *    本模块对「不可用即拒绝」的 fail-closed 语义保持不变——门禁只是把默认态从 OFF 改 ON。
 *
 * 为什么不内置敏感词表：供应商未定（W0 决策项），本模块只定义「判定函数 + 供应商接口」，
 * 具体敏感词/模型由后续接入的供应商实现，避免提前绑定。
 */

/** 审核判定结果。 */
export type ModerationVerdict =
  /** 放行（开关 OFF、或开关 ON 且供应商判定安全）。 */
  | { allowed: true }
  /** 拒绝：原因 + 是否需写审计（命中敏感内容需审计；供应商不可用同样需审计留痕）。 */
  | { allowed: false; reason: ModerationRejectReason; audit: boolean };

export type ModerationRejectReason =
  /** 命中敏感内容（供应商判定违规）。 */
  | 'sensitive_content'
  /** 已配置审核但供应商调用失败/超时——fail-closed 拒绝。 */
  | 'moderation_unavailable';

/**
 * 可插拔审核供应商接口。具体实现（某云厂商 / 自建模型）在 W0 决策后接入；
 * 本接口是供应商无关的契约，便于 mock 单测。
 */
export interface ModerationProvider {
  /**
   * 判定一段 LLM 输出是否合规。
   * @throws 抛错即视为「供应商不可用」——调用方据此 fail-closed 拒绝（绝不静默放行）。
   */
  judge(text: string): Promise<ModerationProviderResult>;
}

export interface ModerationProviderResult {
  /** 供应商判定是否违规（命中敏感内容）。 */
  flagged: boolean;
  /** 违规类别（可选，供审计 metadata，供应商未给则空）。 */
  categories?: string[];
}

/** 审核上下文：开关状态、供应商（可能为 null）。 */
export interface ModerationContext {
  /** 审核开关是否启用（由 PlatformSetting.aiModerationEnabled 决定，读取端兜底）。 */
  enabled: boolean;
  /** 已配置的供应商；enabled 但 provider 为 null 视为「配置不完整」→ fail-closed 拒绝。 */
  provider: ModerationProvider | null;
}

/**
 * 纯判定入口：给定上下文与待审文本，返回判定。
 * 不碰 DB、不发网络（供应商 IO 由 provider 封装，在调用方注入）。
 *
 * 语义表（与文件头契约一致）：
 *  - !enabled                       → 放行（不审核）。
 *  - enabled && provider == null    → 拒绝（moderation_unavailable，配置不完整，fail-closed）。
 *  - enabled && provider 抛错/超时  → 拒绝（moderation_unavailable，fail-closed，不静默放行）。
 *  - enabled && provider.flagged    → 拒绝（sensitive_content，需审计）。
 *  - enabled && provider 安全       → 放行。
 */
export async function judgeModeration(
  ctx: ModerationContext,
  text: string
): Promise<ModerationVerdict> {
  if (!ctx.enabled) {
    return { allowed: true };
  }
  // 启用但无可用供应商 = 配置不完整 → fail-closed，绝不静默放行。
  if (ctx.provider == null) {
    return {
      allowed: false,
      reason: 'moderation_unavailable',
      audit: true,
    };
  }
  try {
    const result = await ctx.provider.judge(text);
    if (result.flagged) {
      return {
        allowed: false,
        reason: 'sensitive_content',
        audit: true,
        // categories 透传给审计 metadata（若供应商提供）。
      };
    }
    return { allowed: true };
  } catch {
    // 供应商抛错/超时：fail-closed 拒绝（核心反向用例，不得静默放行）。
    return {
      allowed: false,
      reason: 'moderation_unavailable',
      audit: true,
    };
  }
}

/** 审核被拒时的统一错误码（callLog errorCode + 客户端 errorCode）。 */
export const MODERATION_REJECTED_ERROR_CODE = 'content_moderation_rejected';
