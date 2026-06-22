// ChannelService + ChannelRouterService —— 上游渠道管理 + 请求路由（one-api 范式）。
//
// 设计（见 docs/billing-and-relay-design.md §4.3 步骤3 / §6.1）：
//  - Channel：一组上游凭据（baseUrl + 加密 key）+ 支持模型/版本 + 路由策略（priority/weight）。
//  - ChannelBinding：多对多，scope=GLOBAL/TEAM/ROLE。满足「单主体可配单/多渠道」。
//  - 路由（ChannelRouterService.select）：
//    候选 = status=ENABLED 且（ChannelBinding 命中 GLOBAL 或 (TEAM,teamId) 或 (ROLE, 用户角色)）
//           且（supportedModels 含 model 或 supportedTiers 含 tier）。
//    按 priority 升序排列返回（relay 逐个尝试，上游失败则故障转移到下一个）。
//    同 priority 内按 weight 加权随机选一个代表顺序（负载均衡）。
//  - 上游 key 复用 credential-cipher 加密；admin CRUD 时加密落库，路由时解密使用。
//  - 健康测试：用解密 key 探测 {baseUrl}/v1/models 连通性，写 lastHealthAt/lastHealthOk。
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AppError, badRequest } from '../common';
import { decryptApiKey, encryptApiKey, getLlmKey, maskApiKey } from '../crypto/credential-cipher';
import { LLM_PROVIDER } from './dto/enums';

/** relay 选中的渠道（含解密后的明文上游 key，仅转发时临时持有，绝不记日志）。 */
export interface RoutedChannel {
  id: string;
  name: string;
  protocol: 'OPENAI' | 'ANTHROPIC';
  baseUrl: string;
  upstreamKey: string; // 解密明文（转发用，调用方负责不外泄）
}

@Injectable()
export class ChannelService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 列表（admin 全字段，但上游 key 只回脱敏 hint）。 */
  async adminList() {
    const channels = await this.prisma.channel.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      include: { bindings: true },
    });
    return { channels: channels.map((c) => this.adminView(c, c.bindings)) };
  }

  /** 创建渠道（加密上游 key）。 */
  async adminCreate(actorId: string, input: ChannelUpsertInput) {
    this.validateProvider(input.provider);
    const key = getLlmKey();
    const channel = await this.prisma.channel.create({
      data: {
        name: input.name,
        protocol: input.protocol,
        provider: input.provider,
        baseUrl: this.normalizeUrl(input.baseUrl),
        encryptedUpstreamKey: encryptApiKey(input.upstreamKey, key),
        upstreamKeyHint: maskApiKey(input.upstreamKey),
        supportedModels: (input.supportedModels ?? []) as unknown as Prisma.InputJsonValue,
        supportedTiers: input.supportedTiers ?? [],
        status: input.status ?? 'ENABLED',
        priority: input.priority ?? 100,
        weight: input.weight ?? 1,
        description: input.description ?? '',
      },
    });
    await this.audit(actorId, 'admin.channel.created', channel.id, { name: channel.name, protocol: channel.protocol });
    return this.adminView(channel, []);
  }

  /** 更新渠道（upstreamKey 可选：undefined 保留原密，非空重新加密轮换）。 */
  async adminUpdate(actorId: string, id: string, input: ChannelUpsertInput) {
    this.validateProvider(input.provider);
    const existing = await this.prisma.channel.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'channel_not_found', '渠道不存在');
    const key = getLlmKey();
    const data: Prisma.ChannelUpdateInput = {
      name: input.name,
      protocol: input.protocol,
      provider: input.provider,
      baseUrl: this.normalizeUrl(input.baseUrl),
      supportedModels: (input.supportedModels ?? []) as unknown as Prisma.InputJsonValue,
      supportedTiers: input.supportedTiers ?? [],
      status: input.status ?? 'ENABLED',
      priority: input.priority ?? 100,
      weight: input.weight ?? 1,
      description: input.description ?? '',
    };
    if (input.upstreamKey) {
      data.encryptedUpstreamKey = encryptApiKey(input.upstreamKey, key);
      data.upstreamKeyHint = maskApiKey(input.upstreamKey);
    }
    const channel = await this.prisma.channel.update({ where: { id }, data });
    await this.audit(actorId, 'admin.channel.updated', channel.id, { name: channel.name });
    return this.adminView(channel, []);
  }

  /** 删除渠道（级联删 ChannelBinding，onCascade）。 */
  async adminDelete(actorId: string, id: string) {
    const existing = await this.prisma.channel.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!existing) throw new AppError(404, 'channel_not_found', '渠道不存在');
    await this.prisma.channel.delete({ where: { id } });
    await this.audit(actorId, 'admin.channel.deleted', id, { name: existing.name });
    return { ok: true };
  }

  /** 添加绑定。scopeKind=GLOBAL 时 scopeId 留空。 */
  async adminAddBinding(actorId: string, channelId: string, scopeKind: 'GLOBAL' | 'TEAM' | 'ROLE', scopeId: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, name: true } });
    if (!channel) throw new AppError(404, 'channel_not_found', '渠道不存在');
    const realScopeId = scopeKind === 'GLOBAL' ? '' : scopeId;
    if (scopeKind !== 'GLOBAL' && !realScopeId) throw badRequest('TEAM/ROLE 绑定必须提供 scopeId');
    try {
      const binding = await this.prisma.channelBinding.create({
        data: { channelId, scopeKind, scopeId: realScopeId },
      });
      await this.audit(actorId, 'admin.channel.binding_added', channelId, { scopeKind, scopeId: realScopeId, name: channel.name });
      return binding;
    } catch {
      throw new AppError(409, 'conflict', '该绑定已存在');
    }
  }

  /** 删除绑定。 */
  async adminRemoveBinding(actorId: string, bindingId: string) {
    const binding = await this.prisma.channelBinding.findUnique({ where: { id: bindingId } });
    if (!binding) throw new AppError(404, 'binding_not_found', '绑定不存在');
    await this.prisma.channelBinding.delete({ where: { id: bindingId } });
    await this.audit(actorId, 'admin.channel.binding_removed', binding.channelId, { scopeKind: binding.scopeKind, scopeId: binding.scopeId });
    return { ok: true };
  }

  /** 健康测试：解密 key 探测 {baseUrl}/v1/models，写 lastHealthAt/lastHealthOk。 */
  async adminTest(actorId: string, id: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new AppError(404, 'channel_not_found', '渠道不存在');
    const key = getLlmKey();
    const upstreamKey = decryptApiKey(channel.encryptedUpstreamKey, key);
    const url = `${this.normalizeUrl(channel.baseUrl)}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let ok = false;
    let message = '';
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${upstreamKey}` },
        signal: controller.signal,
      });
      ok = res.ok;
      message = ok ? '渠道连通正常' : `上游返回 ${res.status}`;
    } catch (e) {
      message = `探测失败：${(e as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
    await this.prisma.channel.update({
      where: { id },
      data: { lastHealthAt: new Date(), lastHealthOk: ok },
    });
    await this.audit(actorId, 'admin.channel.tested', id, { ok, name: channel.name });
    return { ok, message, lastHealthOk: ok };
  }

  // === 内部 ===

  private validateProvider(provider: string) {
    if (!LLM_PROVIDER.includes(provider as (typeof LLM_PROVIDER)[number])) {
      throw badRequest(`provider 不在白名单：${LLM_PROVIDER.join('/')}`);
    }
  }

  private normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private adminView(c: { id: string; name: string; protocol: string; provider: string; baseUrl: string; upstreamKeyHint: string; encryptedUpstreamKey: string; supportedModels: unknown; supportedTiers: string[]; status: string; priority: number; weight: number; description: string; lastHealthAt: Date | null; lastHealthOk: boolean | null; createdAt: Date; updatedAt: Date }, bindings: { id: string; scopeKind: string; scopeId: string }[]) {
    return {
      id: c.id,
      name: c.name,
      protocol: c.protocol as 'OPENAI' | 'ANTHROPIC',
      provider: c.provider,
      baseUrl: c.baseUrl,
      upstreamKeyHint: c.upstreamKeyHint,
      hasUpstreamKey: c.encryptedUpstreamKey.length > 0,
      supportedModels: (c.supportedModels as string[]) ?? [],
      supportedTiers: (c.supportedTiers as ('FAST' | 'PREMIUM')[]) ?? [],
      status: c.status as 'ENABLED' | 'DISABLED',
      priority: c.priority,
      weight: c.weight,
      description: c.description,
      lastHealthAt: c.lastHealthAt?.toISOString() ?? null,
      lastHealthOk: c.lastHealthOk,
      bindings: bindings.map((b) => ({ id: b.id, scopeKind: b.scopeKind, scopeId: b.scopeId })),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  private async audit(actorUserId: string, action: string, targetId: string, metadata: unknown) {
    await this.prisma.auditLog.create({
      data: { actorUserId, action, targetType: 'Channel', targetId, metadata: metadata as object },
    });
  }
}

export interface ChannelUpsertInput {
  name: string;
  protocol: 'OPENAI' | 'ANTHROPIC';
  provider: string;
  baseUrl: string;
  upstreamKey: string; // 明文（创建必填；更新时 undefined=保留原密）
  supportedModels?: string[];
  supportedTiers?: ('FAST' | 'PREMIUM')[];
  status?: 'ENABLED' | 'DISABLED';
  priority?: number;
  weight?: number;
  description?: string;
}

@Injectable()
export class ChannelRouterService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 选渠道候选列表（已按 priority 升序、同 priority 内 weight 加权随机）。
   * relay 逐个尝试，上游失败则故障转移到下一个。
   *
   * @param teamId  消费归属团队
   * @param userId  发起者（ROLE 范围解析用；平台 API Key 调用时为 null）
   * @param tier    前台版本
   * @param model   实际上游模型 id（chatModel/imageModel）
   */
  async selectCandidates(args: {
    teamId: string;
    userId: string | null;
    tier: 'FAST' | 'PREMIUM';
    model: string;
  }): Promise<{ id: string; name: string; protocol: 'OPENAI' | 'ANTHROPIC'; baseUrl: string; priority: number; weight: number }[]> {
    // 用户角色（ROLE 范围）：平台角色 + 团队角色。
    const roleIds: string[] = [];
    if (args.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: args.userId },
        select: { platformRoleId: true, memberships: { where: { status: 'ACTIVE' }, select: { teamRoleId: true } } },
      });
      if (user?.platformRoleId) roleIds.push(user.platformRoleId);
      for (const m of user?.memberships ?? []) if (m.teamRoleId) roleIds.push(m.teamRoleId);
    }
    // 命中的渠道 id：bindings 满足 GLOBAL 或 (TEAM, teamId) 或 (ROLE, roleId)。
    const teamId = args.teamId;
    const bindings = await this.prisma.channelBinding.findMany({
      where: {
        OR: [
          { scopeKind: 'GLOBAL' },
          { scopeKind: 'TEAM', scopeId: teamId },
          ...(roleIds.length ? [{ scopeKind: 'ROLE' as const, scopeId: { in: roleIds } }] : []),
        ],
      },
      select: { channelId: true },
      distinct: ['channelId'],
    });
    const channelIds = bindings.map((b) => b.channelId);
    if (channelIds.length === 0) return [];
    // 渠道：ENABLED + 支持该模型或该版本。
    const channels = await this.prisma.channel.findMany({
      where: {
        id: { in: channelIds },
        status: 'ENABLED',
        OR: [
          { supportedModels: { array_contains: args.model } },
          { supportedTiers: { has: args.tier } },
        ],
      },
      select: { id: true, name: true, protocol: true, baseUrl: true, priority: true, weight: true },
      orderBy: { priority: 'asc' },
    });
    // 同 priority 内按 weight 加权随机排序（负载均衡）。
    return this.weightedShuffleWithinPriority(channels);
  }

  /** 解密某渠道上游 key（relay 转发前调用，仅临时持有）。 */
  async decryptUpstreamKey(channelId: string): Promise<RoutedChannel> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new AppError(404, 'channel_not_found', '渠道不存在');
    const key = getLlmKey();
    return {
      id: channel.id,
      name: channel.name,
      protocol: channel.protocol as 'OPENAI' | 'ANTHROPIC',
      baseUrl: channel.baseUrl,
      upstreamKey: decryptApiKey(channel.encryptedUpstreamKey, key),
    };
  }

  /** 同 priority 分组内按 weight 加权随机打乱（weight 越大越靠前），跨组保持 priority 升序。 */
  private weightedShuffleWithinPriority<T extends { priority: number; weight: number }>(items: T[]): T[] {
    const byPrio = new Map<number, T[]>();
    for (const it of items) {
      const arr = byPrio.get(it.priority) ?? [];
      arr.push(it);
      byPrio.set(it.priority, arr);
    }
    const out: T[] = [];
    for (const prio of [...byPrio.keys()].sort((a, b) => a - b)) {
      out.push(...this.weightedSample(byPrio.get(prio)!));
    }
    return out;
  }

  private weightedSample<T extends { weight: number }>(arr: T[]): T[] {
    const remaining = [...arr];
    const ordered: T[] = [];
    while (remaining.length > 0) {
      const total = remaining.reduce((s, x) => s + Math.max(1, x.weight), 0);
      let r = Math.random() * total;
      let idx = 0;
      for (let i = 0; i < remaining.length; i++) {
        r -= Math.max(1, remaining[i].weight);
        if (r <= 0) { idx = i; break; }
      }
      ordered.push(remaining.splice(idx, 1)[0]);
    }
    return ordered;
  }
}
