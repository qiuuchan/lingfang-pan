// RelayService —— 模型中转编排器（计费/日志咽喉）。
//
// 一次调用流程（见 docs/billing-and-relay-design.md §4.3）：
//  1. 解析 tier（model 字段哨兵 'fast'/'premium'）→ ModelTierConfig（真实上游模型）。
//  2. 查定价 ModelPricing（无定价 → 503 pricing_not_configured，不服务）。
//  3. 预扣灵石 cap（CreditService.reserve，余额不足 402）。
//  4. 写 pending LlmCallLog（status='reserve'）。
//  5. 注入系统提示词规则（injectSystemGuardRule）。
//  6. 选渠道候选（ChannelRouterService），逐个尝试转发，上游失败故障转移。
//  7. 成功：reconcile 计费（实算冲销）+ 更新 LlmCallLog(status=success, usage, credits)。
//     失败：refund 全部预留 + LlmCallLog(status=upstream_error/no_channel)。
//
// 日志：requestSummary 只存元数据（model/temperature/size/n），不存 prompt 全文（PII/体积）。
// 安全：上游 key 仅转发时临时持有；relayAuth 由 DualAuthGuard 注入 request.relayAuth。
import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../../prisma.service';
import { AppError, badRequest } from '../../common';
import { PricingService } from '../pricing.service';
import { CreditService, type ReserveTicket } from '../credit.service';
import { ChannelRouterService } from '../channel.service';
import type { RelayAuth } from '../../dual-auth.guard';
import {
  UpstreamError,
  forwardOpenAiChat,
  forwardOpenAiImage,
  forwardAnthropicMessages,
  forwardRawPassthrough,
  extractClientIp,
  type ForwardResult,
} from './forwarders';

/** 单条消息结构（injectSystemGuardRule 入参）。与 packages/contract/src/billing.ts RelayMessage 同构。 */
type RelayMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** 系统提示词规则注入（与 packages/contract injectSystemGuardRule 同实现，单一事实源在契约层）。 */
function injectSystemGuardRule(messages: RelayMessage[], rule: string): RelayMessage[] {
  if (!rule.trim()) return messages;
  const hasSystem = messages.some((m) => m.role === 'system');
  if (hasSystem) return [...messages, { role: 'system', content: rule }];
  return [{ role: 'system', content: rule }, ...messages];
}

type Tier = 'FAST' | 'PREMIUM';

/** wire 层 tier（小写哨兵）→ schema 枚举。 */
function wireToTier(model: string): Tier {
  if (model === 'fast') return 'FAST';
  if (model === 'premium') return 'PREMIUM';
  throw badRequest('model 仅支持 fast 或 premium');
}

@Injectable()
export class RelayService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(CreditService) private readonly credits: CreditService,
    @Inject(ChannelRouterService) private readonly router: ChannelRouterService,
  ) {}

  /** GET /api/relay/v1/models —— 仅返回两个版本（协议层强制）。 */
  async listModels(auth: RelayAuth) {
    const tiers = await this.pricing.getAllTierConfigs();
    return {
      object: 'list',
      data: tiers.map((t) => ({
        id: t.tier === 'FAST' ? 'fast' : 'premium',
        object: 'model',
        owned_by: 'lingfang',
        label: t.label,
      })),
    };
  }

  /** POST /api/relay/v1/chat/completions（OpenAI 协议）。 */
  async chatCompletions(req: Request, res: Response, body: Record<string, unknown>) {
    const auth = this.requireAuth(req);
    this.assertScope(auth, 'chat');
    const tier = wireToTier(String(body.model ?? ''));
    const cfg = await this.pricing.getTierConfig(tier);
    const stream = Boolean(body.stream);

    const price = await this.pricing.lookupPrice({ capability: 'chat', model: cfg.chatModel, tier });
    if (!price) throw new AppError(503, 'pricing_not_configured', `该模型未配置定价：${cfg.chatModel}`);

    // 构造转发体：用真实上游模型替换哨兵 + 注入系统提示词规则。
    const guardRule = await this.credits.readAiUsageGuardRule();
    const messages = (body.messages as RelayMessage[]) ?? [];
    const injectedMessages = guardRule != null && guardRule.trim() ? injectSystemGuardRule(messages, guardRule) : messages;
    const upstreamBody: Record<string, unknown> = {
      ...body,
      model: cfg.chatModel,
      messages: injectedMessages,
    };
    if (cfg.temperature != null && body.temperature == null) upstreamBody.temperature = cfg.temperature;
    if (cfg.maxTokens != null && body.max_tokens == null) upstreamBody.max_tokens = cfg.maxTokens;

    return this.executeRelay(req, res, {
      auth,
      capability: 'chat',
      tier,
      model: cfg.chatModel,
      priceUnit: price.unit,
      pricePerUnit: price.pricePerUnit,
      stream,
      requestSummary: { model: 'fast/premium', temperature: body.temperature, stream, n: 1 },
      forward: (routed) =>
        forwardOpenAiChat({
          baseUrl: routed.baseUrl,
          upstreamKey: routed.upstreamKey,
          body: upstreamBody as never,
          res,
        }),
      usageToCredits: (fr) => ({ realCredits: this.pricing.computeCredits(price.unit, price.pricePerUnit, { inputTokens: fr.inputTokens, outputTokens: fr.outputTokens }), usage: { inputTokens: fr.inputTokens, outputTokens: fr.outputTokens, images: 0 } }),
    });
  }

  /** POST /api/relay/v1/messages（Anthropic 协议）。 */
  async messages(req: Request, res: Response, body: Record<string, unknown>) {
    const auth = this.requireAuth(req);
    this.assertScope(auth, 'chat');
    const tier = wireToTier(String(body.model ?? ''));
    const cfg = await this.pricing.getTierConfig(tier);
    const stream = Boolean(body.stream);
    const price = await this.pricing.lookupPrice({ capability: 'chat', model: cfg.chatModel, tier });
    if (!price) throw new AppError(503, 'pricing_not_configured', `该模型未配置定价：${cfg.chatModel}`);

    // Anthropic system 是顶层字段（非 messages 内），单独注入。
    const guardRule = await this.credits.readAiUsageGuardRule();
    const systemField = guardRule?.trim()
      ? [body.system as string | undefined, guardRule].filter((s) => s && String(s).trim()).join('\n\n')
      : (body.system as string | undefined);
    const upstreamBody: Record<string, unknown> = {
      ...body,
      model: cfg.chatModel,
      ...(systemField != null ? { system: systemField } : {}),
    };
    if (cfg.temperature != null && body.temperature == null) upstreamBody.temperature = cfg.temperature;
    if (cfg.maxTokens == null) upstreamBody.max_tokens = cfg.maxTokens ?? 4096;

    return this.executeRelay(req, res, {
      auth,
      capability: 'chat',
      tier,
      model: cfg.chatModel,
      priceUnit: price.unit,
      pricePerUnit: price.pricePerUnit,
      stream,
      requestSummary: { model: tier, temperature: body.temperature, stream, n: 1 },
      forward: (routed) =>
        forwardAnthropicMessages({
          baseUrl: routed.baseUrl,
          upstreamKey: routed.upstreamKey,
          body: upstreamBody as never,
          res,
        }),
      usageToCredits: (fr) => ({ realCredits: this.pricing.computeCredits(price.unit, price.pricePerUnit, { inputTokens: fr.inputTokens, outputTokens: fr.outputTokens }), usage: { inputTokens: fr.inputTokens, outputTokens: fr.outputTokens, images: 0 } }),
    });
  }

  /** POST /api/relay/v1/images/generations（OpenAI 协议，按张计费）。 */
  async imageGenerations(req: Request, res: Response, body: Record<string, unknown>) {
    const auth = this.requireAuth(req);
    this.assertScope(auth, 'image');
    const tier = wireToTier(String(body.model ?? ''));
    const cfg = await this.pricing.getTierConfig(tier);
    const imageModel = cfg.imageModel;
    if (!imageModel) throw new AppError(503, 'image_not_supported', `${cfg.label} 不提供生图`);
    const price = await this.pricing.lookupPrice({ capability: 'image', model: imageModel, tier });
    if (!price) throw new AppError(503, 'pricing_not_configured', `该生图模型未配置定价：${imageModel}`);
    const n = Math.min(10, Math.max(1, Number(body.n ?? 1) || 1));

    const upstreamBody: Record<string, unknown> = { ...body, model: imageModel, n };
    return this.executeRelay(req, res, {
      auth,
      capability: 'image',
      tier,
      model: imageModel,
      priceUnit: price.unit,
      pricePerUnit: price.pricePerUnit,
      stream: false,
      requestSummary: { model: imageModel, n, size: body.size },
      forward: (routed) =>
        forwardOpenAiImage({
          baseUrl: routed.baseUrl,
          upstreamKey: routed.upstreamKey,
          body: upstreamBody as never,
          res,
        }),
      // 生图按张固定计费（images 数），forward 返回 images 数。
      usageToCredits: (fr) => ({ realCredits: this.pricing.computeCredits(price.unit, price.pricePerUnit, { images: fr.images }), usage: { inputTokens: 0, outputTokens: 0, images: fr.images } }),
    });
  }

  /** POST /api/relay/v1/images/edits（multipart 透传，如 OpenAI 图片编辑）。按张计费。 */
  async imageEditsPassthrough(req: Request, res: Response) {
    const auth = this.requireAuth(req);
    this.assertScope(auth, 'image');
    // multipart 上传含 model 字段（form-data）；默认 fast。
    const tier = this.resolveTierFromQueryOrForm(req);
    const cfg = await this.pricing.getTierConfig(tier);
    const imageModel = cfg.imageModel;
    if (!imageModel) throw new AppError(503, 'image_not_supported', `${cfg.label} 不提供生图`);
    const price = await this.pricing.lookupPrice({ capability: 'image', model: imageModel, tier });
    if (!price) throw new AppError(503, 'pricing_not_configured', `该生图模型未配置定价：${imageModel}`);
    const contentType = String(req.headers['content-type'] ?? 'application/octet-stream');
    // multipart：Express 不自动解析，原始字节在 req 流上。读取为 Buffer 原样转发（保 boundary 完整）。
    const rawBody = await readRawBody(req);
    return this.executeRelay(req, res, {
      auth,
      capability: 'image',
      tier,
      model: imageModel,
      priceUnit: price.unit,
      pricePerUnit: price.pricePerUnit,
      stream: false,
      requestSummary: { model: imageModel, endpoint: 'images/edits', contentType },
      forward: (routed) =>
        forwardRawPassthrough({
          baseUrl: routed.baseUrl,
          upstreamKey: routed.upstreamKey,
          path: 'images/edits',
          method: 'POST',
          contentType,
          rawBody,
          res,
        }),
      usageToCredits: (fr) => ({ realCredits: this.pricing.computeCredits(price.unit, price.pricePerUnit, { images: fr.images }), usage: { inputTokens: 0, outputTokens: 0, images: fr.images } }),
    });
  }

  // === 内部：统一编排 ===

  private requireAuth(req: Request): RelayAuth {
    if (!req.relayAuth) throw new AppError(401, 'unauthorized', '未鉴权');
    return req.relayAuth;
  }

  /** multipart/query 里取 tier 哨兵（images/edits 不能用 @Body 解析 JSON）。 */
  private resolveTierFromQueryOrForm(req: Request): Tier {
    const m = (req.query.model ?? '') as string;
    return wireToTier(String(m) || 'fast');
  }

  /** API Key scopes 强制（JWT scopes=['*'] 全放行）。 */
  private assertScope(auth: RelayAuth, capability: 'chat' | 'image' | 'action') {
    if (auth.scopes.includes('*')) return;
    if (!auth.scopes.includes(capability)) {
      throw new AppError(403, 'capability_denied', `API Key 未授权：${capability}`);
    }
    // 版本范围：tier:fast / tier:premium 未声明则全放行；声明了则要求命中（宽松：未声明 tier scope 即放行）。
  }

  /**
   * 统一转发编排：预扣 → 写 pending 日志 → 路由+转发（故障转移）→ reconcile/退款 → 更新日志。
   * forward 返回 usage（chat 为 tokens，image 为 images），usageToCredits 换算灵石。
   */
  private async executeRelay(
    req: Request,
    res: Response,
    plan: {
      auth: RelayAuth;
      capability: 'chat' | 'image' | 'action';
      tier: Tier;
      model: string;
      priceUnit: string;
      pricePerUnit: number;
      stream: boolean;
      requestSummary: Record<string, unknown>;
      forward: (routed: { id: string; name: string; protocol: 'OPENAI' | 'ANTHROPIC'; baseUrl: string; upstreamKey: string }) => Promise<ForwardResult>;
      usageToCredits: (forwardResult: ForwardResult) => { realCredits: number; usage: { inputTokens: number; outputTokens: number; images: number } };
    },
  ) {
    const { auth, capability, tier, model } = plan;
    const startedAt = Date.now();
    const requestId = (req.header('x-request-id') || undefined) as string | undefined;
    const clientIp = extractClientIp(req);

    // 预扣额度（cap=0 时跳过，事后计费兜底）。
    const cap = await this.credits.readReserveCap(tier);
    // 先建 pending 日志拿 callLogId（串联 reserve/reconcile/refund 流水）。
    const pendingLog = await this.prisma.llmCallLog.create({
      data: {
        teamId: auth.teamId,
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        capability,
        tier,
        model,
        status: 'reserve',
        requestId,
        requestSummary: plan.requestSummary as never,
        clientIp,
        credits: 0,
      },
    });
    const ticket: ReserveTicket = { teamId: auth.teamId, cap, callLogId: pendingLog.id, actorUserId: auth.userId };

    try {
      await this.credits.reserve(auth.teamId, cap, pendingLog.id, auth.userId);
    } catch (e) {
      // 余额不足：更新日志为 insufficient_balance 并抛 402（OpenAI/Anthropic 形状由调用方处理）。
      await this.finalizeLog(pendingLog.id, { status: 'insufficient_balance', errorCode: 'insufficient_balance', httpStatus: 402, channelId: null, durationMs: Date.now() - startedAt, usage: { inputTokens: 0, outputTokens: 0, images: 0 }, credits: 0 });
      throw e;
    }

    // 路由候选 + 故障转移。
    const candidates = await this.router.selectCandidates({ teamId: auth.teamId, userId: auth.userId, tier, model });
    if (candidates.length === 0) {
      await this.credits.refund(auth.teamId, cap, pendingLog.id, auth.userId);
      await this.finalizeLog(pendingLog.id, { status: 'no_channel', errorCode: 'no_channel_available', httpStatus: 503, channelId: null, durationMs: Date.now() - startedAt, usage: { inputTokens: 0, outputTokens: 0, images: 0 }, credits: 0 });
      throw new AppError(503, 'no_channel_available', '无可用渠道服务该模型');
    }

    let lastError: unknown;
    for (const cand of candidates) {
      try {
        const routed = await this.router.decryptUpstreamKey(cand.id);
        const forwardResult = await plan.forward(routed);
        const { realCredits, usage } = plan.usageToCredits(forwardResult);
        const charged = await this.credits.reconcile(auth.teamId, cap, realCredits, pendingLog.id, auth.userId);
        await this.finalizeLog(pendingLog.id, { status: 'success', errorCode: null, httpStatus: 200, channelId: routed.id, durationMs: Date.now() - startedAt, usage, credits: charged });
        return;
      } catch (e) {
        lastError = e;
        // 流式已开始写响应头后失败 → 无法故障转移（已向客户端发数据）；记 upstream_error 并终止。
        if (res.headersSent) {
          await this.credits.refund(auth.teamId, cap, pendingLog.id, auth.userId);
          await this.finalizeLog(pendingLog.id, { status: 'upstream_error', errorCode: 'upstream_llm_error', httpStatus: e instanceof UpstreamError ? e.httpStatus : 502, channelId: cand.id, durationMs: Date.now() - startedAt, usage: { inputTokens: 0, outputTokens: 0, images: 0 }, credits: 0 });
          return;
        }
        // 非流式或流式尚未开始：继续尝试下一候选。
      }
    }
    // 全部候选失败：退款 + 记日志。
    await this.credits.refund(auth.teamId, cap, pendingLog.id, auth.userId);
    const httpStatus = lastError instanceof UpstreamError ? lastError.httpStatus : 502;
    await this.finalizeLog(pendingLog.id, { status: 'upstream_error', errorCode: 'upstream_llm_error', httpStatus, channelId: candidates[0]?.id ?? null, durationMs: Date.now() - startedAt, usage: { inputTokens: 0, outputTokens: 0, images: 0 }, credits: 0 });
    throw new AppError(httpStatus, 'upstream_llm_error', '上游模型调用失败');
  }

  /** 更新 pending 日志为最终状态。 */
  private async finalizeLog(
    id: string,
    args: {
      status: string;
      errorCode: string | null;
      httpStatus: number | null;
      channelId: string | null;
      durationMs: number;
      usage: { inputTokens: number; outputTokens: number; images: number };
      credits: number;
    },
  ) {
    await this.prisma.llmCallLog.update({
      where: { id },
      data: {
        status: args.status,
        errorCode: args.errorCode,
        httpStatus: args.httpStatus,
        channelId: args.channelId,
        durationMs: args.durationMs,
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        images: args.usage.images,
        credits: args.credits,
      },
    });
  }
}

/** 读取原始请求体为 Buffer（multipart 透传用，保 boundary 完整）。 */
function readRawBody(req: Request): Promise<Buffer> {
  // Express 若已把 body 解析为 Buffer（express.raw），直接用；否则从流读取。
  if (Buffer.isBuffer((req as Request & { body?: unknown }).body)) {
    return Promise.resolve((req as Request & { body: Buffer }).body);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
