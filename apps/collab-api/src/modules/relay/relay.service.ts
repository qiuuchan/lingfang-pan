// RelayService —— 模型中转编排器（计费/日志咽喉）。
//
// 资源池重构（2026-06-23）后：版本=渠道标签（非 ModelTierConfig 固定映射）。
// 一次调用流程：
//  1. 解析 tier（model 字段哨兵 fast/premium）+ kind（chat→CHAT / image→IMAGE）。
//  2. 预扣灵石 cap（按 tier，CreditService.reserve）。
//  3. 写 pending LlmCallLog。
//  4. 注入系统提示词规则（chat）。
//  5. 选渠道+模型候选（ChannelRouterService.selectCandidates，round-robin 起点随机）。
//     每个候选 = {channel, model}；逐个尝试，按候选 model 查定价、转发，失败故障转移。
//  6. 成功：reconcile 计费（按命中 model 的单价）+ 更新日志。
//     失败：refund + 日志记 upstream_error / no_channel。
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

type Tier = 'FAST' | 'PREMIUM';
type Kind = 'CHAT' | 'IMAGE';

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

  /** GET /api/relay/v1/models —— 仅返回两个版本哨兵（协议层强制）。 */
  async listModels() {
    return {
      object: 'list',
      data: [
        { id: 'fast', object: 'model', owned_by: 'lingfang', label: '快速版' },
        { id: 'premium', object: 'model', owned_by: 'lingfang', label: '高级版' },
      ],
    };
  }

  /** POST /api/relay/v1/chat/completions（OpenAI 协议）。 */
  async chatCompletions(req: Request, res: Response, body: Record<string, unknown>) {
    const auth = this.requireAuth(req);
    this.assertScope(auth, 'chat');
    const tier = wireToTier(String(body.model ?? ''));
    const stream = Boolean(body.stream);

    // 注入系统提示词规则。
    const guardRule = await this.credits.readAiUsageGuardRule();
    const messages = (body.messages as { role: string; content: string }[]) ?? [];
    const injectedMessages = guardRule?.trim()
      ? (guardRule ? this.injectGuard(messages, guardRule) : messages)
      : messages;

    return this.executeRelay(req, res, {
      auth,
      kind: 'CHAT',
      tier,
      stream,
      requestSummary: { tier, temperature: body.temperature, stream },
      // 转发：把 model 替换为候选的真实上游模型 + 注入后的 messages。
      forward: (upstreamKey, baseUrl, protocol, model) => {
        const upstreamBody = { ...body, model, messages: injectedMessages };
        if (protocol === 'ANTHROPIC') {
          return forwardAnthropicMessages({ baseUrl, upstreamKey, body: upstreamBody as never, res });
        }
        return forwardOpenAiChat({ baseUrl, upstreamKey, body: upstreamBody as never, res });
      },
    });
  }

  /** POST /api/relay/v1/messages（Anthropic 协议）。 */
  async messages(req: Request, res: Response, body: Record<string, unknown>) {
    const auth = this.requireAuth(req);
    this.assertScope(auth, 'chat');
    const tier = wireToTier(String(body.model ?? ''));
    const stream = Boolean(body.stream);
    const guardRule = await this.credits.readAiUsageGuardRule();
    const systemField = guardRule?.trim()
      ? [body.system as string | undefined, guardRule].filter((s) => s && String(s).trim()).join('\n\n')
      : (body.system as string | undefined);

    return this.executeRelay(req, res, {
      auth,
      kind: 'CHAT',
      tier,
      stream,
      requestSummary: { tier, temperature: body.temperature, stream },
      forward: (upstreamKey, baseUrl, _protocol, model) => {
        const upstreamBody = { ...body, model, ...(systemField != null ? { system: systemField } : {}) };
        return forwardAnthropicMessages({ baseUrl, upstreamKey, body: upstreamBody as never, res });
      },
    });
  }

  /** POST /api/relay/v1/images/generations（OpenAI 协议，按张计费）。 */
  async imageGenerations(req: Request, res: Response, body: Record<string, unknown>) {
    const auth = this.requireAuth(req);
    this.assertScope(auth, 'image');
    const tier = wireToTier(String(body.model ?? ''));
    const n = Math.min(10, Math.max(1, Number(body.n ?? 1) || 1));

    return this.executeRelay(req, res, {
      auth,
      kind: 'IMAGE',
      tier,
      stream: false,
      requestSummary: { tier, n, size: body.size },
      forward: (upstreamKey, baseUrl, _protocol, model) => {
        const upstreamBody = { ...body, model, n };
        return forwardOpenAiImage({ baseUrl, upstreamKey, body: upstreamBody as never, res });
      },
    });
  }

  /** POST /api/relay/v1/images/edits（multipart 透传，按张计费）。 */
  async imageEditsPassthrough(req: Request, res: Response) {
    const auth = this.requireAuth(req);
    this.assertScope(auth, 'image');
    const tier = this.resolveTierFromQuery(req);
    const contentType = String(req.headers['content-type'] ?? 'application/octet-stream');
    return this.executeRelay(req, res, {
      auth,
      kind: 'IMAGE',
      tier,
      stream: false,
      requestSummary: { tier, endpoint: 'images/edits', contentType },
      forward: async (upstreamKey, baseUrl) => {
        const rawBody = await readRawBody(req);
        const fr = await forwardRawPassthrough({
          baseUrl, upstreamKey, path: 'images/edits', method: 'POST', contentType, rawBody: Buffer.from(rawBody), res,
        });
        return fr;
      },
    });
  }

  // === 内部：统一编排 ===

  private requireAuth(req: Request): RelayAuth {
    if (!req.relayAuth) throw new AppError(401, 'unauthorized', '未鉴权');
    return req.relayAuth;
  }

  private assertScope(auth: RelayAuth, capability: 'chat' | 'image' | 'action') {
    if (auth.scopes.includes('*')) return;
    if (!auth.scopes.includes(capability)) throw new AppError(403, 'capability_denied', `API Key 未授权：${capability}`);
  }

  private resolveTierFromQuery(req: Request): Tier {
    return wireToTier(String((req.query.model ?? 'fast') as string));
  }

  /** 把规则注入 messages（OpenAI）：已有 system 追加一段，否则前插。 */
  private injectGuard(messages: { role: string; content: string }[], rule: string): { role: string; content: string }[] {
    const hasSystem = messages.some((m) => m.role === 'system');
    if (hasSystem) return [...messages, { role: 'system', content: rule }];
    return [{ role: 'system', content: rule }, ...messages];
  }

  /**
   * 统一转发编排。candidates 每个自带 model；定价按命中候选的 model 查。
   * forward(upstreamKey, baseUrl, protocol, model) → ForwardResult。
   */
  private async executeRelay(
    req: Request,
    res: Response,
    plan: {
      auth: RelayAuth;
      kind: Kind;
      tier: Tier;
      stream: boolean;
      requestSummary: Record<string, unknown>;
      forward: (upstreamKey: string, baseUrl: string, protocol: 'OPENAI' | 'ANTHROPIC', model: string) => Promise<ForwardResult>;
    },
  ) {
    const { auth, kind, tier } = plan;
    const startedAt = Date.now();
    const requestId = (req.header('x-request-id') || undefined) as string | undefined;
    const clientIp = extractClientIp(req);
    const capability: 'chat' | 'image' = kind === 'CHAT' ? 'chat' : 'image';

    const cap = await this.credits.readReserveCap(tier);
    const pendingLog = await this.prisma.llmCallLog.create({
      data: {
        teamId: auth.teamId,
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        capability,
        tier,
        model: '(pending)',
        status: 'reserve',
        requestId,
        requestSummary: plan.requestSummary as never,
        clientIp,
        credits: 0,
      },
    });
    const ticket: ReserveTicket = { teamId: auth.teamId, cap, callLogId: pendingLog.id, actorUserId: auth.userId };
    // finalizedRef：确保 pendingLog 至少被 finalize 一次（防 catch 链中途抛错导致日志永久卡 pending）。
    let finalized = false;
    const ensureFinalized = async (args: { status: string; errorCode: string | null; httpStatus: number | null; channelId: string | null; model: string }) => {
      if (finalized) return;
      finalized = true;
      try {
        await this.finalizeLog(pendingLog.id, { ...args, durationMs: Date.now() - startedAt, usage: { inputTokens: 0, outputTokens: 0, images: 0 }, credits: 0 });
      } catch { /* finalize 本身失败不阻断主流程（避免吞掉真实错误） */ }
    };

    try {
      try {
        await this.credits.reserve(auth.teamId, cap, pendingLog.id, auth.userId);
      } catch (e) {
        await ensureFinalized({ status: 'insufficient_balance', errorCode: 'insufficient_balance', httpStatus: 402, channelId: null, model: '(reserve-failed)' });
        throw e;
      }

      const candidates = await this.router.selectCandidates({ teamId: auth.teamId, kind, tier });
      if (candidates.length === 0) {
        await this.credits.refund(auth.teamId, cap, pendingLog.id, auth.userId);
        await ensureFinalized({ status: 'no_channel', errorCode: 'no_channel_available', httpStatus: 503, channelId: null, model: '(no-channel)' });
        throw new AppError(503, 'no_channel_available', `无可用${kind === 'CHAT' ? '聊天' : '生图'}渠道（${tier === 'FAST' ? '快速' : '高级'}版）`);
      }

      let lastError: unknown;
      let lastCand: { id: string; model: string } | null = null;
      let skippedForNoPricing = 0; // 因无定价被跳过的候选数
      for (const cand of candidates) {
        lastCand = { id: cand.id, model: cand.model };
        // 按候选 model 查定价；无定价则跳过该候选（不能盲调不扣费）。
        const price = await this.pricing.lookupPrice({ capability, model: cand.model, tier });
        if (!price) { skippedForNoPricing++; continue; }
        try {
          const routed = await this.router.decryptUpstreamKey(cand.id);
          const fr = await plan.forward(routed.upstreamKey, routed.baseUrl, routed.protocol, cand.model);
          // 计费：按命中 model 的单价。
          const usage = { inputTokens: fr.inputTokens, outputTokens: fr.outputTokens, images: fr.images };
          const realCredits = this.pricing.computeCredits(price.unit, price.pricePerUnit, usage);
          const charged = await this.credits.reconcile(auth.teamId, cap, realCredits, pendingLog.id, auth.userId);
          finalized = true; // 成功路径手动置位（ensureFinalized 跳过，保留 usage/credits）
          await this.finalizeLog(pendingLog.id, { status: 'success', errorCode: null, httpStatus: 200, channelId: routed.id, model: cand.model, durationMs: Date.now() - startedAt, usage, credits: charged });
          return;
        } catch (e) {
          lastError = e;
          if (res.headersSent) {
            // 流式已发头：无法故障转移，退款 + 终态。
            await this.credits.refund(auth.teamId, cap, pendingLog.id, auth.userId);
            await ensureFinalized({ status: 'upstream_error', errorCode: 'upstream_llm_error', httpStatus: e instanceof UpstreamError ? e.httpStatus : 502, channelId: cand.id, model: cand.model });
            return;
          }
          // 非流式：继续下一候选（故障转移）。
        }
      }
      // 全部候选失败：退款 + 终态 + 抛错。区分「全无定价」与「上游失败」。
      await this.credits.refund(auth.teamId, cap, pendingLog.id, auth.userId);
      if (lastError === undefined && skippedForNoPricing === candidates.length) {
        // 所有候选都因无定价被跳过：明确提示配价，而非笼统 upstream_error。
        const modelNames = Array.from(new Set(candidates.map((c) => c.model))).join('、');
        await ensureFinalized({ status: 'no_pricing', errorCode: 'pricing_not_configured', httpStatus: 503, channelId: null, model: modelNames || '(none)' });
        throw new AppError(503, 'pricing_not_configured', `渠道模型未配置定价：${modelNames}。请在「计费配置」为这些模型添加定价。`);
      }
      const httpStatus = lastError instanceof UpstreamError ? lastError.httpStatus : 502;
      await ensureFinalized({ status: 'upstream_error', errorCode: 'upstream_llm_error', httpStatus, channelId: lastCand?.id ?? null, model: lastCand?.model ?? '(none)' });
      throw new AppError(httpStatus, 'upstream_llm_error', '上游模型调用失败');
    } catch (e) {
      // 任何未预期错误：退款兜底（防灵石泄漏）+ 确保日志终态，再原样抛给客户端。
      if (!finalized) {
        try { await this.credits.refund(auth.teamId, cap, pendingLog.id, auth.userId); } catch { /* 忽略 */ }
        // 把原生错误信息记入 errorCode（前 120 字），便于后台调用日志直接看到根因（如 Prisma 列类型错）。
        const errMsg = e instanceof Error ? e.message : String(e);
        const errCode = e instanceof AppError ? e.code : `internal:${errMsg.slice(0, 120)}`;
        await ensureFinalized({ status: 'client_error', errorCode: errCode, httpStatus: e instanceof AppError ? (e as AppError).status : 500, channelId: null, model: '(error)' });
        // 抛给客户端的消息也带根因（debug 友好）。
        if (e instanceof AppError) throw e;
        throw new AppError(500, 'internal', `relay 内部错误：${errMsg}`, { error: errMsg });
      }
      throw e;
    }
  }

  private async finalizeLog(
    id: string,
    args: {
      status: string; errorCode: string | null; httpStatus: number | null;
      channelId: string | null; model: string; durationMs: number;
      usage: { inputTokens: number; outputTokens: number; images: number }; credits: number;
    },
  ) {
    await this.prisma.llmCallLog.update({
      where: { id },
      data: {
        status: args.status, errorCode: args.errorCode, httpStatus: args.httpStatus,
        channelId: args.channelId, model: args.model, durationMs: args.durationMs,
        inputTokens: args.usage.inputTokens, outputTokens: args.usage.outputTokens, images: args.usage.images, credits: args.credits,
      },
    });
  }
}

/** 读取原始请求体为 Uint8Array（multipart 透传用）。 */
function readRawBody(req: Request): Promise<Uint8Array> {
  if (Buffer.isBuffer((req as Request & { body?: unknown }).body)) {
    return Promise.resolve(new Uint8Array((req as Request & { body: Buffer }).body));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
