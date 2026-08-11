// P0-9 审核钩子端到端单测（经真实 RelayService.chatCompletions 非流式路径）。
//
// 验证工单强制的反向用例在「服务真实调用路径」成立：
//  - 开关 ON + 供应商抛错/超时 → 输出被拒（422 content_moderation_rejected），且不故障转移到其它渠道；
//  - 开关 ON + 命中敏感词       → 输出被拒 + 审计记录（auditLog.create 落 admin.llm.content_intercepted）；
//  - 开关 ON + 供应商判安全     → 正常返回（不拦截）；
//  - 开关 OFF                   → 不审核，正常返回（回归：默认行为不破坏）。
import { describe, expect, it, vi, beforeEach } from 'vitest';

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
import type { ModerationProvider } from './ai-moderation';

const forwardOpenAiChat = forwarders.forwardOpenAiChat as unknown as ReturnType<typeof vi.fn>;

function makeAuth() {
  return { ensurePermission: vi.fn(async () => ({ perms: new Set<string>() })) } as never;
}
function makeCredits(cap: number) {
  let net = 0;
  return {
    readReserveCap: vi.fn(async () => cap),
    readAiUsageGuardRule: vi.fn(async () => null),
    reserve: vi.fn(async () => cap),
    reconcile: vi.fn(async (_t: string, _c: number, real: number) => real),
    refund: vi.fn(async () => {
      net += 0;
    }),
    refundConsumed: vi.fn(async () => 0),
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

/** 构造：prisma 支持 platformSetting.findUnique（读开关）+ auditLog.create（落审计）。 */
function build(cap: number, opts: { moderationEnabled?: boolean } = {}) {
  const prisma = {
    pool: { findMany: vi.fn(async () => []) },
    llmCallLog: {
      create: vi.fn(async () => ({ id: 'log1' })),
      update: vi.fn(async () => ({})),
    },
    platformSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        if (where.key === 'aiModerationEnabled') {
          return { value: opts.moderationEnabled ? 'true' : 'false' };
        }
        return null;
      }),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit1' })) },
  };
  const credits = makeCredits(cap);
  const pricing = {
    lookupPrice: vi.fn(async () => ({ unit: 'PER_TOKEN_OUTPUT', pricePerUnit: 100000 })),
    lookupMinContextWindow: vi.fn(async () => null),
    computeCredits: vi.fn(() => 0),
  };
  const router = {
    selectCandidates: vi.fn(async () => [makeRouterCandidate()]),
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
  // @ts-expect-error mock 不实现完整接口
  const svc: RelayService = new RelayService(prisma, pricing, credits, router, makeAuth());
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
  // 非流式成功：forwardOpenAiChat mock 会把 res 当作响应对象但本测试不依赖其写入。
  return {
    headersSent,
    status: vi.fn(() => ({ json: vi.fn() })),
    json: vi.fn(),
  } as never;
}

const chatBody = { model: 'fast', messages: [{ role: 'user', content: 'hi' }], stream: false };

describe('RelayService 审核钩子（P0-9 非流式路径）', () => {
  beforeEach(() => {
    forwardOpenAiChat.mockReset();
  });

  it('开关 OFF：不审核，正常返回且不写审计', async () => {
    const { svc, prisma } = build(0, { moderationEnabled: false });
    forwardOpenAiChat.mockResolvedValueOnce({
      inputTokens: 1,
      outputTokens: 2,
      images: 0,
      text: '正常回复',
    });
    const res = makeRes(false);
    const out = await svc.chatCompletions(makeReq(), res, { ...chatBody });
    expect(out).toBeUndefined(); // 非流式直接写 res，无返回值对象
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('反向用例 开关 ON + 供应商抛错/超时：输出被拒 422，且不故障转移（只调一次 forward）', async () => {
    const { svc, prisma, router } = build(0, { moderationEnabled: true });
    const provider: ModerationProvider = {
      judge: vi.fn(async () => {
        throw new Error('upstream timeout');
      }),
    };
    (svc as unknown as { moderationProvider: ModerationProvider | null }).moderationProvider =
      provider;
    forwardOpenAiChat.mockResolvedValueOnce({
      inputTokens: 1,
      outputTokens: 2,
      images: 0,
      text: '某段输出',
    });
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })
    ).rejects.toMatchObject({ status: 422, code: 'content_moderation_rejected' });
    // 不故障转移：只 forward 一次（被审核拒绝后直接终止候选循环）。
    expect(forwardOpenAiChat).toHaveBeenCalledTimes(1);
    // 审计记录存在（供应商不可用也留痕）。
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'admin.llm.content_intercepted' }),
      })
    );
  });

  it('反向用例 开关 ON + 命中敏感词：输出被拒 422 + 审计记录存在', async () => {
    const { svc, prisma } = build(0, { moderationEnabled: true });
    const provider: ModerationProvider = {
      judge: vi.fn(async () => ({ flagged: true, categories: ['violence'] })),
    };
    (svc as unknown as { moderationProvider: ModerationProvider | null }).moderationProvider =
      provider;
    forwardOpenAiChat.mockResolvedValueOnce({
      inputTokens: 1,
      outputTokens: 2,
      images: 0,
      text: '违禁内容',
    });
    await expect(
      svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody })
    ).rejects.toMatchObject({ status: 422, code: 'content_moderation_rejected' });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'admin.llm.content_intercepted',
          metadata: expect.objectContaining({ reason: 'sensitive_content' }),
        }),
      })
    );
  });

  it('正向用例 开关 ON + 供应商判安全：正常返回，不写审计', async () => {
    const { svc, prisma } = build(0, { moderationEnabled: true });
    const provider: ModerationProvider = {
      judge: vi.fn(async () => ({ flagged: false })),
    };
    (svc as unknown as { moderationProvider: ModerationProvider | null }).moderationProvider =
      provider;
    forwardOpenAiChat.mockResolvedValueOnce({
      inputTokens: 1,
      outputTokens: 2,
      images: 0,
      text: '正常的插件创建建议',
    });
    await svc.chatCompletions(makeReq(), makeRes(false), { ...chatBody });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
