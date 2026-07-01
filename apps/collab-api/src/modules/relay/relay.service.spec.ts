// RelayService 集成级单测（R3「未成功对话仍扣费」修复的回归锁）。
//
// 目标：对 executeRelay 的每条失败/成功出口，断言计费时机正确——
//   - 失败路径：reconcile **从不**被调用；refund 调用次数（cap>0 失败=1；cap=0 任意=0）；团队余额净变化==0。
//   - 成功路径：reconcile 恰 1 次、charged==min(real,cap)；refund **从不**被调用。
//
// Mock 策略（参考 credit.service.spec.ts）：Mock CreditService/PricingService/ChannelRouterService/Prisma，
// 并 vi.mock('./forwarders') 拦截上游转发（不发真实网络）。CreditService 用「余额净变化」状态机模拟，
// 使「失败不净扣费 / 成功只扣一次」可被精确断言。
import { describe, expect, it, vi, beforeEach } from 'vitest';

// 拦截转发器：保留真实 UpstreamError（供 instanceof 判定），其余转发函数 mock。
vi.mock('./forwarders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./forwarders')>();
  return {
    ...actual,
    forwardOpenAiChat: vi.fn(),
    forwardOpenAiImage: vi.fn(),
    forwardAnthropicMessages: vi.fn(),
    forwardRawPassthrough: vi.fn(),
    extractClientIp: vi.fn(() => '127.0.0.1'),
  };
});

import { RelayService } from './relay.service';
import * as forwarders from './forwarders';
import { UpstreamError } from './forwarders';

const forwardOpenAiChat = forwarders.forwardOpenAiChat as unknown as ReturnType<typeof vi.fn>;

/** CreditService 模拟：用「团队余额净变化（net）」状态机精确反映 reserve/reconcile/refund 的资金效果。 */
function makeCredits(cap: number, opts: { reserveThrows?: boolean; cap0Balance?: number } = {}) {
  let net = 0; // 相对调用前的团队余额净变化（应在失败路径恒为 0）
  let reserved = false;
  let cap0Balance = opts.cap0Balance ?? Number.POSITIVE_INFINITY; // cap=0 路径的可扣余额上限
  return {
    readReserveCap: vi.fn(async () => cap),
    readAiUsageGuardRule: vi.fn(async () => null),
    reserve: vi.fn(async (_teamId: string, c: number) => {
      if (opts.reserveThrows) {
        const { insufficientBalance } = await import('../../common');
        throw insufficientBalance();
      }
      if (c > 0) { net -= c; reserved = true; }
      return c;
    }),
    reconcile: vi.fn(async (_teamId: string, c: number, real: number) => {
      if (c > 0) {
        net += c; // 退回全部预扣
        const charge = Math.min(real, c);
        net -= charge; // 实扣
        return charge;
      }
      // cap=0：条件扣款防透支（余额不足扣到 0）。
      const charge = Math.min(Math.max(0, real), Math.max(0, cap0Balance));
      net -= charge;
      cap0Balance -= charge;
      return charge;
    }),
    refund: vi.fn(async (_teamId: string, c: number) => {
      if (c > 0 && reserved) { net += c; reserved = false; }
    }),
    __net: () => net,
  };
}

function makeRouterCandidate(model = 'gpt-x') {
  return { id: 'ch1', name: 'c1', kind: 'CHAT' as const, tier: 'FAST' as const, protocol: 'OPENAI' as const, baseUrl: 'https://up', model };
}

function build(cap: number, opts: Parameters<typeof makeCredits>[1] = {}) {
  const prisma = {
    llmCallLog: {
      create: vi.fn(async () => ({ id: 'log1' })),
      update: vi.fn(async () => ({})),
    },
  };
  const credits = makeCredits(cap, opts);
  const pricing = {
    lookupPrice: vi.fn(async () => ({ unit: 'PER_TOKEN_OUTPUT', pricePerUnit: 1000 })),
    computeCredits: vi.fn(() => 0),
  };
  const router = {
    selectCandidates: vi.fn(async () => [] as ReturnType<typeof makeRouterCandidate>[]),
    decryptUpstreamKey: vi.fn(async () => ({ id: 'ch1', name: 'c1', kind: 'CHAT', tier: 'FAST', protocol: 'OPENAI', baseUrl: 'https://up', upstreamKey: 'sk-x' })),
  };
  // @ts-expect-error mock 不实现完整接口，仅测用到的方法。
  const svc = new RelayService(prisma, pricing, credits, router);
  return { svc, prisma, credits, pricing, router };
}

function makeReq() {
  return {
    relayAuth: { teamId: 't1', userId: 'u1', apiKeyId: 'k1', scopes: ['chat', 'image'] },
    header: vi.fn(() => undefined),
    query: {},
    headers: {},
  } as never;
}

function makeRes(headersSent = false) {
  return { headersSent } as never;
}

const chatBody = { model: 'fast', messages: [{ role: 'user', content: 'hi' }], stream: false };

describe('RelayService.executeRelay 计费时机（R3：未成功对话不净扣费）', () => {
  beforeEach(() => {
    forwardOpenAiChat.mockReset();
  });

  it('场景1 余额不足（cap>0）：reserve 抛 402；reconcile/refund 均不调用；净变化=0', async () => {
    const { svc, credits } = build(200, { reserveThrows: true });
    const req = makeReq();
    const res = makeRes(false);
    await expect(svc.chatCompletions(req, res, { ...chatBody })).rejects.toMatchObject({ status: 402 });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(credits.refund).not.toHaveBeenCalled();
    expect(credits.__net()).toBe(0);
  });

  it('场景2 无渠道（cap>0）：refund 恰 1 次；reconcile 不调用；净变化=0；抛 503 no_channel_available', async () => {
    const { svc, credits, router } = build(200);
    router.selectCandidates.mockResolvedValueOnce([]);
    await expect(svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody }))
      .rejects.toMatchObject({ status: 503, code: 'no_channel_available' });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledTimes(1);
    expect(credits.__net()).toBe(0);
  });

  it('场景3 全候选无定价（cap>0）：refund 恰 1 次；reconcile 不调用；净变化=0；抛 503 pricing_not_configured', async () => {
    const { svc, credits, router, pricing } = build(200);
    router.selectCandidates.mockResolvedValueOnce([makeRouterCandidate('m1'), makeRouterCandidate('m2')]);
    pricing.lookupPrice.mockResolvedValue(null); // 所有候选都无定价
    await expect(svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody }))
      .rejects.toMatchObject({ status: 503, code: 'pricing_not_configured' });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledTimes(1);
    expect(credits.__net()).toBe(0);
  });

  it('场景4 非流式上游全失败（cap>0）：故障转移耗尽 → refund 恰 1 次；reconcile 不调用；净变化=0；抛 502', async () => {
    const { svc, credits, router } = build(200);
    router.selectCandidates.mockResolvedValueOnce([makeRouterCandidate('m1'), makeRouterCandidate('m2')]);
    forwardOpenAiChat.mockRejectedValue(new UpstreamError(502, '上游 502'));
    await expect(svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody }))
      .rejects.toMatchObject({ status: 502, code: 'upstream_llm_error' });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledTimes(1);
    expect(forwardOpenAiChat).toHaveBeenCalledTimes(2); // 两候选都尝试（故障转移）
    expect(credits.__net()).toBe(0);
  });

  it('场景5 流式发头后断流（cap>0）：refund 恰 1 次；reconcile 不调用；净变化=0；不抛错（已发头）', async () => {
    const { svc, credits, router } = build(200);
    router.selectCandidates.mockResolvedValueOnce([makeRouterCandidate('m1'), makeRouterCandidate('m2')]);
    forwardOpenAiChat.mockRejectedValue(new UpstreamError(502, '流式中断'));
    const res = makeRes(true); // 已发头
    await expect(svc.chatCompletions(makeReq(), res, { ...chatBody, stream: true })).resolves.toBeUndefined();
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledTimes(1);
    expect(forwardOpenAiChat).toHaveBeenCalledTimes(1); // 流式发头后不再故障转移
    expect(credits.__net()).toBe(0);
  });

  it('场景6 成功（cap>0，real<cap）：reconcile 恰 1 次、charged=min(real,cap)；refund 不调用；净变化=-real', async () => {
    const { svc, credits, router, pricing } = build(200);
    router.selectCandidates.mockResolvedValueOnce([makeRouterCandidate('m1')]);
    forwardOpenAiChat.mockResolvedValueOnce({ inputTokens: 100, outputTokens: 50, images: 0 });
    pricing.computeCredits.mockReturnValueOnce(50); // real=50 < cap=200
    await expect(svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })).resolves.toBeUndefined();
    expect(credits.reconcile).toHaveBeenCalledTimes(1);
    expect(await credits.reconcile.mock.results[0].value).toBe(50);
    expect(credits.refund).not.toHaveBeenCalled();
    expect(credits.__net()).toBe(-50);
  });

  it('场景6b 成功（cap>0，real>cap）：charged 封顶 cap；净变化=-cap（用户保护）', async () => {
    const { svc, credits, router, pricing } = build(200);
    router.selectCandidates.mockResolvedValueOnce([makeRouterCandidate('m1')]);
    forwardOpenAiChat.mockResolvedValueOnce({ inputTokens: 100, outputTokens: 9999, images: 0 });
    pricing.computeCredits.mockReturnValueOnce(500); // real=500 > cap=200
    await expect(svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })).resolves.toBeUndefined();
    expect(credits.reconcile).toHaveBeenCalledTimes(1);
    expect(credits.refund).not.toHaveBeenCalled();
    expect(credits.__net()).toBe(-200); // 封顶 cap
  });

  it('场景6c developer role 归一化为 system：AI SDK v5 误把 system 转 developer，上游不认 → 转回 system', async () => {
    // 根因（修复「Bad Request: tokenization failed」）：AI SDK v5 对非 gpt-3/4/chatgpt-4o/gpt-5-chat
    // 开头的 modelId（灵坊用 fast/premium 哨兵）判为推理模型 → system 变 developer role。
    // Moonshot/Kimi 不认 developer → 400。relay 在转发前统一 developer→system。
    const { svc, router, pricing } = build(200);
    router.selectCandidates.mockResolvedValueOnce([makeRouterCandidate('m1')]);
    forwardOpenAiChat.mockResolvedValueOnce({ inputTokens: 10, outputTokens: 5, images: 0 });
    pricing.computeCredits.mockReturnValueOnce(5);
    const bodyWithDeveloper = {
      model: 'fast',
      messages: [
        { role: 'developer', content: '你是助手' }, // AI SDK v5 转换后的 role
        { role: 'user', content: 'hi' },
      ],
      stream: false,
    };
    await expect(svc.chatCompletions(makeReq(), makeRes(false), bodyWithDeveloper)).resolves.toBeUndefined();
    // 断言：转发给上游的 messages 里 developer 已被归一化为 system。
    const forwardedBody = forwardOpenAiChat.mock.calls[0][0].body;
    expect(forwardedBody.messages[0].role).toBe('system');
    expect(forwardedBody.messages[0].content).toBe('你是助手'); // 内容保留
    expect(forwardedBody.messages.some((m: { role: string }) => m.role === 'developer')).toBe(false);
  });

  it('场景7 成功（cap=0）：reconcile 条件扣款；refund 不调用；净变化=-real', async () => {
    const { svc, credits, router, pricing } = build(0);
    router.selectCandidates.mockResolvedValueOnce([makeRouterCandidate('m1')]);
    forwardOpenAiChat.mockResolvedValueOnce({ inputTokens: 100, outputTokens: 30, images: 0 });
    pricing.computeCredits.mockReturnValueOnce(30);
    await expect(svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })).resolves.toBeUndefined();
    expect(credits.reconcile).toHaveBeenCalledTimes(1);
    expect(credits.refund).not.toHaveBeenCalled();
    expect(credits.__net()).toBe(-30);
  });

  it('场景8 cap=0 上游失败：refund no-op；reconcile 不调用；净变化=0（本就未扣）', async () => {
    const { svc, credits, router } = build(0);
    router.selectCandidates.mockResolvedValueOnce([makeRouterCandidate('m1')]);
    forwardOpenAiChat.mockRejectedValue(new UpstreamError(502, '上游失败'));
    await expect(svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody }))
      .rejects.toMatchObject({ status: 502, code: 'upstream_llm_error' });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(credits.__net()).toBe(0); // cap=0 refund no-op，无净扣
  });
});
