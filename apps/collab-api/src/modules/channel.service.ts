// channel.service.ts —— 资源池（Pool）+ 渠道（Channel）管理 + 路由（资源池模型重构后）。
//
// 设计（见 docs/billing-and-relay-design.md，2026-06-23 资源池重构）：
//  - Pool：渠道的访问范围容器。scope=SHARED 全团队共享 / DEDICATED 绑定单团队。
//  - Channel：归属一个 Pool，有 kind（CHAT/IMAGE）+ tier（FAST/PREMIUM）+ models[]（多个，轮询）。
//  - 路由：团队 T 的调用 → 可用池（SHARED ∪ DEDICATED-to-T）→ 匹配 kind+tier 的渠道 →
//          「渠道 × 模型」笛卡尔积轮询（round-robin 起点随机），上游失败故障转移到下一候选。
//  - 旧 ChannelBinding（多对多 scope）/ ModelTierConfig / supportedTiers / priority / weight 全部移除。
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AppError, badRequest } from '../common';
import { decryptApiKey, encryptApiKey, getLlmKey, maskApiKey } from '../crypto/credential-cipher';
import { LLM_PROVIDER } from './dto/enums';

/** relay 选中的渠道（含解密后的明文上游 key + 本次要用的 model）。 */
export interface RoutedChannel {
  id: string;
  name: string;
  kind: 'CHAT' | 'IMAGE';
  tier: 'FAST' | 'PREMIUM';
  protocol: 'OPENAI' | 'ANTHROPIC';
  baseUrl: string;
  upstreamKey: string;
  model: string;
}

@Injectable()
export class PoolService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async adminList() {
    const pools = await this.prisma.pool.findMany({
      orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { channels: true } } },
    });
    return {
      pools: pools.map((p) => ({
        id: p.id,
        name: p.name,
        scope: p.scope,
        teamId: p.teamId,
        description: p.description,
        channelCount: p._count.channels,
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  async adminCreate(actorId: string, input: { name: string; scope: 'SHARED' | 'DEDICATED'; teamId?: string; description?: string }) {
    if (!input.name.trim()) throw badRequest('池名称不能为空');
    if (input.scope === 'DEDICATED') {
      if (!input.teamId?.trim()) throw badRequest('DEDICATED 池必须指定团队');
      const team = await this.prisma.team.findUnique({ where: { id: input.teamId }, select: { id: true, name: true } });
      if (!team) throw badRequest('指定团队不存在');
    }
    try {
      const pool = await this.prisma.pool.create({
        data: {
          name: input.name.trim(),
          scope: input.scope,
          teamId: input.scope === 'DEDICATED' ? input.teamId : null,
          description: input.description ?? '',
        },
      });
      await this.audit(actorId, 'admin.pool.created', pool.id, { name: pool.name, scope: pool.scope, teamId: pool.teamId });
      return { pool };
    } catch {
      throw new AppError(409, 'conflict', '池名称已存在');
    }
  }

  async adminUpdate(actorId: string, id: string, input: { name?: string; description?: string }) {
    const existing = await this.prisma.pool.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'pool_not_found', '资源池不存在');
    const data: Prisma.PoolUpdateInput = {};
    if (input.name !== undefined) {
      if (!input.name.trim()) throw badRequest('池名称不能为空');
      data.name = input.name.trim();
    }
    if (input.description !== undefined) data.description = input.description;
    const pool = await this.prisma.pool.update({ where: { id }, data });
    await this.audit(actorId, 'admin.pool.updated', pool.id, { name: pool.name });
    return { pool };
  }

  async adminDelete(actorId: string, id: string) {
    const existing = await this.prisma.pool.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!existing) throw new AppError(404, 'pool_not_found', '资源池不存在');
    await this.prisma.pool.delete({ where: { id } });
    await this.audit(actorId, 'admin.pool.deleted', id, { name: existing.name });
    return { ok: true };
  }

  private async audit(actorUserId: string, action: string, targetId: string, metadata: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType: 'Pool', targetId, metadata: metadata as object } });
  }
}

export interface ChannelUpsertInput {
  name: string;
  kind: 'CHAT' | 'IMAGE';
  tier: 'FAST' | 'PREMIUM';
  protocol: 'OPENAI' | 'ANTHROPIC';
  provider: string;
  poolId: string;
  baseUrl: string;
  upstreamKey: string;
  models?: string[];
  status?: 'ENABLED' | 'DISABLED';
  description?: string;
}

@Injectable()
export class ChannelService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async adminList(kind?: 'CHAT' | 'IMAGE') {
    const where = kind ? { kind } : undefined;
    const channels = await this.prisma.channel.findMany({
      where,
      orderBy: [{ kind: 'asc' }, { tier: 'asc' }, { createdAt: 'asc' }],
      include: { pool: { select: { id: true, name: true, scope: true, teamId: true } } },
    });
    return { channels: channels.map((c) => this.adminView(c)) };
  }

  async adminCreate(actorId: string, input: ChannelUpsertInput) {
    this.validate(input);
    const key = getLlmKey();
    const channel = await this.prisma.channel.create({
      data: {
        name: input.name,
        kind: input.kind,
        tier: input.tier,
        protocol: input.protocol,
        provider: input.provider,
        poolId: input.poolId,
        baseUrl: this.normalizeUrl(input.baseUrl),
        encryptedUpstreamKey: encryptApiKey(input.upstreamKey, key),
        upstreamKeyHint: maskApiKey(input.upstreamKey),
        models: (input.models ?? []) as unknown as Prisma.InputJsonValue,
        status: input.status ?? 'ENABLED',
        description: input.description ?? '',
      },
    });
    await this.audit(actorId, 'admin.channel.created', channel.id, { name: channel.name, kind: channel.kind, tier: channel.tier });
    return { channel: this.adminView(channel) };
  }

  async adminUpdate(actorId: string, id: string, input: ChannelUpsertInput) {
    this.validate(input);
    const existing = await this.prisma.channel.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'channel_not_found', '渠道不存在');
    const key = getLlmKey();
    const data: Prisma.ChannelUpdateInput = {
      name: input.name,
      kind: input.kind,
      tier: input.tier,
      protocol: input.protocol,
      provider: input.provider,
      pool: { connect: { id: input.poolId } },
      baseUrl: this.normalizeUrl(input.baseUrl),
      models: (input.models ?? []) as unknown as Prisma.InputJsonValue,
      status: input.status ?? 'ENABLED',
      description: input.description ?? '',
    };
    if (input.upstreamKey) {
      data.encryptedUpstreamKey = encryptApiKey(input.upstreamKey, key);
      data.upstreamKeyHint = maskApiKey(input.upstreamKey);
    }
    const channel = await this.prisma.channel.update({ where: { id }, data });
    await this.audit(actorId, 'admin.channel.updated', channel.id, { name: channel.name });
    return { channel: this.adminView(channel) };
  }

  async adminDelete(actorId: string, id: string) {
    const existing = await this.prisma.channel.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!existing) throw new AppError(404, 'channel_not_found', '渠道不存在');
    await this.prisma.channel.delete({ where: { id } });
    await this.audit(actorId, 'admin.channel.deleted', id, { name: existing.name });
    return { ok: true };
  }

  /** 健康测试（连通性）：协议感知探测 models 端点，返回可用模型列表。 */
  async adminTest(actorId: string, id: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new AppError(404, 'channel_not_found', '渠道不存在');
    const upstreamKey = decryptApiKey(channel.encryptedUpstreamKey, getLlmKey());
    const url = channel.protocol === 'ANTHROPIC'
      ? `${this.normalizeUrl(channel.baseUrl)}/v1/models`
      : `${this.normalizeUrl(channel.baseUrl)}/models`;
    const headers: Record<string, string> = channel.protocol === 'ANTHROPIC'
      ? { 'x-api-key': upstreamKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${upstreamKey}` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let ok = false;
    let message = '';
    let models: string[] = [];
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      ok = res.ok;
      if (ok) {
        const data = (await res.json()) as { data?: { id?: string }[] };
        models = (data.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
        message = `连通正常，${models.length} 个可用模型`;
      } else {
        message = `上游返回 ${res.status}${res.status === 401 || res.status === 403 ? '（key 无效或无权限）' : ''}`;
      }
    } catch (e) {
      message = `探测失败：${(e as Error).name === 'AbortError' ? '超时' : (e as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
    await this.prisma.channel.update({ where: { id }, data: { lastHealthAt: new Date(), lastHealthOk: ok } });
    await this.audit(actorId, 'admin.channel.tested', id, { ok, name: channel.name });
    return { ok, message, models, lastHealthOk: ok };
  }

  /** 实对话测试（端到端）：仅 CHAT 渠道。 */
  async adminTestChat(actorId: string, id: string, model: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new AppError(404, 'channel_not_found', '渠道不存在');
    if (channel.kind !== 'CHAT') return { ok: false, message: '仅聊天渠道支持对话测试', reply: '', latencyMs: 0 };
    if (!model.trim()) throw badRequest('请选择测试用模型');
    const upstreamKey = decryptApiKey(channel.encryptedUpstreamKey, getLlmKey());
    const base = this.normalizeUrl(channel.baseUrl);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let ok = false;
    let message = '';
    let reply = '';
    try {
      if (channel.protocol === 'ANTHROPIC') {
        const res = await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': upstreamKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
          signal: controller.signal,
        });
        ok = res.ok;
        if (ok) { const data = (await res.json()) as { content?: { text?: string }[] }; reply = data.content?.map((c) => c.text).filter(Boolean).join('') || '(空回复)'; message = '测试对话成功'; }
        else message = `上游返回 ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`;
      } else {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstreamKey}` },
          body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
          signal: controller.signal,
        });
        ok = res.ok;
        if (ok) { const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }; reply = data.choices?.[0]?.message?.content || '(空回复)'; message = '测试对话成功'; }
        else message = `上游返回 ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`;
      }
    } catch (e) {
      message = `测试失败：${(e as Error).name === 'AbortError' ? '超时（30s）' : (e as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
    await this.audit(actorId, 'admin.channel.test_chat', id, { ok, model, name: channel.name });
    return { ok, message, reply, latencyMs: Date.now() - started };
  }

  /** 生图测试（端到端）：仅 IMAGE 渠道（OpenAI 协议）。 */
  async adminTestImage(actorId: string, id: string, model: string, prompt?: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new AppError(404, 'channel_not_found', '渠道不存在');
    if (channel.kind !== 'IMAGE') return { ok: false, message: '仅生图渠道支持生图测试', imageUrl: null, latencyMs: 0 };
    if (channel.protocol === 'ANTHROPIC') return { ok: false, message: 'Anthropic 协议不支持生图', imageUrl: null, latencyMs: 0 };
    if (!model.trim()) throw badRequest('请选择生图模型');
    const upstreamKey = decryptApiKey(channel.encryptedUpstreamKey, getLlmKey());
    const base = this.normalizeUrl(channel.baseUrl);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let ok = false;
    let message = '';
    let imageUrl: string | null = null;
    try {
      const res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstreamKey}` },
        body: JSON.stringify({ model, prompt: prompt?.trim() || 'a red circle on white background', n: 1 }),
        signal: controller.signal,
      });
      ok = res.ok;
      if (ok) {
        const data = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
        const first = data.data?.[0];
        if (first?.url) imageUrl = first.url;
        else if (first?.b64_json) imageUrl = `data:image/png;base64,${first.b64_json}`;
        message = imageUrl ? '生图成功' : '上游返回成功但无图片数据';
        ok = Boolean(imageUrl);
      } else message = `上游返回 ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`;
    } catch (e) {
      message = `生图失败：${(e as Error).name === 'AbortError' ? '超时（60s）' : (e as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
    await this.audit(actorId, 'admin.channel.test_image', id, { ok, model, name: channel.name });
    return { ok, message, imageUrl, latencyMs: Date.now() - started };
  }

  // === 内部 ===

  private validate(input: ChannelUpsertInput) {
    if (!LLM_PROVIDER.includes(input.provider as (typeof LLM_PROVIDER)[number])) {
      throw badRequest(`provider 不在白名单：${LLM_PROVIDER.join('/')}`);
    }
    // IMAGE 渠道仅支持 OPENAI 协议（Anthropic 无原生生图 API）。
    if (input.kind === 'IMAGE' && input.protocol === 'ANTHROPIC') {
      throw badRequest('生图渠道仅支持 OpenAI 协议');
    }
  }

  private normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private adminView(c: {
    id: string; name: string; kind: string; tier: string; protocol: string; provider: string;
    poolId: string; baseUrl: string; upstreamKeyHint: string; encryptedUpstreamKey: string;
    models: unknown; status: string; description: string; lastHealthAt: Date | null; lastHealthOk: boolean | null;
    createdAt: Date; updatedAt: Date; pool?: { id: string; name: string; scope: string; teamId: string | null };
  }) {
    return {
      id: c.id,
      name: c.name,
      kind: c.kind as 'CHAT' | 'IMAGE',
      tier: c.tier as 'FAST' | 'PREMIUM',
      protocol: c.protocol as 'OPENAI' | 'ANTHROPIC',
      provider: c.provider,
      poolId: c.poolId,
      pool: c.pool ? { id: c.pool.id, name: c.pool.name, scope: c.pool.scope, teamId: c.pool.teamId } : null,
      baseUrl: c.baseUrl,
      upstreamKeyHint: c.upstreamKeyHint,
      hasUpstreamKey: c.encryptedUpstreamKey.length > 0,
      models: (c.models as string[]) ?? [],
      status: c.status as 'ENABLED' | 'DISABLED',
      description: c.description,
      lastHealthAt: c.lastHealthAt?.toISOString() ?? null,
      lastHealthOk: c.lastHealthOk,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  private async audit(actorUserId: string, action: string, targetId: string, metadata: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType: 'Channel', targetId, metadata: metadata as object } });
  }
}

@Injectable()
export class ChannelRouterService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 选渠道+模型候选（round-robin 起点随机，故障转移顺序）。
   * 算法：
   *  1. 团队 T 可用池 = scope=SHARED ∪ scope=DEDICATED 且 teamId=T。
   *  2. 这些池中 kind + tier 匹配 + status=ENABLED 的渠道。
   *  3. 每个渠道 × 其 models[] 笛卡尔积 → 候选列表（{channel, model}）。
   *  4. 起点随机 + 顺序排列（round-robin），relay 逐个尝试，失败故障转移。
   */
  async selectCandidates(args: {
    teamId: string;
    kind: 'CHAT' | 'IMAGE';
    tier: 'FAST' | 'PREMIUM';
  }): Promise<{ id: string; name: string; kind: 'CHAT' | 'IMAGE'; tier: 'FAST' | 'PREMIUM'; protocol: 'OPENAI' | 'ANTHROPIC'; baseUrl: string; model: string }[]> {
    // 1. 可用池 id。
    const pools = await this.prisma.pool.findMany({
      where: { OR: [{ scope: 'SHARED' }, { scope: 'DEDICATED', teamId: args.teamId }] },
      select: { id: true },
    });
    const poolIds = pools.map((p) => p.id);
    if (poolIds.length === 0) return [];

    // 2. 匹配渠道。
    const channels = await this.prisma.channel.findMany({
      where: { poolId: { in: poolIds }, kind: args.kind, tier: args.tier, status: 'ENABLED' },
      select: { id: true, name: true, kind: true, tier: true, protocol: true, baseUrl: true, models: true },
    });
    if (channels.length === 0) return [];

    // 3. 渠道 × models 笛卡尔积。
    const candidates: { id: string; name: string; kind: 'CHAT' | 'IMAGE'; tier: 'FAST' | 'PREMIUM'; protocol: 'OPENAI' | 'ANTHROPIC'; baseUrl: string; model: string }[] = [];
    for (const c of channels) {
      const models = (c.models as string[]) ?? [];
      for (const model of models.length ? models : ['']) {
        candidates.push({ id: c.id, name: c.name, kind: c.kind as 'CHAT' | 'IMAGE', tier: c.tier as 'FAST' | 'PREMIUM', protocol: c.protocol as 'OPENAI' | 'ANTHROPIC', baseUrl: c.baseUrl, model });
      }
    }

    // 4. round-robin：起点随机，其余按序（故障转移）。
    if (candidates.length <= 1) return candidates;
    const start = Math.floor(Math.random() * candidates.length);
    return [...candidates.slice(start), ...candidates.slice(0, start)];
  }

  /** 解密某渠道上游 key（relay 转发前调用）。 */
  async decryptUpstreamKey(channelId: string): Promise<{ id: string; name: string; kind: 'CHAT' | 'IMAGE'; tier: 'FAST' | 'PREMIUM'; protocol: 'OPENAI' | 'ANTHROPIC'; baseUrl: string; upstreamKey: string }> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new AppError(404, 'channel_not_found', '渠道不存在');
    const key = getLlmKey();
    return {
      id: channel.id,
      name: channel.name,
      kind: channel.kind as 'CHAT' | 'IMAGE',
      tier: channel.tier as 'FAST' | 'PREMIUM',
      protocol: channel.protocol as 'OPENAI' | 'ANTHROPIC',
      baseUrl: channel.baseUrl,
      upstreamKey: decryptApiKey(channel.encryptedUpstreamKey, key),
    };
  }
}
