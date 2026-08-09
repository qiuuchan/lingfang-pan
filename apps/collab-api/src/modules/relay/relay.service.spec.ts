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

import { RelayService, clientSourceFromRequest, injectMultipartModel } from './relay.service';
import * as forwarders from './forwarders';
import { UpstreamError } from './forwarders';

const forwardOpenAiChat = forwarders.forwardOpenAiChat as unknown as ReturnType<typeof vi.fn>;

/** AuthService 模拟：默认「无任何平台权限」；需要时按测试覆盖 ensurePermission / perms 集合。 */
function makeAuth() {
  return {
    ensurePermission: vi.fn(async () => ({ perms: new Set<string>() })),
  } as never;
}

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
      if (c > 0) {
        net -= c;
        reserved = true;
      }
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
      if (c > 0 && reserved) {
        net += c;
        reserved = false;
      }
    }),
    // 视频退款（退已实扣）：模拟「退回上次 reconcile 实扣额」，幂等。
    refundConsumed: vi.fn(async (_teamId: string, _callLogId: string, _actor: string | null) => {
      // 简化：返回一个固定退额供断言调用发生（真实幂等语义在 credit.service.spec 测）。
      return 0;
    }),
    __net: () => net,
  };
}

function makeRouterCandidate(model = 'gpt-x') {
  return {
    id: 'ch1',
    name: 'c1',
    kind: 'CHAT' as const,
    tier: 'FAST' as const,
    protocol: 'OPENAI' as const,
    baseUrl: 'https://up',
    model,
  };
}

function build(cap: number, opts: Parameters<typeof makeCredits>[1] = {}) {
  const prisma = {
    pool: {
      findMany: vi.fn(async () => []),
    },
    llmCallLog: {
      create: vi.fn(async (_args: unknown) => ({ id: 'log1' })),
      update: vi.fn(async (_args: unknown) => ({})),
    },
  };
  const credits = makeCredits(cap, opts);
  const pricing = {
    lookupPrice: vi.fn(async () => ({ unit: 'PER_TOKEN_OUTPUT', pricePerUnit: 1000 })),
    lookupMinContextWindow: vi.fn(async () => null),
    computeCredits: vi.fn(() => 0),
  };
  const router = {
    selectCandidates: vi.fn(async () => [] as ReturnType<typeof makeRouterCandidate>[]),
    decryptUpstreamKey: vi.fn(async () => ({
      id: 'ch1',
      name: 'c1',
      kind: 'CHAT',
      tier: 'FAST',
      protocol: 'OPENAI',
      baseUrl: 'https://up',
      upstreamKey: 'sk-x',
    })),
  };
  // @ts-expect-error mock 不实现完整接口，仅测用到的方法。
  const svc = new RelayService(prisma, pricing, credits, router, makeAuth());
  return { svc, prisma, credits, pricing, router };
}

function makeReq() {
  return {
    relayAuth: { teamId: 't1', userId: 'u1' },
    header: vi.fn(() => undefined),
    query: {},
    headers: {},
  } as never;
}

function makeRes(headersSent = false) {
  return { headersSent } as never;
}

const chatBody = { model: 'fast', messages: [{ role: 'user', content: 'hi' }], stream: false };

describe('relay client source telemetry', () => {
  it.each([
    ['desktop-plugin', 'plugin_runtime'],
    ['desktop-plugin-test', 'plugin_test'],
    ['unknown', 'platform'],
    [undefined, 'platform'],
  ])('maps %s to %s without changing auth', (header, expected) => {
    const req = { header: vi.fn(() => header) } as never;
    expect(clientSourceFromRequest(req)).toBe(expected);
  });
});

describe('RelayService.executeRelay 计费时机（R3：未成功对话不净扣费）', () => {
  beforeEach(() => {
    forwardOpenAiChat.mockReset();
  });

  it('省略 model 默认使用 fast，并记录平台来源且不写 apiKeyId', async () => {
    const { svc, prisma, router } = build(0);
    router.selectCandidates.mockResolvedValueOnce([]);
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), {
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).rejects.toMatchObject({ code: 'no_channel_available' });
    expect(router.selectCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'FAST', teamId: 't1' })
    );
    const data = prisma.llmCallLog.create.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({ teamId: 't1', userId: 'u1', clientSource: 'platform' });
    expect(data).not.toHaveProperty('apiKeyId');
  });

  it('未知 model 返回稳定 unsupported_model 且不创建计费日志', async () => {
    const { svc, prisma } = build(0);
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), {
        model: 'gpt-real-name',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).rejects.toMatchObject({ status: 400, code: 'unsupported_model' });
    expect(prisma.llmCallLog.create).not.toHaveBeenCalled();
  });

  it('models 只返回当前团队资源池实际启用的聊天档位', async () => {
    const { svc, prisma, pricing } = build(0);
    prisma.pool.findMany.mockResolvedValue([
      {
        id: 'pool-fast',
        name: 'Fast',
        scope: 'SHARED',
        teamId: null,
        channels: [{ tier: 'FAST' }],
      },
    ]);
    pricing.lookupMinContextWindow.mockResolvedValueOnce(8192).mockResolvedValueOnce(null);
    const result = await svc.listModels(makeReq());
    expect(result.data.map((model) => model.id)).toEqual(['fast']);
    expect(result.data[0]).toMatchObject({
      contextWindow: 8192,
      resourcePools: [{ id: 'pool-fast' }],
    });
  });

  it('场景1 余额不足（cap>0）：reserve 抛 402；reconcile/refund 均不调用；净变化=0', async () => {
    const { svc, credits } = build(200, { reserveThrows: true });
    const req = makeReq();
    const res = makeRes(false);
    await expect(svc.chatCompletions(req, res, { ...chatBody })).rejects.toMatchObject({
      status: 402,
    });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(credits.refund).not.toHaveBeenCalled();
    expect(credits.__net()).toBe(0);
  });

  it('场景2 无渠道（cap>0）：refund 恰 1 次；reconcile 不调用；净变化=0；抛 503 no_channel_available', async () => {
    const { svc, credits, router } = build(200);
    router.selectCandidates.mockResolvedValueOnce([]);
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })
    ).rejects.toMatchObject({ status: 503, code: 'no_channel_available' });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledTimes(1);
    expect(credits.__net()).toBe(0);
  });

  it('场景3 全候选无定价（cap>0）：refund 恰 1 次；reconcile 不调用；净变化=0；抛 503 pricing_not_configured', async () => {
    const { svc, credits, router, pricing } = build(200);
    router.selectCandidates.mockResolvedValueOnce([
      makeRouterCandidate('m1'),
      makeRouterCandidate('m2'),
    ]);
    pricing.lookupPrice.mockResolvedValue(null); // 所有候选都无定价
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })
    ).rejects.toMatchObject({
      status: 503,
      code: 'pricing_not_configured',
      message: '当前模型版本暂不可用，请联系平台管理员配置定价',
    });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledTimes(1);
    expect(credits.__net()).toBe(0);
  });

  it('场景4 非流式上游全失败（cap>0）：故障转移耗尽 → refund 恰 1 次；reconcile 不调用；净变化=0；抛 502', async () => {
    const { svc, credits, router } = build(200);
    router.selectCandidates.mockResolvedValueOnce([
      makeRouterCandidate('m1'),
      makeRouterCandidate('m2'),
    ]);
    forwardOpenAiChat.mockRejectedValue(new UpstreamError(502, '上游 502'));
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })
    ).rejects.toMatchObject({ status: 502, code: 'upstream_llm_error' });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledTimes(1);
    expect(forwardOpenAiChat).toHaveBeenCalledTimes(2); // 两候选都尝试（故障转移）
    expect(credits.__net()).toBe(0);
  });

  it('场景5 流式发头后断流（cap>0）：refund 恰 1 次；reconcile 不调用；净变化=0；不抛错（已发头）', async () => {
    const { svc, credits, router } = build(200);
    router.selectCandidates.mockResolvedValueOnce([
      makeRouterCandidate('m1'),
      makeRouterCandidate('m2'),
    ]);
    forwardOpenAiChat.mockRejectedValue(new UpstreamError(502, '流式中断'));
    const res = makeRes(true); // 已发头
    await expect(
      svc.chatCompletions(makeReq(), res, { ...chatBody, stream: true })
    ).resolves.toBeUndefined();
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
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })
    ).resolves.toBeUndefined();
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
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })
    ).resolves.toBeUndefined();
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
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), bodyWithDeveloper)
    ).resolves.toBeUndefined();
    // 断言：转发给上游的 messages 里 developer 已被归一化为 system。
    const forwardedBody = forwardOpenAiChat.mock.calls[0][0].body;
    expect(forwardedBody.messages[0].role).toBe('system');
    expect(forwardedBody.messages[0].content).toBe('你是助手'); // 内容保留
    expect(forwardedBody.messages.some((m: { role: string }) => m.role === 'developer')).toBe(
      false
    );
  });

  it('场景7 成功（cap=0）：reconcile 条件扣款；refund 不调用；净变化=-real', async () => {
    const { svc, credits, router, pricing } = build(0);
    router.selectCandidates.mockResolvedValueOnce([makeRouterCandidate('m1')]);
    forwardOpenAiChat.mockResolvedValueOnce({ inputTokens: 100, outputTokens: 30, images: 0 });
    pricing.computeCredits.mockReturnValueOnce(30);
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })
    ).resolves.toBeUndefined();
    expect(credits.reconcile).toHaveBeenCalledTimes(1);
    expect(credits.refund).not.toHaveBeenCalled();
    expect(credits.__net()).toBe(-30);
  });

  it('场景8 cap=0 上游失败：refund no-op；reconcile 不调用；净变化=0（本就未扣）', async () => {
    const { svc, credits, router } = build(0);
    router.selectCandidates.mockResolvedValueOnce([makeRouterCandidate('m1')]);
    forwardOpenAiChat.mockRejectedValue(new UpstreamError(502, '上游失败'));
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })
    ).rejects.toMatchObject({ status: 502, code: 'upstream_llm_error' });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(credits.__net()).toBe(0); // cap=0 refund no-op，无净扣
  });
});

describe('RelayService 输入预检（超 contextWindow 返回 413 input_too_long，不触达上游/不计费）', () => {
  beforeEach(() => {
    forwardOpenAiChat.mockReset();
  });

  it('输入 token 超 window：返回 413 input_too_long，不预扣灵石/不建日志/不转发', async () => {
    const { svc, prisma, credits, pricing, router } = build(200);
    // 候选窗口设为很小（100 token），输入远超。
    pricing.lookupMinContextWindow.mockResolvedValueOnce(100);
    const bigContent = 'x'.repeat(10_000); // 约 2500 token
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), {
        model: 'fast',
        messages: [{ role: 'user', content: bigContent }],
        stream: false,
      })
    ).rejects.toMatchObject({
      status: 413,
      code: 'input_too_long',
      details: { contextWindow: 100 },
    });
    // 关键：预检在 executeRelay 之前，不消耗任何计费/日志/渠道资源。
    expect(prisma.llmCallLog.create).not.toHaveBeenCalled();
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(router.selectCandidates).not.toHaveBeenCalled();
    expect(forwardOpenAiChat).not.toHaveBeenCalled();
  });

  it('输入未超 window：正常进入转发流程（不拦截）', async () => {
    const { svc, pricing, router } = build(0);
    pricing.lookupMinContextWindow.mockResolvedValueOnce(1_000_000); // 大窗口
    router.selectCandidates.mockResolvedValueOnce([]); // 无渠道，走到正常失败路径
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })
    ).rejects.toMatchObject({ code: 'no_channel_available' });
    // 走到了选渠道步骤，说明预检放行。
    expect(router.selectCandidates).toHaveBeenCalled();
  });

  it('window 未配置（null）：跳过预检，不阻断正常调用', async () => {
    const { svc, pricing, router } = build(0);
    pricing.lookupMinContextWindow.mockResolvedValueOnce(null);
    router.selectCandidates.mockResolvedValueOnce([]);
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })
    ).rejects.toMatchObject({ code: 'no_channel_available' });
    expect(router.selectCandidates).toHaveBeenCalled();
  });

  it('Anthropic /messages 协议：system + messages 合计超 window 同样返回 413', async () => {
    const { svc, credits, pricing, router } = build(200);
    pricing.lookupMinContextWindow.mockResolvedValueOnce(100);
    const bigSystem = 's'.repeat(10_000);
    await expect(
      svc.messages(makeReq(), makeRes(false), {
        model: 'fast',
        system: bigSystem,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })
    ).rejects.toMatchObject({ status: 413, code: 'input_too_long' });
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(router.selectCandidates).not.toHaveBeenCalled();
  });
});

describe('injectMultipartModel', () => {
  /** 构造一个最小 multipart（无 model 字段），形状与桥 route_image_edit 输出一致。 */
  function buildBody(
    boundary: string,
    fields: Array<[name: string, value: string]>,
    file?: Buffer
  ) {
    const parts: Buffer[] = [];
    for (const [name, value] of fields) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: text/plain\r\n\r\n${value}\r\n`
        )
      );
    }
    if (file) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
        )
      );
      parts.push(file);
      parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(parts);
  }

  it('在闭合分隔符前注入上游 model 字段，保留原有字段与文件字节', () => {
    const boundary = 'b1';
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const fileBytes = Buffer.from('PNGDATA');
    const body = buildBody(boundary, [['prompt', '换装']], fileBytes);
    const out = injectMultipartModel(contentType, body, 'dall-e-3');
    const text = out.body.toString('utf8');
    expect(out.contentType).toBe(contentType);
    expect(text).toContain('name="prompt"');
    expect(text).toContain('换装');
    expect(text).toContain('PNGDATA'); // 文件字节未损坏
    expect(text).toContain('name="model"');
    expect(text).toContain('dall-e-3');
    // model 注入在闭合分隔符之前，闭合仍位于末尾。
    const modelIdx = text.indexOf('name="model"');
    const closeIdx = text.lastIndexOf(`--${boundary}--`);
    expect(closeIdx).toBeGreaterThan(modelIdx);
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
    // 仅注入一次 model。
    expect(text.match(/name="model"/g)?.length).toBe(1);
  });

  it('body 已含 model 字段时不重复注入（直连客户端自带的 model 优先）', () => {
    const boundary = 'b2';
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const body = buildBody(boundary, [
      ['prompt', 'x'],
      ['model', 'gpt-x'],
    ]);
    const out = injectMultipartModel(contentType, body, 'dall-e-3');
    expect(out.body.equals(body)).toBe(true);
    expect(out.body.toString('utf8').match(/name="model"/g)?.length).toBe(1);
  });

  it('非 multipart（无 boundary）原样返回', () => {
    const body = Buffer.from('{"prompt":"x"}');
    const out = injectMultipartModel('application/json', body, 'dall-e-3');
    expect(out.body.equals(body)).toBe(true);
  });

  it('model 含 CRLF 时被剥离，防止 multipart 头注入', () => {
    const boundary = 'b3';
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const body = buildBody(boundary, [['prompt', 'x']]);
    const out = injectMultipartModel(contentType, body, 'evil\r\nX-Inject: 1');
    const text = out.body.toString('utf8');
    // CRLF 被剥离 → "X-Inject" 不会出现在新行首伪造头，而是合入 model 值单行。
    expect(text).not.toContain('\r\nX-Inject');
    expect(text).toContain('evil');
  });
});

// === 视频生成按秒计费（PER_SECOND，精简编排，不接渠道路由） ===

/** 构造视频专用 RelayService：pricing 返回 PER_SECOND 单价 0.5；credits 模拟 reserve→reconcile 净扣。 */
function buildVideo(
  seconds: number,
  opts: { reserveThrows?: boolean; rbflowStatus?: number; rbflowBody?: unknown } = {}
) {
  const pricePerUnit = 0.5;
  const expectedCredits = pricePerUnit * Math.max(1, Math.ceil(seconds)); // 与 computeCredits 语义一致
  const prisma = {
    llmCallLog: {
      create: vi.fn(async () => ({ id: 'vlog1' })),
      update: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => ({ id: 'vlog1', status: 'client_error', credits: expectedCredits })),
    },
    // forwardToRbflow 读 RBFLow 配置（rbflowUrl/rbflowApiKey）。空 rbflowUrl=未配置。
    platformSetting: {
      findMany: vi.fn(async () =>
        opts.rbflowStatus === undefined && opts.rbflowBody === undefined
          ? [] // 默认：未配置（用于测试转发失败/未配置分支）
          : [
              { key: 'rbflowUrl', value: 'http://rbflow.test:41792' },
              { key: 'rbflowApiKey', value: 'test-key' },
            ]
      ),
      // readVideoMaxSeconds / bridgeRbflowConfig 读单键（readVideoMaxSeconds：缺失→默认 300）。
      findUnique: vi.fn(async () => null),
    },
  } as never;
  const credits = makeCredits(expectedCredits, { reserveThrows: opts.reserveThrows });
  const pricing = {
    lookupPrice: vi.fn(async () => ({ unit: 'PER_SECOND', pricePerUnit })),
    lookupMinContextWindow: vi.fn(async () => null),
    // 用真实 computeCredits 逻辑（与 production 一致）而非固定 0。
    computeCredits: vi.fn(
      (_unit: string, ppu: number, usage: { seconds?: number }) =>
        ppu * Math.max(1, Math.ceil(usage.seconds ?? 0))
    ),
  } as never;
  const router = {
    selectCandidates: vi.fn(async () => []),
    decryptUpstreamKey: vi.fn(async () => ({})),
  } as never;
  // @ts-expect-error mock 不实现完整接口。
  const svc = new RelayService(prisma, pricing, credits, router, makeAuth());
  return { svc, prisma, credits, pricing, expectedCredits };
}

/** Mock globalThis.fetch 拦截 RBFLow 转发（不发真实网络）。rbflowBody 给 undefined 则模拟 fetch 抛错。 */
function mockRbflowFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => {
    if (status === -1) throw new Error('network down');
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as globalThis.Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('RelayService.videoGenerations 按秒计费 + RBFLow 转发', () => {
  it('成功按秒扣费 + 转发 RBFLow：返回 task_id，reserve+reconcile 各一次，不退款', async () => {
    mockRbflowFetch(200, { task_id: 'rh-task-1' });
    const { svc, credits, pricing, expectedCredits } = buildVideo(30, {
      rbflowStatus: 200,
      rbflowBody: { task_id: 'rh-task-1' },
    });
    const out = await svc.videoGenerations(makeReq(), {
      model: 'fast',
      seconds: 30,
      image: 'aGk=',
      video: 'Ymo=',
    });
    expect(out).toMatchObject({
      charged: true,
      credits: expectedCredits,
      seconds: 30,
      task_id: 'rh-task-1',
    });
    expect(pricing.lookupPrice).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'video', model: 'video_generate' })
    );
    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(credits.reconcile).toHaveBeenCalledTimes(1);
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('小数秒数向上取整：45.2 秒 → 46 秒，扣 0.5×46=23 灵石', async () => {
    mockRbflowFetch(200, { task_id: 'rh-2' });
    const { svc, expectedCredits } = buildVideo(45.2, {
      rbflowStatus: 200,
      rbflowBody: { task_id: 'rh-2' },
    });
    const out = await svc.videoGenerations(makeReq(), {
      model: 'fast',
      seconds: 45.2,
      image: 'aGk=',
      video: 'Ymo=',
    });
    expect(out.seconds).toBe(46);
    expect(out.credits).toBe(expectedCredits);
  });

  it('0 秒 clamp 到 1 秒（防白嫖）', async () => {
    mockRbflowFetch(200, { task_id: 'rh-3' });
    const { svc } = buildVideo(0, { rbflowStatus: 200, rbflowBody: { task_id: 'rh-3' } });
    const out = await svc.videoGenerations(makeReq(), {
      model: 'fast',
      seconds: 0,
      image: 'aGk=',
      video: 'Ymo=',
    });
    expect(out.seconds).toBe(1);
  });

  it('余额不足（reserve 抛 402）：finalize status=insufficient_balance，不调 reconcile/不转发', async () => {
    const fetchMock = mockRbflowFetch(200, { task_id: 'should-not-reach' });
    const { svc, credits, prisma } = buildVideo(60, { reserveThrows: true });
    await expect(
      svc.videoGenerations(makeReq(), { model: 'fast', seconds: 60 })
    ).rejects.toMatchObject({ code: 'insufficient_balance' });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled(); // 余额不足不转发
    const updateData = prisma.llmCallLog.update.mock.calls[0]?.[0]?.data;
    expect(updateData).toMatchObject({
      status: 'insufficient_balance',
      errorCode: 'insufficient_balance',
    });
  });

  it('无定价抛 503 no_pricing 且不建计费日志', async () => {
    const prisma = {
      llmCallLog: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
      platformSetting: {
        findMany: vi.fn(),
        findUnique: vi.fn(async () => null), // readVideoMaxSeconds
      },
    } as never;
    const credits = makeCredits(10);
    const pricing = {
      lookupPrice: vi.fn(async () => null),
      lookupMinContextWindow: vi.fn(async () => null),
      computeCredits: vi.fn(),
    } as never;
    const router = { selectCandidates: vi.fn(), decryptUpstreamKey: vi.fn() } as never;
    // @ts-expect-error mock
    const svc = new RelayService(prisma, pricing, credits, router, makeAuth());
    await expect(
      svc.videoGenerations(makeReq(), { model: 'fast', seconds: 10 })
    ).rejects.toMatchObject({ status: 503, code: 'no_pricing' });
    expect(prisma.llmCallLog.create).not.toHaveBeenCalled();
  });

  it('LlmCallLog 记 capability=video + requestSummary 含 seconds（审计）', async () => {
    mockRbflowFetch(200, { task_id: 'rh-4' });
    const { svc, prisma } = buildVideo(20, { rbflowStatus: 200, rbflowBody: { task_id: 'rh-4' } });
    await svc.videoGenerations(makeReq(), {
      model: 'premium',
      seconds: 20,
      image: 'aGk=',
      video: 'Ymo=',
    });
    const data = prisma.llmCallLog.create.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({ capability: 'video', tier: 'PREMIUM', model: 'video_generate' });
    expect(data.requestSummary).toMatchObject({ seconds: 20, tier: 'PREMIUM' });
  });

  it('RBFLow 未配置（rbflowUrl 空）→ 退款 + 503 rbflow_not_configured', async () => {
    const { svc, credits } = buildVideo(10); // 默认 rbflowStatus=undefined → platformSetting 返空（未配置）
    await expect(
      svc.videoGenerations(makeReq(), { model: 'fast', seconds: 10, image: 'aGk=', video: 'Ymo=' })
    ).rejects.toMatchObject({ status: 503, code: 'rbflow_not_configured' });
    expect(credits.refundConsumed).toHaveBeenCalledTimes(1); // 转发失败必退款
  });

  it('RBFLow 转发失败（网络/非 2xx）→ 退款 + 502 rbflow_forward_failed', async () => {
    mockRbflowFetch(-1, null); // fetch 抛错
    const { svc, credits } = buildVideo(10, { rbflowStatus: 200, rbflowBody: { task_id: 'x' } });
    await expect(
      svc.videoGenerations(makeReq(), { model: 'fast', seconds: 10, image: 'aGk=', video: 'Ymo=' })
    ).rejects.toMatchObject({ status: 502, code: 'rbflow_forward_failed' });
    expect(credits.refundConsumed).toHaveBeenCalledTimes(1);
  });
});

describe('RelayService.bridgeRbflowConfig 桥接凭证通道（H-3）', () => {
  it('携带正确 X-Bridge-Token → 返回 rbflow 配置（url + api_key）', async () => {
    const { svc, prisma } = buildVideo(10, { rbflowStatus: 200, rbflowBody: {} });
    prisma.platformSetting.findUnique.mockResolvedValue({ value: 'secret-bridge-token' });
    const out = await svc.bridgeRbflowConfig({
      relayAuth: { teamId: 't1', userId: 'u1' },
      header: (name: string) => (name === 'x-bridge-token' ? 'secret-bridge-token' : undefined),
    } as never);
    expect(out).toMatchObject({ url: 'http://rbflow.test:41792', api_key: 'test-key' });
  });

  it('缺少 X-Bridge-Token → 400 bad_request', async () => {
    const { svc } = buildVideo(10, { rbflowStatus: 200, rbflowBody: {} });
    await expect(
      svc.bridgeRbflowConfig({ relayAuth: { teamId: 't1', userId: 'u1' }, header: () => undefined } as never)
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('令牌不匹配/未配置 → 403 bridge_token_invalid', async () => {
    const { svc } = buildVideo(10, { rbflowStatus: 200, rbflowBody: {} });
    // 未配置（findUnique 返 null）→ 403
    await expect(
      svc.bridgeRbflowConfig({
        relayAuth: { teamId: 't1', userId: 'u1' },
        header: () => 'wrong',
      } as never)
    ).rejects.toMatchObject({ status: 403, code: 'bridge_token_invalid' });
  });
});

describe('RelayService.refundVideo 视频退款', () => {
  it('凭 call_log_id 调 refundConsumed 退款，finalize status=refunded', async () => {
    const { svc, credits, prisma } = buildVideo(10);
    credits.refundConsumed.mockResolvedValueOnce(5);
    const out = await svc.refundVideo(makeReq(), { call_log_id: 'vlog1' });
    expect(out).toMatchObject({ refunded: true, credits: 5, call_log_id: 'vlog1' });
    expect(credits.refundConsumed).toHaveBeenCalledTimes(1);
    expect(prisma.llmCallLog.update).toHaveBeenCalled();
  });

  it('缺 call_log_id → 400 bad_request', async () => {
    const { svc } = buildVideo(10);
    await expect(svc.refundVideo(makeReq(), {})).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    });
  });

  it('call_log 不属于当前团队 → 404 not_found', async () => {
    const { svc, prisma } = buildVideo(10);
    prisma.llmCallLog.findFirst.mockResolvedValueOnce(null);
    await expect(svc.refundVideo(makeReq(), { call_log_id: 'other' })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('已退过（refundConsumed 返回 0）不重复 finalize', async () => {
    const { svc, credits, prisma } = buildVideo(10);
    credits.refundConsumed.mockResolvedValueOnce(0);
    const out = await svc.refundVideo(makeReq(), { call_log_id: 'vlog1' });
    expect(out.refunded).toBe(false);
    expect(prisma.llmCallLog.update).not.toHaveBeenCalled();
  });

  it('H-2 门禁：status=success 已成功交付 → 409 refund_rejected，不退款', async () => {
    const { svc, prisma, credits } = buildVideo(10);
    prisma.llmCallLog.findFirst.mockResolvedValueOnce({
      id: 'vlog1',
      status: 'success',
      credits: 5,
    });
    await expect(svc.refundVideo(makeReq(), { call_log_id: 'vlog1' })).rejects.toMatchObject({
      status: 409,
      code: 'refund_rejected',
    });
    expect(credits.refundConsumed).not.toHaveBeenCalled();
    expect(prisma.llmCallLog.update).not.toHaveBeenCalled();
  });
});

// === 声音克隆按输出秒数计费（PER_SECOND，秒数由 relay 从 prompt_text 估算） ===

/** 与 relay.service estimateVoiceSeconds 同一公式（4 字/秒，向上取整，≥1）。 */
function estSeconds(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

/** 构造音频专用 RelayService：pricing 返回 PER_SECOND 单价 0.5；秒数由 prompt_text 估算。 */
function buildAudio(
  promptText: string,
  opts: { reserveThrows?: boolean; rbflowStatus?: number; rbflowBody?: unknown } = {}
) {
  const pricePerUnit = 0.5;
  const seconds = estSeconds(promptText);
  const expectedCredits = pricePerUnit * Math.max(1, Math.ceil(seconds));
  const prisma = {
    llmCallLog: {
      create: vi.fn(async () => ({ id: 'alog1' })),
      update: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => ({ id: 'alog1', status: 'client_error', credits: expectedCredits })),
    },
    platformSetting: {
      findMany: vi.fn(async () =>
        opts.rbflowStatus === undefined && opts.rbflowBody === undefined
          ? [] // 默认：未配置
          : [
              { key: 'rbflowUrl', value: 'http://rbflow.test:41792' },
              { key: 'rbflowApiKey', value: 'test-key' },
            ]
      ),
      findUnique: vi.fn(async () => null), // readVideoMaxSeconds / bridgeRbflowConfig
    },
  } as never;
  const credits = makeCredits(expectedCredits, { reserveThrows: opts.reserveThrows });
  const pricing = {
    lookupPrice: vi.fn(async () => ({ unit: 'PER_SECOND', pricePerUnit })),
    lookupMinContextWindow: vi.fn(async () => null),
    computeCredits: vi.fn(
      (_unit: string, ppu: number, usage: { seconds?: number }) =>
        ppu * Math.max(1, Math.ceil(usage.seconds ?? 0))
    ),
  } as never;
  const router = {
    selectCandidates: vi.fn(async () => []),
    decryptUpstreamKey: vi.fn(async () => ({})),
  } as never;
  // @ts-expect-error mock 不实现完整接口。
  const svc = new RelayService(prisma, pricing, credits, router, makeAuth());
  return { svc, prisma, credits, pricing, expectedCredits, seconds };
}

describe('RelayService.audioGenerations 按输出秒数计费 + RBFLow /tasks/voice 转发', () => {
  it('成功按估算秒数扣费 + 转发：返回 task_id，reserve+reconcile 各一次，不退款', async () => {
    mockRbflowFetch(200, { task_id: 'voice-task-1' });
    const text = '你好世界'.repeat(10); // 40 字 → 10 秒
    const { svc, credits, pricing, expectedCredits, seconds } = buildAudio(text, {
      rbflowStatus: 200,
      rbflowBody: { task_id: 'voice-task-1' },
    });
    const out = await svc.audioGenerations(makeReq(), {
      model: 'fast',
      audio: 'aGk=',
      prompt_text: text,
    });
    expect(out).toMatchObject({
      charged: true,
      credits: expectedCredits,
      seconds,
      task_id: 'voice-task-1',
    });
    expect(pricing.lookupPrice).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'audio', model: 'voice_clone' })
    );
    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(credits.reconcile).toHaveBeenCalledTimes(1);
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('秒数由文本长度估算：40 字 → 10 秒，扣 0.5×10=5 灵石', async () => {
    mockRbflowFetch(200, { task_id: 'v2' });
    const text = '字'.repeat(40);
    const { svc, expectedCredits } = buildAudio(text, {
      rbflowStatus: 200,
      rbflowBody: { task_id: 'v2' },
    });
    const out = await svc.audioGenerations(makeReq(), {
      model: 'fast',
      audio: 'aGk=',
      prompt_text: text,
    });
    expect(out.seconds).toBe(10);
    expect(out.credits).toBe(expectedCredits);
  });

  it('短文本 clamp 到 1 秒（防白嫖）：3 字 → 1 秒', async () => {
    mockRbflowFetch(200, { task_id: 'v3' });
    const { svc } = buildAudio('你好吗', { rbflowStatus: 200, rbflowBody: { task_id: 'v3' } });
    const out = await svc.audioGenerations(makeReq(), {
      model: 'fast',
      audio: 'aGk=',
      prompt_text: '你好吗',
    });
    expect(out.seconds).toBe(1);
  });

  it('空 prompt_text → 400 bad_request，不建计费日志', async () => {
    const { svc, prisma } = buildAudio('   ');
    await expect(
      svc.audioGenerations(makeReq(), { model: 'fast', audio: 'aGk=', prompt_text: '   ' })
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    expect(prisma.llmCallLog.create).not.toHaveBeenCalled();
  });

  it('余额不足（reserve 抛 402）：finalize insufficient_balance，不调 reconcile/不转发', async () => {
    const fetchMock = mockRbflowFetch(200, { task_id: 'should-not-reach' });
    const text = '字'.repeat(20);
    const { svc, credits, prisma } = buildAudio(text, { reserveThrows: true });
    await expect(
      svc.audioGenerations(makeReq(), { model: 'fast', audio: 'aGk=', prompt_text: text })
    ).rejects.toMatchObject({ code: 'insufficient_balance' });
    expect(credits.reconcile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const updateData = prisma.llmCallLog.update.mock.calls[0]?.[0]?.data;
    expect(updateData).toMatchObject({
      status: 'insufficient_balance',
      errorCode: 'insufficient_balance',
    });
  });

  it('无定价抛 503 no_pricing 且不建计费日志', async () => {
    const prisma = {
      llmCallLog: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
      platformSetting: { findMany: vi.fn() },
    } as never;
    const credits = makeCredits(10);
    const pricing = {
      lookupPrice: vi.fn(async () => null),
      lookupMinContextWindow: vi.fn(async () => null),
      computeCredits: vi.fn(),
    } as never;
    const router = { selectCandidates: vi.fn(), decryptUpstreamKey: vi.fn() } as never;
    // @ts-expect-error mock
    const svc = new RelayService(prisma, pricing, credits, router, makeAuth());
    await expect(
      svc.audioGenerations(makeReq(), { model: 'fast', audio: 'aGk=', prompt_text: '你好' })
    ).rejects.toMatchObject({ status: 503, code: 'no_pricing' });
    expect(prisma.llmCallLog.create).not.toHaveBeenCalled();
  });

  it('LlmCallLog 记 capability=audio + requestSummary 含 seconds/chars（审计）', async () => {
    mockRbflowFetch(200, { task_id: 'v4' });
    const text = '字'.repeat(20);
    const { svc, prisma } = buildAudio(text, { rbflowStatus: 200, rbflowBody: { task_id: 'v4' } });
    await svc.audioGenerations(makeReq(), { model: 'premium', audio: 'aGk=', prompt_text: text });
    const data = prisma.llmCallLog.create.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({ capability: 'audio', tier: 'PREMIUM', model: 'voice_clone' });
    expect(data.requestSummary).toMatchObject({ seconds: 5, chars: 20, tier: 'PREMIUM' });
  });

  it('RBFLow 未配置（rbflowUrl 空）→ 退款 + 503 rbflow_not_configured', async () => {
    const { svc, credits } = buildAudio('字'.repeat(10)); // 默认未配置
    await expect(
      svc.audioGenerations(makeReq(), {
        model: 'fast',
        audio: 'aGk=',
        prompt_text: '字'.repeat(10),
      })
    ).rejects.toMatchObject({ status: 503, code: 'rbflow_not_configured' });
    expect(credits.refundConsumed).toHaveBeenCalledTimes(1);
  });

  it('RBFLow 转发失败（网络/非 2xx）→ 退款 + 502 rbflow_forward_failed', async () => {
    mockRbflowFetch(-1, null); // fetch 抛错
    const text = '字'.repeat(10);
    const { svc, credits } = buildAudio(text, { rbflowStatus: 200, rbflowBody: { task_id: 'x' } });
    await expect(
      svc.audioGenerations(makeReq(), { model: 'fast', audio: 'aGk=', prompt_text: text })
    ).rejects.toMatchObject({ status: 502, code: 'rbflow_forward_failed' });
    expect(credits.refundConsumed).toHaveBeenCalledTimes(1);
  });
});

describe('RelayService.refundAudio 音频退款', () => {
  it('凭 call_log_id 调 refundConsumed 退款，finalize status=refunded', async () => {
    const { svc, credits, prisma } = buildAudio('字'.repeat(10));
    credits.refundConsumed.mockResolvedValueOnce(5);
    const out = await svc.refundAudio(makeReq(), { call_log_id: 'alog1' });
    expect(out).toMatchObject({ refunded: true, credits: 5, call_log_id: 'alog1' });
    expect(credits.refundConsumed).toHaveBeenCalledTimes(1);
    expect(prisma.llmCallLog.update).toHaveBeenCalled();
  });

  it('缺 call_log_id → 400 bad_request', async () => {
    const { svc } = buildAudio('字'.repeat(10));
    await expect(svc.refundAudio(makeReq(), {})).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    });
  });

  it('call_log 不属于当前团队 → 404 not_found', async () => {
    const { svc, prisma } = buildAudio('字'.repeat(10));
    prisma.llmCallLog.findFirst.mockResolvedValueOnce(null);
    await expect(svc.refundAudio(makeReq(), { call_log_id: 'other' })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('H-2 门禁：status=success 已成功交付 → 409 refund_rejected，不退款', async () => {
    const { svc, prisma, credits } = buildAudio('字'.repeat(10));
    prisma.llmCallLog.findFirst.mockResolvedValueOnce({
      id: 'alog1',
      status: 'success',
      credits: 5,
    });
    await expect(svc.refundAudio(makeReq(), { call_log_id: 'alog1' })).rejects.toMatchObject({
      status: 409,
      code: 'refund_rejected',
    });
    expect(credits.refundConsumed).not.toHaveBeenCalled();
    expect(prisma.llmCallLog.update).not.toHaveBeenCalled();
  });
});
