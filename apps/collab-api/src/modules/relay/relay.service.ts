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
  forwardOpenAiChatViaAnthropic,
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

/**
 * 从最后一次上游错误中提取「根因摘要」，供调用日志 errorCode + 客户端响应 details 使用。
 *
 * 解决历史诊断盲区：上游（如 Kimi/Moonshot）返回 4xx 时，其 response body 含真实拒绝原因
 * （schema 非法、内容违规、限流、key 失效等），forwarders.ts 已把它存进 UpstreamError.body。
 * 但此前 relay 只抛写死的「上游模型调用失败」并把 body 丢弃，导致后台日志与前端都看不到根因，
 * 用户只能看到无意义的「Bad Request」。本 helper 把 body 解析成可读摘要透传出来。
 *
 * 返回 { upstreamStatus, upstreamDetail }：
 *  - upstreamStatus：上游 HTTP 状态码（无上游错误时为 null）。
 *  - upstreamDetail：根因摘要（≤300 字符）。优先从 body 里抽 message/error 字段；无法解析则返回 body 原文截断。
 */
function extractUpstreamCause(error: unknown): { upstreamStatus: number | null; upstreamDetail: string | null } {
  if (!(error instanceof UpstreamError)) return { upstreamStatus: null, upstreamDetail: null };
  const body = (error.body ?? '').slice(0, 300);
  // 尝试从 JSON body 抽取 message/error.message（OpenAI/Moonshot 错误体常见字段）。
  try {
    const parsed = JSON.parse(error.body ?? '') as { message?: string; error?: { message?: string } | string; msg?: string };
    const msg = parsed.message ?? parsed.msg ?? (typeof parsed.error === 'object' ? parsed.error?.message : undefined);
    if (msg && typeof msg === 'string') {
      return { upstreamStatus: error.httpStatus, upstreamDetail: msg.slice(0, 300) };
    }
  } catch { /* body 非 JSON，回落到原文截断 */ }
  return { upstreamStatus: error.httpStatus, upstreamDetail: body || null };
}

/** 拼接 errorCode：upstream_llm_error + 根因摘要，便于后台调用日志一眼定位。 */
function upstreamErrorCode(error: unknown): string {
  const { upstreamStatus, upstreamDetail } = extractUpstreamCause(error);
  const tag = `upstream_${upstreamStatus ?? 'unknown'}`;
  if (!upstreamDetail) return tag;
  // 截断 100 字符，避免 errorCode 过长（数据库列 + 日志可读性）。
  return `${tag}:${upstreamDetail.slice(0, 100)}`;
}

/**
 * 把 messages 里的 `developer` role 归一化为 `system`（OpenAI 兼容上游统一认 system）。
 *
 * 背景：AI SDK v5 对非 gpt-3/4/chatgpt-4o/gpt-5-chat 开头的 modelId 视为推理模型，把 system message
 * 转成 developer role。灵坊用 fast/premium 哨兵作 modelId，被误判为推理模型 → developer role。
 * 而 Moonshot/Kimi 等上游不支持 developer role（tokenization failed → 400）。
 * developer role 语义与 system 等价（OpenAI 用它区分推理模型的「开发者指令」），归一化为 system
 * 对 OpenAI 系（gpt-5.5，兼容 system）和 Moonshot 系（只认 system）都安全。
 */
function normalizeDeveloperRole(messages: { role: string; content: string }[]): { role: string; content: string }[] {
  return messages.map((m) => (m.role === 'developer' ? { ...m, role: 'system' } : m));
}

@Injectable()
export class RelayService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(CreditService) private readonly credits: CreditService,
    @Inject(ChannelRouterService) private readonly router: ChannelRouterService,
  ) {}

  /** GET /api/relay/v1/models —— 返回两个版本哨兵，并在有鉴权上下文时附带可用资源池。 */
  async listModels(req?: Request) {
    const auth = req?.relayAuth ?? null;
    const poolRefs = auth
      ? await this.prisma.pool.findMany({
        where: { OR: [{ scope: 'SHARED' }, { scope: 'DEDICATED', teamId: auth.teamId }] },
        select: {
          id: true,
          name: true,
          scope: true,
          teamId: true,
          channels: { where: { kind: 'CHAT', status: 'ENABLED' }, select: { tier: true } },
        },
        orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }],
      })
      : [];
    const poolNamesFor = (tier: Tier) => poolRefs
      .filter((pool) => pool.channels.some((channel) => channel.tier === tier))
      .map((pool) => ({ id: pool.id, name: pool.name, scope: pool.scope, teamId: pool.teamId }));
    return {
      object: 'list',
      data: [
        { id: 'fast', object: 'model', owned_by: 'lingfang', label: '快速版', resourcePools: poolNamesFor('FAST') },
        { id: 'premium', object: 'model', owned_by: 'lingfang', label: '高级版', resourcePools: poolNamesFor('PREMIUM') },
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
    // 归一化 role：AI SDK v5（ai@5）对非 gpt-3/4/chatgpt-4o/gpt-5-chat 的 modelId 会把 system 转成
    // developer role（OpenAI 新规范，line: getOpenAILanguageModelCapabilities → systemMessageMode）。
    // 但灵坊用 fast/premium 哨兵作 modelId（不以这些前缀开头）→ 被误判为推理模型 → system 变 developer。
    // Moonshot/Kimi（kimi-for-coding）等上游不认 developer role → tokenization failed → 400。
    // 这里在转发前统一 developer→system：OpenAI 系（gpt-5.5）兼容 system，Moonshot 系只认 system，两边安全。
    const rawMessages = (body.messages as { role: string; content: string }[]) ?? [];
    const messages = normalizeDeveloperRole(rawMessages);
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
      // 客户端是 OpenAI 协议（/chat/completions）：命中 ANTHROPIC 渠道时做协议转换
      // （请求 OpenAI→Anthropic、响应 Anthropic→OpenAI），否则直连 OpenAI 上游。
      forward: (upstreamKey, baseUrl, protocol, model) => {
        const upstreamBody = { ...body, model, messages: injectedMessages };
        if (protocol === 'ANTHROPIC') {
          return forwardOpenAiChatViaAnthropic({ baseUrl, upstreamKey, body: upstreamBody as never, res });
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

  // 版本（fast/premium）下放渠道（R1）：tier 完全由渠道（Channel.tier 标签 + models[]）决定，
  // 而非 API Key scope。API Key 的 `tier:fast`/`tier:premium` scope 仅为「展示性标签」，
  // assertScope 只校验 chat/image/action 三种能力，**从不据 `tier:*` 限版**——这是有意为之：
  // 若对 tier:* 启用强校验，存量未勾选对应 tier 的 key 会被 403（鉴权收紧的破坏性变更）。
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
          // R3-2：钱已扣（reconcile 完成），finalizeLog 失败不得影响已成功的响应，
          // 否则错误冒泡到外层 catch（此时 finalized===true，不会重复退款，但会把成功响应改写成错误）。
          // 包 try/catch：失败记 warn（含 callLogId/charged）+ 重试一次 update，保证日志至少落 success 终态，
          // 避免「扣了费但日志卡 pending/错态」的对账黑洞。
          try {
            await this.finalizeLog(pendingLog.id, { status: 'success', errorCode: null, httpStatus: 200, channelId: routed.id, model: cand.model, durationMs: Date.now() - startedAt, usage, credits: charged });
          } catch (logErr) {
            const msg = logErr instanceof Error ? logErr.message : String(logErr);
            console.warn(`[relay] finalizeLog failed after successful charge (callLogId=${pendingLog.id}, charged=${charged}): ${msg}`);
            try {
              await this.finalizeLog(pendingLog.id, { status: 'success', errorCode: null, httpStatus: 200, channelId: routed.id, model: cand.model, durationMs: Date.now() - startedAt, usage, credits: charged });
            } catch { /* 二次失败仅吞掉：响应已成功，扣费已正确，留 warn 供人工对账 */ }
          }
          return;
        } catch (e) {
          lastError = e;
          if (res.headersSent) {
            // 流式已发头：无法故障转移。R3-3 产品取舍——流式中断一律「全额退预扣、不计费」，
            // 即使部分 chunk 已透传（利于用户、对平台有损，接受为 MVP；后续可按已收 usage 部分计费）。
            // 这里不可能误扣用户：reconcile 仅在成功路径调用，发头后失败只走 refund。
            await this.credits.refund(auth.teamId, cap, pendingLog.id, auth.userId);
            await ensureFinalized({ status: 'upstream_error', errorCode: e instanceof UpstreamError ? upstreamErrorCode(e) : 'upstream_llm_error', httpStatus: e instanceof UpstreamError ? e.httpStatus : 502, channelId: cand.id, model: cand.model });
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
        throw new AppError(503, 'pricing_not_configured', `渠道模型未配置定价：${modelNames}。请在「模型接入」为这些模型添加定价。`);
      }
      const httpStatus = lastError instanceof UpstreamError ? lastError.httpStatus : 502;
      const { upstreamStatus, upstreamDetail } = extractUpstreamCause(lastError);
      // errorCode 带上游根因摘要，后台「调用日志」可一眼看到 Kimi/Moonshot 真实拒绝原因。
      const errorCode = lastError instanceof UpstreamError ? upstreamErrorCode(lastError) : 'upstream_llm_error';
      await ensureFinalized({ status: 'upstream_error', errorCode, httpStatus, channelId: lastCand?.id ?? null, model: lastCand?.model ?? '(none)' });
      // details 透传上游真实原因（status + body 摘要），客户端据此显示可读错误而非无意义 statusText。
      throw new AppError(httpStatus, 'upstream_llm_error', '上游模型调用失败', { upstreamStatus, upstreamDetail });
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
